"""Reviewer domain model. Pure data: no framework, no I/O, no LLM."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from fnmatch import fnmatch
from itertools import takewhile
from typing import Literal

Severity = Literal["critical", "warning", "suggestion", "nitpick"]
SEVERITY_RANK: dict[str, int] = {"critical": 0, "warning": 1, "suggestion": 2, "nitpick": 3}

# Who produced a finding. Everything that is not "agent" is deterministic and outranks it.
Source = Literal["rules", "pmd", "eslint", "depcruise", "agent"]

# What a developer answered about a finding. `open` is the absence of an answer and is never stored.
# `confirmed_fixed` is the server's own answer: a `fixed` claim the next review did not contradict.
Disposition = Literal["fixed", "dismissed", "accepted", "confirmed_fixed"]
MUTING_DISPOSITIONS: frozenset[str] = frozenset({"dismissed", "accepted"})


@dataclass(frozen=True)
class ActiveDisposition:
    """The answer currently standing for one fingerprint in one project, and who gave it."""

    fingerprint: str
    disposition: Disposition
    reason: str
    email: str
    at: str  # the day it was set, ISO, so the domain never needs a clock


@dataclass
class Hunk:
    old_start: int
    old_lines: int
    new_start: int
    new_lines: int
    content: str


@dataclass
class FileDiff:
    path: str
    status: str  # added | modified | deleted
    hunks: list[Hunk] = field(default_factory=list)


@dataclass
class Finding:
    file: str
    line: int | None
    severity: Severity
    rule_id: str
    message: str
    source: Source
    issue_type: str = "bug"
    suggestion: str | None = None
    quoted_line: str | None = None
    suppressed: bool = False
    suppressed_reason: str | None = None
    # Stamped by the service, never by a rule or an adapter: identity is one decision, made once.
    fingerprint: str = ""
    # This was reported fixed and came back. The agent needs it to tell the developer the fix did
    # not hold, which reads very differently from meeting the problem for the first time.
    regressed: bool = False

    def suppress(self, reason: str) -> Finding:
        return replace(self, suppressed=True, suppressed_reason=reason)

    @property
    def rank(self) -> int:
        return SEVERITY_RANK.get(self.severity, 9)


@dataclass
class Check:
    """A deterministic regex check, declared in YAML. The floor the LLM never has to guess at."""

    id: str
    file_pattern: str
    pattern: str
    message: str
    rule_id: str | None = None
    severity: Severity = "warning"
    issue_type: str = "bug"
    exclude_file_pattern: str | None = None
    # A line matching this never fires, whatever `pattern` says. An import is the case that made it
    # necessary: naming a type is not using it, and a rule about use that reads imports cries wolf.
    exclude_line_pattern: str | None = None
    match_on: Literal["added", "removed", "any"] = "added"
    # A hit only fires when `context_pattern` also matches within `context_window` lines — cheap
    # structural precision (a query call is only a problem *inside a loop*) without an AST.
    context_pattern: str | None = None
    context_window: int = 6
    suggestion: str | None = None
    # The platform versions this check applies to: `since` inclusive, `until` exclusive.
    since: str | None = None
    until: str | None = None


@dataclass
class Guideline:
    """A rule stated in prose. Travels to the agent in the review plan; the agent judges it."""

    id: str
    text: str
    severity: Severity = "warning"
    why: str | None = None
    fix: str | None = None
    scope: list[str] = field(default_factory=list)
    issue_type: str = "logic"
    since: str | None = None
    until: str | None = None

    def applies_to(self, paths: Iterable[str]) -> bool:
        """Whether this guideline has anything to say about the files a change touched.

        Reported 2026-09-09: a jQuery file in a storefront's webroot came back flagged
        `no-scattered-condition`, a guideline about repeating a condition across Spring facades.
        The scope was only ever handed to the agent as a hint and never applied, so every Java
        guideline was offered for every file and the agent reached for the nearest label it had.
        A guideline that cannot apply cannot be misapplied.

        No scope means everywhere, which is what a guideline about the change as a whole wants.
        """
        if not self.scope:
            return True
        # Basename too, so `items.xml` matches a nested one without every ruleset writing `*/`.
        return any(
            fnmatch(path, pattern) or fnmatch(path.rsplit("/", 1)[-1], pattern)
            for path in paths
            for pattern in self.scope
        )


# Paths a change can touch without being able to introduce a bug. A ruleset overrides the whole
# list with its own `ignore_paths:`; matched against the path and against its basename.
IGNORE_PATHS: list[str] = [
    "*.md",
    "*.rst",
    "*.txt",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.svg",
    "*.ico",
    "*.pdf",
    ".gitignore",
    ".gitattributes",
    "*.lock",
    "*-lock.json",
    "*.class",
    "*.jar",
    "*.min.js",
    "*.min.css",
    "*.map",
]


def version_key(version: str | None) -> tuple[int, ...]:
    """`"2211.28"` -> `(2211, 28)`. Anything unparseable is an empty key, which applies every rule.

    Deliberately not semver: SAP Commerce releases are `2211`, `2205`, `2211.28`. Comparing the
    numeric parts left to right is what a developer means by "this is newer than that".
    """
    parts: list[int] = []
    for chunk in (version or "").split("."):
        digits = "".join(takewhile(str.isdigit, chunk.strip()))
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def _applies(since: str | None, until: str | None, version: tuple[int, ...]) -> bool:
    """`since` is inclusive and `until` exclusive: a rule about an API removed in 2211 is written
    `until: "2211"` and stops firing exactly when the platform drops it."""
    if since and version < version_key(since):
        return False
    if until and version >= version_key(until):
        return False
    return True


@dataclass
class RuleSet:
    name: str
    guidelines: list[Guideline] = field(default_factory=list)
    checks: list[Check] = field(default_factory=list)
    ignore_paths: list[str] = field(default_factory=lambda: list(IGNORE_PATHS))

    def for_version(self, version: str | None) -> RuleSet:
        """The rules that apply to a platform. An undetected version applies all of them: guessing
        would silence rules on a project nobody has told us about."""
        key = version_key(version)
        if not key:
            return self
        return replace(
            self,
            guidelines=[g for g in self.guidelines if _applies(g.since, g.until, key)],
            checks=[c for c in self.checks if _applies(c.since, c.until, key)],
        )


# Long enough for a team's real emphasis, short enough that it cannot bury the contract.
MAX_REVIEWER_PROMPT = 8000


@dataclass
class Policy:
    """How the verdict is computed. Server-side and deterministic; the agent never decides."""

    block_on: Severity = "critical"
    max_agent_findings: int = 50


@dataclass
class ReviewConfig:
    """A project's review setup: which ruleset, what blocks, what the agent is told."""

    ruleset: str = "sap-commerce-base"
    policy: Policy = field(default_factory=Policy)
    disabled_rules: set[str] = field(default_factory=set)
    conventions: str = ""
    # What this project wants emphasised, in the lead's own words. Steers the agent; never the
    # protocol — the contract is appended after it, and says so.
    reviewer_prompt: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> ReviewConfig:
        policy_raw = raw.get("policy") or {}
        return cls(
            ruleset=raw.get("ruleset") or "sap-commerce-base",
            policy=Policy(
                block_on=policy_raw.get("block_on", "critical"),
                max_agent_findings=int(policy_raw.get("max_agent_findings", 50)),
            ),
            disabled_rules=set(raw.get("disabled_rules") or []),
            conventions=raw.get("conventions") or "",
            reviewer_prompt=(raw.get("reviewer_prompt") or "")[:MAX_REVIEWER_PROMPT],
        )

    def to_dict(self) -> dict:
        return {
            "ruleset": self.ruleset,
            "policy": {
                "block_on": self.policy.block_on,
                "max_agent_findings": self.policy.max_agent_findings,
            },
            "disabled_rules": sorted(self.disabled_rules),
            "conventions": self.conventions,
            "reviewer_prompt": self.reviewer_prompt,
        }


