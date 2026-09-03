"""Merge deterministic findings with the agent's findings. Deterministic always wins."""

from __future__ import annotations

from smith.reviewer.domain.models import Finding

_LINE_TOLERANCE = 2


def merge(deterministic: list[Finding], agent: list[Finding]) -> list[Finding]:
    """Deterministic findings first; suppress agent findings that restate one of them.

    A deterministic hit is proof, an agent hit is an opinion. When both point at the same place for
    the same reason, reporting twice makes the review look noisy and untrustworthy.

    Duplicates are suppressed rather than dropped: a suppressed finding never reaches the verdict,
    but it stays on the record, so a lead reading the review can see what the agent said and why it
    did not count.
    """
    kept: list[Finding] = list(deterministic)
    seen = {_key(f) for f in deterministic if not f.suppressed}

    for candidate in agent:
        if candidate.suppressed:
            kept.append(candidate)
            continue
        if _overlaps(candidate, deterministic):
            kept.append(candidate.suppress("already reported by a deterministic rule"))
            continue
        key = _key(candidate)
        if key in seen:
            kept.append(candidate.suppress("duplicate of another finding in this review"))
            continue
        seen.add(key)
        kept.append(candidate)

    kept.sort(key=lambda f: (f.suppressed, f.rank, f.file, f.line or 0))
    return kept


def _key(f: Finding) -> tuple[str, int, str]:
    return (f.file, (f.line or 0) // (_LINE_TOLERANCE + 1), f.rule_id)


def _overlaps(candidate: Finding, others: list[Finding]) -> bool:
    for other in others:
        if other.suppressed or other.file != candidate.file:
            continue
        if other.rule_id != candidate.rule_id:
            continue
        if abs((other.line or 0) - (candidate.line or 0)) <= _LINE_TOLERANCE:
            return True
    return False
