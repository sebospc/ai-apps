"""Deterministic rules: a registry plus the built-ins.

Adding a rule is one function in this package, declaring the rule_ids its findings carry:

    @rule("my-rule", emits=("my-rule",))
    def my_rule(ctx: RuleContext) -> list[Finding]:
        ...

Registered rules run on every review, in registration order, and their findings are scoped to the
diff and deduped by the caller. A rule must be pure: it gets the diff, the added-line map and the
file contents the plugin sent, and returns findings. No I/O, no network, no clock.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from fnmatch import fnmatch
from typing import NamedTuple

from smith.reviewer.domain.diff import iter_hunk_lines
from smith.reviewer.domain.models import Check, Finding, RuleContext, Severity

logger = logging.getLogger(__name__)

Rule = Callable[[RuleContext], list[Finding]]
_REGISTRY: dict[str, Rule] = {}
_EMITTED: dict[str, tuple[str, ...]] = {}


def rule(rule_id: str, emits: tuple[str, ...] = ()) -> Callable[[Rule], Rule]:
    """Register a rule under `rule_id`, declaring the ids its findings carry.

    The registry key and the `rule_id` on a finding are not the same thing — `properties-hygiene`
    reports `properties-hardcoded-secret` and `properties-duplicate-key`, and `yaml-checks` reports
    whatever the ruleset declares. `emits` is what makes that answerable by a machine, which is how
    `tests/test_fixtures.py` proves every id a review can produce has a fixture behind it. Leave it
    empty when the ids come from the ruleset rather than from this file.
    """

    def register(fn: Rule) -> Rule:
        if rule_id in _REGISTRY:
            raise ValueError(f"duplicate rule id: {rule_id}")
        _REGISTRY[rule_id] = fn
        _EMITTED[rule_id] = emits
        return fn

    return register


def registered_rules() -> dict[str, Rule]:
    return dict(_REGISTRY)


def emitted_rule_ids() -> dict[str, tuple[str, ...]]:
    """Registry key → the rule_ids its findings carry."""
    return dict(_EMITTED)


def run_rules(ctx: RuleContext, disabled: set[str]) -> list[Finding]:
    findings: list[Finding] = []
    for rule_id, fn in _REGISTRY.items():
        if rule_id in disabled:
            continue
        try:
            findings.extend(fn(ctx))
        except Exception:  # a broken rule must never fail the whole review
            logger.exception("rule %s raised, skipped", rule_id)
    return findings


# --------------------------------------------------------------------------------------------------
# built-in: YAML-declared regex checks
# --------------------------------------------------------------------------------------------------


@rule("yaml-checks")
def yaml_checks(ctx: RuleContext) -> list[Finding]:
    return run_checks(ctx, ctx.checks)


def run_checks(ctx: RuleContext, checks: list[Check]) -> list[Finding]:
    findings: list[Finding] = []
    for check in checks:
        regex = _compile(check.pattern, check.id)
        if regex is None:
            continue
        context_re = _compile(check.context_pattern, check.id) if check.context_pattern else None
        if check.context_pattern and context_re is None:
            continue
        exclude_re = (
            _compile(check.exclude_line_pattern, check.id) if check.exclude_line_pattern else None
        )
        if check.exclude_line_pattern and exclude_re is None:
            continue  # a filter that does not compile would let through exactly what it excludes

        for diff in ctx.diffs:
            if not fnmatch(diff.path, check.file_pattern):
                continue
            if check.exclude_file_pattern and fnmatch(diff.path, check.exclude_file_pattern):
                continue

            lines = [pair for h in diff.hunks for pair in iter_hunk_lines(h, check.match_on)]
            texts = [t for _, t in lines]
            for idx, (line_no, text) in enumerate(lines):
                if not regex.search(text):
                    continue
                if exclude_re is not None and exclude_re.search(text):
                    continue
                if context_re is not None:
                    window = texts[max(0, idx - check.context_window) : idx + check.context_window + 1]
                    if not any(context_re.search(t) for t in window):
                        continue
                findings.append(
                    Finding(
                        file=diff.path,
                        line=line_no,
                        severity=check.severity,
                        rule_id=check.rule_id or check.id,
                        message=check.message,
                        source="rules",
                        issue_type=check.issue_type,
                        suggestion=check.suggestion,
                        quoted_line=text.strip(),
                    )
                )
    return findings


def _compile(pattern: str | None, check_id: str) -> re.Pattern[str] | None:
    if not pattern:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        logger.warning("invalid regex in check %s, skipped", check_id)
        return None


# --------------------------------------------------------------------------------------------------
# built-in: .properties hygiene
# --------------------------------------------------------------------------------------------------

_SECRET_KEY_RE = re.compile(r"(password|passwd|secret|token|apikey|api\.key|private\.key|credential)", re.I)
# A value that names the setting instead of holding it. `your_shared_secret` is what an untouched
# sample config looks like, and a rule that calls it a committed credential spends the credibility
# every other security finding needs.
_PLACEHOLDER_RE = re.compile(r"^(\$\{.*\}|<.*>|your[_.-]?\w*|changeme|xxx+|\*+|todo|)$", re.I)

# `YPACKAGE_TOKEN=yaddonpackage` in an extension's `extgen.properties`: a SCREAMING_SNAKE `*_TOKEN`
# key holding one bare word is the extension generator's find-and-replace pair, so `TOKEN` there
# names the placeholder and not an auth token. That single file was half of this rule's findings
# over a real corpus. The value shape is part of the test on purpose — a `*_TOKEN` key holding
# something that is not a plain word is exactly the credential this rule exists for.
_SUBSTITUTION_TOKEN_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]*_TOKEN$")
_BARE_WORD_RE = re.compile(r"^[A-Za-z]+$")

# The key names what the value is *about*; only the value can be a credential. Deciding on the key
# alone made this 118 findings over a real corpus, 116 of them UI labels out of message bundles
# (`text.account.profile.setPassword=Set Password`), every one of them blocking. These are the
# shapes that corpus proved a committed credential never has.
_NOT_A_CREDENTIAL_RE = re.compile(r"^(?:\w+://.*|[\d.,]+|true|false)$", re.I)
# `Password`, `Token`, `Weak`, `Generated` are labels. A credential worth committing is longer, and
# the recall this costs is a password of nine characters, which is a different finding.
_CREDENTIAL_MIN_LENGTH = 10


def _is_credential_value(value: str) -> bool:
    """A committed credential is one opaque token — never a sentence, a URL, a number or a word."""
    if len(value) < _CREDENTIAL_MIN_LENGTH or any(character.isspace() for character in value):
        return False
    return not _PLACEHOLDER_RE.match(value) and not _NOT_A_CREDENTIAL_RE.match(value)


def _is_substitution_token(key: str, value: str) -> bool:
    """A code generator's find-and-replace pair, which reads as a credential and is not one."""
    return bool(_SUBSTITUTION_TOKEN_KEY_RE.match(key) and _BARE_WORD_RE.match(value))


