"""Finding identity. Pure: a string in, a string out, no clock and no I/O.

A finding is a thing that persists across reviews, not a line of output. Its identity has to survive
the code moving around it, or a dismissal evaporates the moment someone adds an import above the
problem.
"""

from __future__ import annotations

import hashlib
import re

from smith.reviewer.domain.models import (
    MUTING_DISPOSITIONS,
    ActiveDisposition,
    Finding,
)

_WHITESPACE = re.compile(r"\s+")
_MAX_REASON = 300  # what the findings table stores


def fingerprint(rule_id: str, file: str, quoted_line: str | None) -> str:
    """The stable identity of a problem: the rule, the file, and the offending line's content.

    The line *number* is deliberately absent. Reformatting is absorbed by collapsing whitespace, and
    the same file reached by `./a/b.java` or `a\\b.java` is the same file.
    """
    material = "\n".join((rule_id.strip(), _normalize_path(file), _normalize_line(quoted_line)))
    return hashlib.sha1(material.encode("utf-8")).hexdigest()


def _normalize_path(file: str) -> str:
    path = file.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path.lstrip("/")


def _normalize_line(quoted_line: str | None) -> str:
    return _WHITESPACE.sub(" ", quoted_line or "").strip()


def suppression_reason(active: ActiveDisposition) -> str:
    """Why this finding is muted, in the words of whoever muted it.

    A muted finding is never silently dropped: the developer must be able to see what was hidden,
    by whom and why. Silence is what makes a tool untrustworthy.
    """
    return f"{active.disposition} by {active.email} on {active.at}: {active.reason}"[:_MAX_REASON]


def apply_dispositions(
    findings: list[Finding], active: dict[str, ActiveDisposition]
) -> list[Finding]:
    """Suppress the findings a developer or lead has already answered `dismissed` or `accepted`."""
    muted = []
    for finding in findings:
        answer = active.get(finding.fingerprint)
        if finding.suppressed or answer is None or answer.disposition not in MUTING_DISPOSITIONS:
            muted.append(finding)
            continue
        muted.append(finding.suppress(suppression_reason(answer)))
    return muted
