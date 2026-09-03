"""A floor: what is reported today, pinned so a future cut cannot drop it in silence.

Every other measurement in this repository is an upper bound. The rate budget, the per-rule share,
the critical share — a source that finds nothing satisfies all three, and phases of deleting noisy
rules improved every one of those numbers while nothing could tell a rule deleted for being wrong
from a rule deleted for being inconvenient.

Two tests point the other way and they are the same idea aimed at two halves of a review:
`test_baseline.py` pins what the ruleset catches over the whole corpus, and
`test_analyzer_precision.py` pins what the analyzers catch over the java slice. The halves have to
behave identically — an empty baseline must fail in both, and refreshing one must never rewrite the
other — so the behaviour lives here once instead of being written twice and drifting.

A finding that *arrives* is not a failure: that is the rate budget's job. The two bound the output
from both sides, and a change that cannot satisfy both at once is a change worth arguing about.

The corpus is somebody's client code: these files hold rule ids, paths and line numbers, never a
line of source.
"""

from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path

REFRESH_ENV = "SMITH_REFRESH_BASELINE"

# rule_id, file, line — the identity of a finding for this purpose. The message is left out on
# purpose: rewording a finding is an improvement, and it must not read as a lost catch. `line` is
# optional because an analyzer that cannot place a finding reports none rather than inventing one.
Pinned = tuple[str, str, int | None]


def _where(pin: Pinned) -> tuple[str, int, str]:
    """Where the finding is, as a sort key that never compares None to an int."""
    rule_id, file, line = pin
    return (file, -1 if line is None else line, rule_id)


def read(path: Path) -> set[Pinned]:
    if not path.exists():
        return set()
    return {
        (row["rule_id"], row["file"], row["line"])
        for row in (json.loads(line) for line in path.read_text().splitlines() if line.strip())
    }


def write(path: Path, pinned: set[Pinned]) -> None:
    """Sorted by where the finding is, so a refresh shows up as a readable diff."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps({"rule_id": rule_id, "file": file, "line": line}) + "\n"
            for rule_id, file, line in sorted(pinned, key=_where)
        )
    )


def movement(previous: set[Pinned], current: set[Pinned]) -> str:
    left = sorted(previous - current, key=_where)
    arrived = sorted(current - previous, key=_where)
    lines = [f"{len(current)} findings pinned — {len(left)} left, {len(arrived)} arrived"]
    for label, moved in (("gone", left), ("new", arrived)):
        lines += [f"  {label:<5} {rule_id:<32} {file}:{line}" for rule_id, file, line in moved]
    return "\n".join(lines)


def assert_floor_holds(path: Path, reported: set[Pinned], produced_by: str, refresh: str) -> None:
    """Fail naming every pinned finding `reported` no longer contains, refreshing the file first.

    `refresh` is the exact command that re-pins this file, quoted back in both failures because a
    floor nobody knows how to move is a floor somebody deletes.
    """
    if os.environ.get(REFRESH_ENV):
        print(f"\n{movement(read(path), reported)}\n\nrewrote {path}")
        write(path, reported)

    pinned = read(path)
    assert pinned, (
        f"{path} is missing or empty, so this test proves nothing. It is the only check that "
        f"fails when a finding from {produced_by} disappears — refresh it with `{refresh}`."
    )

    missing = sorted(pinned - reported, key=_where)
    per_rule = Counter(rule_id for rule_id, _, _ in missing)
    detail = "\n".join(f"  {rule_id:<32} {file}:{line}" for rule_id, file, line in missing)
    assert not missing, (
        f"{len(missing)} of {len(pinned)} pinned findings are no longer reported "
        f"({', '.join(f'{rule_id} ×{count}' for rule_id, count in per_rule.most_common())}). "
        f"Each one is real code that {produced_by} used to report on and now says nothing about. "
        f"If that is deliberate, refresh the baseline with `{refresh}` and say in the commit "
        f"which findings left and why.\n\n{detail}"
    )
