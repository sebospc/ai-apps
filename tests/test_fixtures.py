"""Every rule fixture, run through the same pipeline a real review uses.

A fixture is a directory under `rules/fixtures/`:

    <case>/diff            the unified diff under review
    <case>/files/...       optional, the changed files' full content, mirroring their repo paths
    <case>/ruleset         optional, the ruleset name; `sap-commerce-base` when absent
    <case>/expected.json   {"findings": [{"rule_id", "file", "line"}]}, an exact set

An empty expected set is a **precision fixture**: ordinary code that must produce nothing at all.
A rule that fires on it costs more than the bug it would have caught, because it takes the
credibility of every other rule with it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from smith.reviewer.adapters.yaml_rules import YamlRuleSource
from smith.reviewer.domain.diff import added_lines, parse_unified_diff, scope_to_diff
from smith.reviewer.domain.models import RuleContext
from smith.reviewer.domain.rules import emitted_rule_ids, run_rules
from smith.reviewer.domain.suppression import drop_unactionable

FIXTURES = Path(__file__).resolve().parent.parent / "rules" / "fixtures"
RULES_DIR = Path(__file__).resolve().parent.parent / "rules"


def _cases() -> list[Path]:
    return sorted(p for p in FIXTURES.iterdir() if p.is_dir() and (p / "diff").is_file())


def _files(case: Path) -> dict[str, str]:
    root = case / "files"
    if not root.is_dir():
        return {}
    return {
        str(p.relative_to(root)): p.read_text()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def _ruleset_name(case: Path) -> str:
    """A client overlay is a ruleset like any other, so its fixtures name it here."""
    declared = case / "ruleset"
    return declared.read_text().strip() if declared.is_file() else "sap-commerce-base"


def _report(case: Path) -> list:
    """The fixture put through the pipeline a real review uses, minus the analyzers.

    Analyzers are left out on purpose: they depend on binaries being installed, and a fixture that
    passes or fails with the machine it runs on proves nothing about a rule.
    """
    ruleset = YamlRuleSource(RULES_DIR).load(_ruleset_name(case))
    diffs = parse_unified_diff((case / "diff").read_text())
    assert diffs, f"{case.name} has a diff that parses to nothing"

    added = added_lines(diffs)
    ctx = RuleContext(diffs=diffs, added=added, files=_files(case), checks=ruleset.checks)
    reported = drop_unactionable(scope_to_diff(run_rules(ctx, set()), added), ctx.files)
    return [f for f in reported if not f.suppressed]


@pytest.mark.parametrize("case", _cases(), ids=lambda p: p.name)
def test_rule_fixtures_report_exactly_what_they_say(case: Path) -> None:
    findings = _report(case)

    expected = json.loads((case / "expected.json").read_text())["findings"]
    got = sorted((f.rule_id, f.file, f.line) for f in findings)
    want = sorted((f["rule_id"], f["file"], f["line"]) for f in expected)

    assert got == want, (
        f"{case.name}: expected {want}, got {got}"
        if want
        else f"{case.name} is a precision fixture: nothing may fire, but {got} did"
    )


def test_there_are_precision_fixtures_to_keep_the_rules_honest() -> None:
    """A harness with only firing fixtures measures recall and says nothing about precision."""
    quiet = [
        case
        for case in _cases()
        if not json.loads((case / "expected.json").read_text())["findings"]
    ]
    assert len(quiet) >= 3, f"only {len(quiet)} precision fixtures: ordinary code must stay quiet"


def _fired_rule_ids() -> set[str]:
    """Every rule_id some fixture expects to see reported."""
    return {
        finding["rule_id"]
        for case in _cases()
        for finding in json.loads((case / "expected.json").read_text())["findings"]
    }


def _declared_rule_ids() -> dict[str, str]:
    """Every rule_id a review can report → where it is declared.

    Two id spaces meet here and they have been confused twice. A YAML check declares its own `id`
    (`java/no-system-out`) and the `rule_id` its findings carry (`no-system-out`), and only the
    second is what a fixture can assert on. A Python rule is registered under a key that is not a
    rule_id at all, so it declares what it emits instead. Overlays count: a client's extra check is
    a check like any other and needs the same evidence.
    """
    declared: dict[str, str] = {}
    source = YamlRuleSource(RULES_DIR)
    for name in source.names() + [f"clients/{overlay}" for overlay in source.overlays()]:
        for check in _checks_of(source, name):
            declared[check.rule_id or check.id] = f"check {check.id} in {name}.yaml"
    for registry_key, emitted in emitted_rule_ids().items():
        for rule_id in emitted:
            declared[rule_id] = f"rule {registry_key} in domain/rules.py"
    return declared


def _checks_of(source: YamlRuleSource, name: str) -> list:
    """An overlay is not loadable on its own, so it is read as the base it extends."""
    base, _, overlay = name.partition("/")
    return source.load(f"sap-commerce-base+{overlay}").checks if overlay else source.load(base).checks


def test_every_rule_id_a_review_can_report_has_a_fixture_that_fires_it() -> None:
    """No rule ships without evidence it fires — the other half of the precision fixtures.

    Without this, a check can be added, never fire on anything, and pass every test in the suite:
    the precision budget only ever gets better when a rule says less. This is the direction the
    budget cannot measure.
    """
    fired = _fired_rule_ids()
    missing = {
        rule_id: where for rule_id, where in _declared_rule_ids().items() if rule_id not in fired
    }
    assert not missing, "no fixture proves these fire: " + ", ".join(
        f"{rule_id} ({where})" for rule_id, where in sorted(missing.items())
    )


def test_no_fixture_expects_a_rule_id_nothing_declares() -> None:
    """The same map read the other way, so a renamed rule cannot leave a fixture asserting a ghost."""
    declared = _declared_rule_ids()
    orphans = sorted(rule_id for rule_id in _fired_rule_ids() if rule_id not in declared)
    assert not orphans, f"fixtures expect rule ids no ruleset or rule declares: {orphans}"


# The words a fix opens with. A `message` says what is wrong on the line under review; a
# `suggestion` says what to write instead. Four checks used to say both in the message, so the
# developer read the same instruction twice in two consecutive clauses, which is how a tool
# teaches people to skim it. This list is the vocabulary of an instruction, not of English at
# large: a message that needs one of these words is a message that has taken over the fix's job.
INSTRUCTION_WORDS = (
    "must",
    "should",
    "use",
    "add",
    "remove",
    "replace",
    "inject",
    "return",
    "move",
    "prefer",
    "avoid",
)


def test_a_check_message_states_the_problem_and_leaves_the_fix_to_the_suggestion() -> None:
    source = YamlRuleSource(RULES_DIR)
    names = source.names() + [f"clients/{overlay}" for overlay in source.overlays()]
    prescribing = {
        check.id: (word, check.message)
        for name in names
        for check in _checks_of(source, name)
        for word in INSTRUCTION_WORDS
        if re.search(rf"\b{word}\b", check.message, re.IGNORECASE)
    }
    assert not prescribing, "these messages instruct instead of describing: " + ", ".join(
        f'{check_id} says "{word}" in {message!r}' for check_id, (word, message) in sorted(prescribing.items())
    )


def test_every_finding_a_fixture_fires_says_what_to_change() -> None:
    """A finding without a `suggestion` names a problem and leaves the developer to guess the fix.

    Asserted over the fixtures rather than over the corpus on purpose: the fixtures enumerate the
    whole id space a review can report, so a rule that never fires on our corpus is covered here
    and could never be covered there.
    """
    silent = sorted(
        {
            (finding.rule_id, case.name)
            for case in _cases()
            for finding in _report(case)
            if not (finding.suggestion or "").strip()
        }
    )
    assert not silent, "these findings say what is wrong and not what to change: " + ", ".join(
        f"{rule_id} (fixture {case_name})" for rule_id, case_name in silent
    )