@rule("properties-hygiene", emits=("properties-hardcoded-secret", "properties-duplicate-key"))
def properties_hygiene(ctx: RuleContext) -> list[Finding]:
    """Two checks a regex alone cannot do: duplicate keys and hardcoded secrets.

    Duplicate keys are the dangerous one — Java's Properties loader keeps the LAST value silently,
    so a re-declared key means the setting a developer is reading is not the one in effect.

    An empty value used to be a third check. It was measured at 44% of every finding this ruleset
    produced over a real codebase, because `foo.bar=` is how SAP Commerce blanks an inherited
    default on purpose, and nothing in the file distinguishes that from a forgotten value.
    """
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".properties") or diff.status == "deleted":
            continue
        added = ctx.added.get(diff.path, set())
        content = ctx.files.get(diff.path)

        if content is not None:
            findings.extend(_duplicate_keys(diff.path, content, added))

        for hunk in diff.hunks:
            for line_no, text in iter_hunk_lines(hunk, "added"):
                key, sep, value = text.partition("=")
                if not sep or text.lstrip().startswith(("#", "!")):
                    continue
                key, value = key.strip(), value.strip()
                if not _SECRET_KEY_RE.search(key) or _is_substitution_token(key, value):
                    continue
                # A fake credential in test resources is the point of test resources.
                if _is_credential_value(value) and not _is_test_path(diff.path):
                    findings.append(
                        Finding(
                            file=diff.path,
                            line=line_no,
                            severity="critical",
                            rule_id="properties-hardcoded-secret",
                            message=f"`{key}` has a hardcoded value, and this file is committed.",
                            source="rules",
                            issue_type="security",
                            suggestion=f"Leave `{key}` out of the file and read the value from an "
                            f"environment variable or your secret store at startup. Rotate it too "
                            f"— it is in the history now.",
                            quoted_line=key + "=***",
                        )
                    )
    return findings


