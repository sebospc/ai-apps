"""The floor: what the ruleset catches today, pinned so a future cut cannot drop it in silence.

Every other measurement in this repository is an upper bound. The rate budget, the per-rule share,
the critical share — a ruleset that finds nothing satisfies all three, and five phases of deleting
noisy rules improved every one of those numbers while nothing here could tell a rule deleted for
being wrong from a rule deleted for being inconvenient.

This test points the other way. `tests/data/corpus-baseline.jsonl` holds the `(rule_id, file, line)`
of every finding the ruleset reports over the real corpus, and the test fails when one of them stops
being reported. A finding that *arrives* is not a failure here — that is the rate budget's job — so
the two together bound the output from both sides, and a change that cannot satisfy both at once is
a change worth arguing about.

Refreshing the baseline is one command:

    SMITH_REFRESH_BASELINE=1 uv run pytest -k baseline -s

It rewrites the file and prints what left and what arrived. The commit that does it says which
findings left and why — that sentence is the whole point of the file, because without it a deletion
is a green diff again.

The analyzers are 95% of what a developer reads and this test says nothing about them: `scan()`
leaves them out on purpose, so their floor is pinned separately in `test_analyzer_precision.py`,
over the slice their ceiling is measured on. Both stand on `baseline.py`.

The corpus is somebody's client code: this file holds rule ids, paths and line numbers, never a
line of source.
"""

from __future__ import annotations

from pathlib import Path

import baseline
import pytest
from corpus import corpus_root, scan

BASELINE = Path(__file__).resolve().parent / "data" / "corpus-baseline.jsonl"
REFRESH = f"{baseline.REFRESH_ENV}=1 uv run pytest -k baseline -s"


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
def test_every_pinned_finding_is_still_reported() -> None:
    reported = {(f.rule_id, f.file, f.line) for f in scan().findings}
    baseline.assert_floor_holds(BASELINE, reported, "the ruleset", REFRESH)
