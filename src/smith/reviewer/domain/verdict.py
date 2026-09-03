"""The quality gate. Computed here, from the project's policy — never by a language model."""

from __future__ import annotations

from collections import Counter

from smith.reviewer.domain.models import SEVERITY_RANK, Finding, Policy, Verdict


def compute_verdict(findings: list[Finding], policy: Policy) -> Verdict:
    active = [f for f in findings if not f.suppressed]
    counts = Counter(f.severity for f in active)
    threshold = SEVERITY_RANK.get(policy.block_on, 0)
    blockers = [f for f in active if f.rank <= threshold]

    if blockers:
        reason = (
            f"{len(blockers)} finding(s) at or above `{policy.block_on}` must be resolved before merge"
        )
    else:
        reason = "no blocking findings"

    return Verdict(blocking=bool(blockers), reason=reason, counts=dict(counts))