def _duplicate_keys(path: str, content: str, added: set[int]) -> list[Finding]:
    """A re-declared key only loses something when the two values differ.

    Over a real corpus, 16 of 22 findings were the same key written twice with the identical value
    — a copy-pasted block in a localization file, where Java keeping the last one changes nothing.
    Reporting those spends the developer's attention three times to be right once, so only the
    conflict is a finding.
    """
    seen: dict[str, tuple[int, str]] = {}
    out: list[Finding] = []
    for line_no, raw in enumerate(content.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith(("#", "!")):
            continue
        key, sep, value = stripped.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        first_line, first_value = seen.setdefault(key, (line_no, value))
        if first_line != line_no and first_value != value and line_no in added:
            out.append(
                Finding(
                    file=path,
                    line=line_no,
                    severity="warning",
                    rule_id="properties-duplicate-key",
                    message=f"`{key}` is already defined at line {first_line} with a different "
                    f"value. Java keeps the last one, so the earlier value never takes effect.",
                    source="rules",
                    issue_type="bug",
                    suggestion=f"Only one of the two values can win, and it is this one. Delete "
                    f"whichever line is wrong — line {first_line} if this value is the intended "
                    f"one, this line if it is not.",
                    quoted_line=stripped,
                )
            )
    return out


# --------------------------------------------------------------------------------------------------
# built-in: secrets in any file, not just .properties
# --------------------------------------------------------------------------------------------------

# Shapes that are a credential or nothing. Each one is narrow on purpose: a rule that cries wolf
# about secrets is the fastest way to teach a team to ignore security findings.
_SECRET_SHAPES: list[tuple[str, re.Pattern[str]]] = [
    ("private key", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("AWS secret access key", re.compile(r"(?i)aws.{0,20}secret.{0,20}['\"][A-Za-z0-9/+=]{40}['\"]")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}")),
    ("connection string password", re.compile(r"(?i)(?:jdbc|mongodb|postgres(?:ql)?|mysql|amqp):[^\s\"']*[:&?]password=(?!\$\{)[^&\s\"']{4,}")),
    ("basic auth in a URL", re.compile(r"(?i)https?://[^/\s:@\"']+:(?!\$\{)[^/\s:@\"']{4,}@")),
]

# `password = "..."` and friends. Long enough to be a real secret, and never a placeholder.
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*"
    r"[\"']([^\"'\s]{8,})[\"']"
)
_NOT_A_SECRET = re.compile(
    r"^(\$|\{|<|%|@|#|null|none|true|false|changeme|change_me|placeholder|example|sample|dummy|"
    r"redacted|xxx+|\*+|password|secret|test|todo)",
    re.I,
)
# Test code is where fake credentials belong; flagging them there is how a rule loses its audience.
_TEST_PATHS = ("*test*", "*Test.java", "*Tests.java", "*spec.ts", "*.spec.ts", "*/fixtures/*", "*/testsrc/*")


def _is_test_path(path: str) -> bool:
    lowered = path.lower()
    return any(fnmatch(lowered, pattern.lower()) for pattern in _TEST_PATHS)


@rule("hardcoded-secret", emits=("hardcoded-secret",))
def hardcoded_secret(ctx: RuleContext) -> list[Finding]:
    """A credential committed in any file type. `.properties` has its own rule and is left to it."""
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if diff.path.endswith(".properties") or _is_test_path(diff.path):
            continue
        for hunk in diff.hunks:
            for line_no, text in iter_hunk_lines(hunk, "added"):
                what = _secret_in(text)
                if what is None:
                    continue
                findings.append(
                    Finding(
                        file=diff.path,
                        line=line_no,
                        severity="critical",
                        rule_id="hardcoded-secret",
                        message=f"This line contains what looks like a {what}.",
                        source="rules",
                        issue_type="security",
                        # `what` sometimes already reads "hardcoded x", so the fix never repeats it.
                        suggestion="Move the value to an environment variable or your secret store "
                        "and read it at runtime, then rotate it — it is in the history now.",
                        # Never quote the secret itself: the quote is shown in the UI and stored.
                        quoted_line=f"<{what} redacted>",
                    )
                )
    return findings


def redact_quoted_line(quoted_line: str | None) -> str | None:
    """Strip a credential out of a quote, whichever rule or analyzer produced it.

    The rule that looks for secrets has always refused to quote one. Every other rule and every
    analyzer quotes the line whole, so a credential reached storage through whichever check happened
    to point at it second — PMD reporting the same field as unused is the case that was measured.
    A rule author should not have to remember, so the knowledge lives here and the service applies
    it to every finding on its way to an identity.
    """
    if not quoted_line:
        return quoted_line
    what = _secret_in(quoted_line)
    return f"<{what} redacted>" if what else quoted_line


def _secret_in(text: str) -> str | None:
    for what, pattern in _SECRET_SHAPES:
        if pattern.search(text):
            return what
    match = _SECRET_ASSIGNMENT.search(text)
    if match and not _NOT_A_SECRET.match(match.group(2)):
        return f"hardcoded {match.group(1).lower()}"
    return None


# --------------------------------------------------------------------------------------------------
# built-in: a catch block that swallows the exception
# --------------------------------------------------------------------------------------------------

_CATCH_RE = re.compile(r"\bcatch\s*\(([^)]*)\)\s*\{")
_COMMENT_RE = re.compile(r"//|/\*")
# Naming the caught exception `ignored` is how Java says "on purpose"; the IDE and the compiler
# warnings read it that way too.
_DELIBERATELY_IGNORED = frozenset({"ignore", "ignored", "expected"})


@rule("empty-catch", emits=("empty-catch",))
def empty_catch(ctx: RuleContext) -> list[Finding]:
    """A `catch` whose body is empty. The failure happened and nobody will know.

    A comment-only body counted too until a real corpus produced two findings from this rule and
    both were wrong: one body explained in a comment why dropping the exception is correct, the
    other bound it to a variable named `ignored`. Both are the author answering this rule before
    it asked. What is left is the case nobody defends — braces with nothing between them.
    """
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".java") or _is_test_path(diff.path):
            continue
        content = ctx.files.get(diff.path)
        if content is None:
            continue
        added = ctx.added.get(diff.path, set())
        lines = content.splitlines()
        for index, raw in enumerate(lines):
            caught = _CATCH_RE.search(raw)
            if caught is None or _caught_name(caught.group(1)) in _DELIBERATELY_IGNORED:
                continue
            body, closing = _catch_body(lines, index)
            if body is None or any(line for line in body):
                continue
            if any(_COMMENT_RE.search(line) for line in lines[index : closing + 1]):
                continue
            # Only report a catch this change actually wrote: pre-existing ones are not its problem.
            if not ({index + 1, closing + 1} & added):
                continue
            findings.append(
                Finding(
                    file=diff.path,
                    line=index + 1,
                    severity="warning",
                    rule_id="empty-catch",
                    message="This catch block swallows the exception, so the failure leaves no "
                    "trace anywhere.",
                    source="rules",
                    issue_type="bug",
                    suggestion="Log the exception with enough context to locate this call, or "
                    "rethrow it wrapped. If dropping it is deliberate, write why in the body — "
                    "this rule stays quiet on a catch that explains itself.",
                    quoted_line=raw.strip(),
                )
            )
    return findings