# A rule dismissed more often than not, often enough for that to mean something rather than being
# one developer's bad afternoon. The lead decides what to do about it; Smith never tunes itself.
FLAG_MIN_FIRINGS = 4
FLAG_DISMISSAL_RATE = 0.5


@dataclass
class RuleHealth:
    """How a rule is doing in one project: dismissals are the feedback loop that keeps precision up."""

    rule_id: str
    fired: int
    dismissed: int
    reasons: list[str] = field(default_factory=list)  # most recent first, at most five

    @property
    def dismissal_rate(self) -> float:
        return self.dismissed / self.fired if self.fired else 0.0

    @property
    def flagged(self) -> bool:
        return self.fired >= FLAG_MIN_FIRINGS and self.dismissal_rate > FLAG_DISMISSAL_RATE


@dataclass
class Verdict:
    blocking: bool
    reason: str
    counts: dict[str, int] = field(default_factory=dict)


@dataclass
class ReviewSummary:
    id: int
    author: str
    branch: str
    title: str
    status: str
    blocking: bool | None
    created_at: str
    counts: dict[str, int] = field(default_factory=dict)


@dataclass
class ReviewStep:
    seq: int
    kind: str
    payload: dict
    at: str


@dataclass
class ReviewDetail:
    summary: ReviewSummary
    verdict_reason: str
    findings: list[Finding]
    steps: list[ReviewStep]
    # What was answered about each finding, by fingerprint. The store cannot fill this in: a
    # disposition belongs to the project, not to the review it was argued in.
    answers: dict[str, ActiveDisposition] = field(default_factory=dict)


@dataclass
class RuleContext:
    """Everything a programmatic rule may look at. Adding a rule means reading this, nothing else."""

    diffs: list[FileDiff]
    added: dict[str, set[int]]
    files: dict[str, str]  # path -> full post-change content, when the plugin sent it
    checks: list[Check]