def _caught_name(declaration: str) -> str:
    """The variable a catch clause binds: the last word of `final IOException | SQLException e`."""
    words = declaration.split()
    return words[-1] if words else ""


def _catch_body(lines: list[str], start: int) -> tuple[list[str] | None, int]:
    """The catch block's statements, stripped of comments, and the line its `}` is on.

    Returns (None, start) when the block does not close within a small window — an unbalanced or
    exotic block is left alone rather than guessed at.
    """
    body: list[str] = []
    depth = 0
    for offset, raw in enumerate(lines[start : start + 40]):
        text = raw
        if offset == 0:
            text = raw[raw.index("{") :] if "{" in raw else raw
        depth += text.count("{") - text.count("}")
        statement = re.sub(r"//.*|/\*.*?\*/", "", text).strip().strip("{}").strip()
        if offset > 0 or statement:
            body.append(statement)
        if depth <= 0 and offset > 0 or (depth <= 0 and offset == 0 and "}" in text):
            return [b for b in body if b], start + offset
    return None, start


# --------------------------------------------------------------------------------------------------
# built-in: Spring XML wiring that cannot work
# --------------------------------------------------------------------------------------------------

_BEAN_ID_RE = re.compile(r"<bean\b[^>]*\bid\s*=\s*[\"']([^\"']+)[\"']")


@rule("spring-xml-wiring", emits=("spring-duplicate-bean-id",))
def spring_xml_wiring(ctx: RuleContext) -> list[Finding]:
    """A bean id declared twice in one file: the later definition silently replaces the earlier one,
    and nothing says so until the context starts."""
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".xml"):
            continue
        content = ctx.files.get(diff.path)
        if content is None or "<beans" not in content:
            continue
        added = ctx.added.get(diff.path, set())
        seen: dict[str, int] = {}
        lines = content.splitlines()

        for line_no, raw in enumerate(lines, start=1):
            for bean_id in _BEAN_ID_RE.findall(raw):
                first = seen.setdefault(bean_id, line_no)
                if first != line_no and line_no in added:
                    findings.append(
                        Finding(
                            file=diff.path,
                            line=line_no,
                            severity="critical",
                            rule_id="spring-duplicate-bean-id",
                            message=f"Bean `{bean_id}` is already defined at line {first} in this "
                            f"file. The later definition silently replaces the earlier one.",
                            source="rules",
                            issue_type="bug",
                            suggestion=f"Only one of the two definitions survives and it is this "
                            f"one. Rename this bean if both are meant to exist, or delete the "
                            f"definition at line {first} if it is dead.",
                            quoted_line=raw.strip(),
                        )
                    )

    return findings


# --------------------------------------------------------------------------------------------------
# built-in: ImpEx headers
# --------------------------------------------------------------------------------------------------

# The type may carry its own modifiers before the first column: `INSERT_UPDATE Media[batchmode=true];...`.
_IMPEX_HEADER_RE = re.compile(
    r"^\s*(INSERT_UPDATE|INSERT|UPDATE)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;(.*)$", re.I
)
_IMPEX_MACRO_DEF_RE = re.compile(r"^\s*(\$[\w-]+)\s*=\s*(.*)$")
_IMPEX_MACRO_USE_RE = re.compile(r"\$[\w-]+")


def _expand_impex_macros(text: str, definitions: dict[str, str]) -> str:
    """`$categories` in a header stands for `source(code,$catalogVersion)[unique=true]`.

    Reading the header as written is what made this rule fire on correct files: the modifier it is
    looking for lives in the macro, not in the line. Macros nest, so substitute until it settles.
    """
    for _ in range(3):
        expanded = _IMPEX_MACRO_USE_RE.sub(lambda m: definitions.get(m.group(0), m.group(0)), text)
        if expanded == text:
            break
        text = expanded
    return text


@rule("impex-headers", emits=("impex-no-unique-key",))
def impex_headers(ctx: RuleContext) -> list[Finding]:
    """An INSERT_UPDATE with no unique key updates nothing and inserts duplicates on every run.

    Column counting used to live here too and was removed in F2: no count that ignores macros,
    optional `[default=...]` columns and trailing separators survives real ImpEx, and the one error
    it could catch is the one the import itself reports the first time a developer runs it.
    """
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".impex"):
            continue
        content = ctx.files.get(diff.path)
        if content is None:
            continue
        added = ctx.added.get(diff.path, set())
        macros: dict[str, str] = {}

        for line_no, raw in enumerate(content.splitlines(), start=1):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            definition = _IMPEX_MACRO_DEF_RE.match(stripped)
            if definition:
                macros[definition.group(1)] = definition.group(2).strip()
                continue
            match = _IMPEX_HEADER_RE.match(stripped)
            if not match or match.group(1).upper() != "INSERT_UPDATE" or line_no not in added:
                continue
            columns = _expand_impex_macros(match.group(3), macros)
            if "unique=true" in columns.replace(" ", "").lower():
                continue
            findings.append(
                Finding(
                    file=diff.path,
                    line=line_no,
                    severity="critical",
                    rule_id="impex-no-unique-key",
                    message=f"INSERT_UPDATE {match.group(2)} marks no column `[unique=true]`, "
                    f"so it can only ever insert — and it will insert again next run.",
                    source="rules",
                    issue_type="bug",
                    suggestion=f"Mark the column that identifies an existing "
                    f"{match.group(2)} with `[unique=true]` — `code` for most types, `uid` for "
                    f"users — so a second run updates that row instead of adding another.",
                    quoted_line=stripped,
                )
            )
    return findings


# --------------------------------------------------------------------------------------------------
# built-in: a per-row database call inside a loop
# --------------------------------------------------------------------------------------------------


def _blank_java_noise(source: str) -> str:
    """The same text with comment and literal *contents* replaced by spaces.

    Offsets and line breaks are preserved, so a line number still means the same line and a blanked
    line still lines up with the original. A regex cannot do this in one pass: a `//` inside a
    string and a `"` inside a comment each break the other's rule, which is how a loop keyword in
    `LOG.debug("... order for cart ...")` came to be read as a loop 17 times over one corpus.
    """
    out = list(source)
    length = len(source)
    index = 0
    state: str | None = None  # None | "line" | "block" | the open quote character
    while index < length:
        character = source[index]
        if state is None:
            pair = source[index : index + 2]
            if pair == "//":
                state, out[index], out[index + 1] = "line", " ", " "
                index += 2
            elif pair == "/*":
                state, out[index], out[index + 1] = "block", " ", " "
                index += 2
            else:
                if character in "\"'":
                    state = character  # the quotes stay: only what they hold is blanked
                index += 1
            continue
        if state == "line":
            if character == "\n":
                state = None
            else:
                out[index] = " "
            index += 1
        elif state == "block":
            if source[index : index + 2] == "*/":
                out[index] = out[index + 1] = " "
                state = None
                index += 2
            else:
                if character != "\n":
                    out[index] = " "
                index += 1
        elif character == "\\":
            out[index] = " "
            if index + 1 < length and source[index + 1] != "\n":
                out[index + 1] = " "
            index += 2
        elif character == state:
            state = None
            index += 1
        elif character == "\n":
            state = None  # an unterminated literal must not swallow the rest of the file
            index += 1
        else:
            out[index] = " "
            index += 1
    return "".join(out)


_LOOP_HEAD_RE = re.compile(r"(?<![\w.$])(?:for|while)\s*\(")
_DO_BLOCK_RE = re.compile(r"(?<![\w.$])do\s*\{")
# The one stream method that iterates and nothing else. `map` and `filter` are deliberately out:
# `Optional.map` runs its lambda once, and a rule cannot tell the two apart from the call site.
_FOR_EACH_RE = re.compile(r"(?<![\w$])forEach\s*\(")


def _matching_paren(code: str, opening: int) -> int:
    depth = 0
    for index in range(opening, len(code)):
        if code[index] == "(":
            depth += 1
        elif code[index] == ")":
            depth -= 1
            if depth == 0:
                return index
    return len(code)


def _lines_inside_a_loop(code: str) -> set[int]:
    """The 1-based lines of `code` that sit in the *body* of a `for`, `while` or `do`.

    Body, not neighbourhood: the header line is outside its own loop, which is what tells the
    ordinary DAO shape — one `search(query)`, then `for (row : result.getResult())` reading what it
    returned — apart from a query that really does run once per row. `code` must come from
    `_blank_java_noise`, or a brace in a string will shift every depth after it.
    """
    inside: set[int] = set()
    block_is_loop: list[bool] = []  # one entry per open `{`
    braceless_at_depth: list[int] = []  # brace depth of each open `for (…) oneStatement;`
    for_each_ends: list[int] = []  # offset closing each open `forEach(…)` argument list
    loop_depth = 0
    next_block_is_loop = False
    header_parens = 0
    line = 1
    index = 0
    length = len(code)

    while index < length:
        character = code[index]
        while for_each_ends and index >= for_each_ends[-1]:
            for_each_ends.pop()
            loop_depth -= 1
        if character == "\n":
            line += 1
            index += 1
            continue
        if loop_depth > 0 and not character.isspace():
            inside.add(line)

        if header_parens:  # inside `for (…)` / `while (…)`: only the parens matter
            if character == "(":
                header_parens += 1
            elif character == ")":
                header_parens -= 1
                if header_parens == 0:
                    body = index + 1
                    while body < length and code[body].isspace():
                        body += 1
                    if body < length and code[body] == "{":
                        next_block_is_loop = True
                    else:  # `for (…) doThing();` — the body is one statement, no braces
                        braceless_at_depth.append(len(block_is_loop))
                        loop_depth += 1
            index += 1
            continue

        if character == "{":
            block_is_loop.append(next_block_is_loop)
            if next_block_is_loop:
                loop_depth += 1
            next_block_is_loop = False
        elif character == "}":
            if block_is_loop and block_is_loop.pop():
                loop_depth -= 1
        elif character == ";" and braceless_at_depth and braceless_at_depth[-1] == len(block_is_loop):
            braceless_at_depth.pop()
            loop_depth -= 1
        elif _LOOP_HEAD_RE.match(code, index):
            header_parens = 1
            index = code.index("(", index) + 1
            continue
        elif _DO_BLOCK_RE.match(code, index):
            next_block_is_loop = True
            index += 2
            continue
        elif _FOR_EACH_RE.match(code, index):
            opening = code.index("(", index)
            for_each_ends.append(_matching_paren(code, opening))
            loop_depth += 1
            index = opening + 1
            continue
        index += 1
    return inside


_RETURN_RE = re.compile(r"(?<![\w.$])return(?![\w$])")


def _returns_before_its_block_ends(code: str, start: int) -> bool:
    """True when the call's own block returns after it — the loop reaches the call at most once.

    `for (… entries) { if (matches) { save(order); return OK; } }` is a search, not a batch, and
    it was the only false positive left in the corpus once the enclosing block was read properly.
    Only `return` counts: `break` leaves the inner loop of a nest, so it proves nothing.
    """
    depth = 0
    for index in range(start, len(code)):
        character = code[index]
        if character == "{":
            depth += 1
        elif character == "}":
            if depth == 0:
                return False
            depth -= 1
        elif depth == 0 and _RETURN_RE.match(code, index):
            return True
    return False


class _CallInLoop(NamedTuple):
    rule_id: str
    pattern: re.Pattern[str]
    severity: Severity
    message: str
    suggestion: str


# Both of these were regex checks with a `context_pattern`: a loop keyword within six lines, in
# either direction, in a string or in a comment. Over a real corpus that was right 4 times out of
# 41. What makes a round trip per row expensive is the loop *enclosing* it, and only the file can
# say that, so both moved here.
_CALLS_IN_LOOP: tuple[_CallInLoop, ...] = (
    _CallInLoop(
        "flexiblesearch-in-loop",
        # The call itself, not the mere mention of the type: a field declaration is not a query.
        re.compile(r"(?:flexibleSearchService|getFlexibleSearchService\(\))\.search"),
        "critical",
        "FlexibleSearch executed inside a loop — one query per iteration.",
        "Fetch the set in a single query before the loop, or batch the lookups.",
    ),
    _CallInLoop(
        "modelservice-save-in-loop",
        # Either receiver, like the sibling above: the same N+1 is the same N+1 whether the author
        # reached for the field or the getter. `\.save\(` cannot reach `saveAll(`, which is the fix.
        re.compile(r"(?:modelService|getModelService\(\))\.save\("),
        "warning",
        "modelService.save() inside a loop multiplies DB round-trips.",
        "Collect the models and call modelService.saveAll(models) once.",
    ),
    _CallInLoop(
        "modelservice-remove-in-loop",
        # `\.remove\(` cannot reach `removeAll(`, and that matters more here than on the save side:
        # every false positive the corpus reading found was a `removeAll` inside a loop, where the
        # suggestion would name the very line the developer is looking at.
        re.compile(r"(?:modelService|getModelService\(\))\.remove\("),
        "warning",
        "modelService.remove() inside a loop deletes one row per round-trip.",
        "Collect the models and call modelService.removeAll(models) once.",
    ),
)


@rule("java-call-in-loop", emits=tuple(c.rule_id for c in _CALLS_IN_LOOP))
def java_call_in_loop(ctx: RuleContext) -> list[Finding]:
    """A database round trip the platform charges per row, written inside a loop.

    # ponytail: the loop has to enclose the call in the same method ; a save in a helper the loop
    # calls is a real N+1 this will not see, and finding it needs a call graph, not a scanner.
    """
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".java") or _is_test_path(diff.path):
            continue
        content = ctx.files.get(diff.path)
        # Without the file there is no enclosing block to read, and guessing one from the hunk is
        # the mistake this rule was rewritten to stop making.
        if content is None:
            continue
        if not any(call.pattern.search(content) for call in _CALLS_IN_LOOP):
            continue

        added = ctx.added.get(diff.path, set())
        code = _blank_java_noise(content)
        inside = _lines_inside_a_loop(code)
        originals = content.split("\n")
        offset = 0
        for line_no, text in enumerate(code.split("\n"), start=1):
            line_start, offset = offset, offset + len(text) + 1
            if line_no not in added or line_no not in inside:
                continue
            for call in _CALLS_IN_LOOP:
                match = call.pattern.search(text)
                if match is None:
                    continue
                if _returns_before_its_block_ends(code, line_start + match.end()):
                    continue
                findings.append(
                    Finding(
                        file=diff.path,
                        line=line_no,
                        severity=call.severity,
                        rule_id=call.rule_id,
                        message=call.message,
                        source="rules",
                        issue_type="performance",
                        suggestion=call.suggestion,
                        quoted_line=originals[line_no - 1].strip(),
                    )
                )
    return findings


# The elevation, not any session switch: `setCurrentUser(customer)` in the ASM facade is the
# feature, and the anonymous user an integration test installs is not a privilege. Only the admin
# user hands the thread rights its caller never had.
_ADMIN_ELEVATION_RE = re.compile(r"(?<![\w$])setCurrentUser\s*\([\w.()\s]*getAdminUser\s*\(\s*\)")
_SET_CURRENT_USER_RE = re.compile(r"(?<![\w$])setCurrentUser\s*\(")
_LOCAL_VIEW_RE = re.compile(r"(?<![\w$])executeInLocalView\s*\(")
_NEW_SESSION_RE = re.compile(r"(?<![\w$])createNewSession\s*\(")
_CLOSE_SESSION_RE = re.compile(r"(?<![\w$])closeSession\s*\(")


def _inside_a_local_view(code: str, offset: int) -> bool:
    """True when `offset` sits in the body a `executeInLocalView(…)` runs.

    The session sandbox throws the change away when the body returns, so the elevation is correct
    there and the rule must stay quiet. No corpus file takes this branch — it is here because the
    same shape made a near-miss rule in phase P4 wrong five times out of six.
    """
    return any(
        match.end() - 1 < offset < _matching_paren(code, match.end() - 1)
        for match in _LOCAL_VIEW_RE.finditer(code)
    )


@rule("session-admin-no-restore", emits=("session-admin-no-restore",))
def session_admin_no_restore(ctx: RuleContext) -> list[Finding]:
    """A file that elevates the session to admin and holds nothing that could put it back.

    Whether a restore exists is a fact about the file, never about the line: the `finally` that
    would undo the elevation is by definition somewhere else. A second `setCurrentUser` is the
    only thing that can restore one, so a file holding exactly one leaves the thread as admin on
    every path, and the next piece of work on that thread reads what it likes.
    """
    findings: list[Finding] = []
    for diff in ctx.diffs:
        if not diff.path.endswith(".java") or _is_test_path(diff.path):
            continue
        content = ctx.files.get(diff.path)
        # The restore is a whole-file fact, so a hunk on its own cannot answer the question.
        if content is None:
            continue
        code = _blank_java_noise(content)
        if len(_SET_CURRENT_USER_RE.findall(code)) != 1:
            continue
        # A session the file opens and closes carries the elevation away with it, which is the
        # sandbox `executeInLocalView` gives you written out by hand. Both calls, like the
        # `setCurrentUser` count above, are whole-file facts.
        if _NEW_SESSION_RE.search(code) and _CLOSE_SESSION_RE.search(code):
            continue

        added = ctx.added.get(diff.path, set())
        originals = content.split("\n")
        offset = 0
        for line_no, text in enumerate(code.split("\n"), start=1):
            line_start, offset = offset, offset + len(text) + 1
            match = _ADMIN_ELEVATION_RE.search(text)
            if match is None or line_no not in added:
                continue
            if _inside_a_local_view(code, line_start + match.start()):
                continue
            findings.append(
                Finding(
                    file=diff.path,
                    line=line_no,
                    severity="critical",
                    rule_id="session-admin-no-restore",
                    message=(
                        "The session is switched to the admin user and never switched back, so "
                        "the thread keeps admin rights after this method returns."
                    ),
                    source="rules",
                    issue_type="security",
                    suggestion=(
                        "Keep the previous user and restore it in a finally block, or run the "
                        "work inside sessionService.executeInLocalView() so the elevation is "
                        "discarded when the body returns."
                    ),
                    quoted_line=originals[line_no - 1].strip(),
                )
            )
    return findings
