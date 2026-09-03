"""The other 95% of a review: what the analyzers say, measured the way our own rules are.

`test_precision.py` holds the ruleset at 0.29 findings per 1000 lines and five phases of deleting
noisy rules earned that number. It is also, measured, the smaller half of what a developer reads.
Over a 150-file java slice of the corpus the rules report 14 findings and pmd reports 244 — pmd is
95% of the review, and until this test existed nothing in this repository had ever looked at it.

`corpus.py::scan()` leaves the analyzers out on purpose, and the reason it gives is right: a number
that moves with the machine is not a measurement of our rules. That is an argument about
attribution, not about coverage. The developer does not read our rules, they read the review, so
the review needs its own number. Keeping the two scans separate is what stops either from hiding
the other — a rule deleted here would not flatter the ruleset's rate, and a noisy analyzer cannot
be paid for by a quiet ruleset.

Every rate below is a **ceiling to lower**, never a floor, and a ruleset that says nothing satisfies
all of them. `tests/data/analyzer-baseline.jsonl` is the floor under the same slice: it pins the
`(rule_id, file, line)` of every analyzer finding, and the last test in this module fails when one
of them stops being reported. Ceiling and floor run together over the same scan on purpose — if the
two ever disagree, that disagreement is the finding.

It skips when `pmd` is not installed, which is the legitimate half of why the analyzers were
excluded in the first place: a measurement that fails on a machine without a binary is a broken
test, not a finding.

The corpus is somebody's client code: rule ids, paths and counts leave this module, source lines
never do.
"""

from __future__ import annotations

import shutil
from collections import Counter
from pathlib import Path

import baseline
import pytest
from corpus import PMD, JAVA_SLICE_SIZE, corpus_root, java_slice

from smith.reviewer.domain.diff import added_lines, parse_unified_diff
from smith.reviewer.domain.findings import fingerprint
from smith.reviewer.domain.models import Finding

SAMPLE = Path(__file__).resolve().parent / "data" / "PmdRulesetSample.java"
BASELINE = Path(__file__).resolve().parent / "data" / "analyzer-baseline.jsonl"
REFRESH = f"{baseline.REFRESH_ENV}=1 uv run pytest -k analyzer_precision -s"

# Measured 2026-08-22 over the seeded slice — 150 files, 18,550 lines. Two numbers, before and
# after `rules/pmd-java.xml` replaced PMD's `quickstart.xml`:
#
#   quickstart   pmd 244, 13.15 per 1000, 82 critical   combined 258, 13.91
#   pmd-java     pmd  26,  1.40 per 1000,  0 critical   combined  40,  2.16
#
# O3 took one more off each: `PreserveStackTrace` was reported twice on one `throw`, and an
# analyzer finding is one finding, so pmd is 25 at 1.35 and the whole review 39 at 2.10.
#
# The whole slice, rules and pmd together, costs 4 seconds.
#
# These are today's numbers rounded up, so the test is green now and fails the moment the analyzers
# get noisier. A ceiling left above what the code achieves stops measuring anything, which is why
# they came down with the cut instead of being left where O1 wrote them.
MAX_PMD_PER_1000_LINES = 1.5
MAX_COMBINED_PER_1000_LINES = 2.5

# Zero, not "few". The verdict blocks on critical, so this is the number of ways a review can stop
# a merge on something no rule in `rules/*.yaml` had a say in. Every rule in `pmd-java.xml` is PMD
# priority 3, so a critical can only appear if someone adds a priority 1 rule — which should cost
# them a line here, deliberately, rather than arriving as a side effect.
MAX_PMD_CRITICAL = 0

# Findings that share their identity with another finding. Before the analyzers quoted the line
# they report on, this was 148 of 244 on this slice — every `pmd:GuardLogStatement` in one file was
# literally the same finding, so answering one suppressed all of them and quoted the developer as
# having ruled out five they never read.
#
# Four, not zero. The survivors are two pairs of byte-identical lines in one file
# (`InputStream reportData = null;` declared in two methods), and that collision is the price of an
# identity made of line *content*: it is what lets a dismissal survive someone adding an import
# above the problem. Putting the line number in the fingerprint would trade it for a finding that
# comes back as new after every edit, which is the worse deal.
MAX_SHARED_FINGERPRINTS = 4


def _table(findings: tuple[Finding, ...], total_lines: int) -> str:
    """Per source first, then the rules inside each — the shape of what a developer opens."""
    per_source = Counter(f.source for f in findings)
    critical = Counter(f.source for f in findings if f.severity == "critical")

    rows = [f"  {'source':<20}{'findings':>9}{'per 1000':>10}{'critical':>10}"]
    rows += [
        f"  {source:<20}{count:>9}{count * 1000 / total_lines:>10.2f}{critical[source]:>10}"
        for source, count in per_source.most_common()
    ]
    rows.append(
        f"  {'combined':<20}{len(findings):>9}{len(findings) * 1000 / total_lines:>10.2f}"
        f"{sum(critical.values()):>10}"
    )

    for source, _ in per_source.most_common():
        rows.append(f"\n  {source}:")
        per_rule = Counter(f.rule_id for f in findings if f.source == source)
        rows += [f"    {rule_id:<50}{count:>5}" for rule_id, count in per_rule.most_common()]
    return "\n".join(rows)


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
@pytest.mark.skipif(shutil.which("pmd") is None, reason="no pmd on PATH: nothing to measure")
def test_what_the_developer_reads_stays_under_its_budget() -> None:
    slice_ = java_slice()
    findings = slice_.findings
    total_lines = slice_.total_lines

    pmd = [f for f in findings if f.source == "pmd"]
    pmd_rate = len(pmd) * 1000 / total_lines
    combined_rate = len(findings) * 1000 / total_lines

    report = (
        f"{len(slice_.files)} java files, {total_lines} lines\n"
        + _table(findings, total_lines)
    )
    # Printed on success too: this is a measurement before it is a gate, so re-reading it is
    # `pytest -k precision -s` rather than editing an assertion until it fails.
    print(f"\n{report}")

    assert len(slice_.files) == JAVA_SLICE_SIZE, (
        f"the slice is {len(slice_.files)} files, not {JAVA_SLICE_SIZE} — the rates below are not "
        f"comparable to any number recorded against it"
    )
    assert pmd_rate <= MAX_PMD_PER_1000_LINES, (
        f"pmd reports {len(pmd)} findings, {pmd_rate:.2f} per 1000 lines, ceiling is "
        f"{MAX_PMD_PER_1000_LINES}. This is most of what a developer reads, so a rule added here "
        f"costs more attention than a rule added to `rules/`.\n\n{report}"
    )
    assert combined_rate <= MAX_COMBINED_PER_1000_LINES, (
        f"the whole review is {len(findings)} findings, {combined_rate:.2f} per 1000 lines, "
        f"ceiling is {MAX_COMBINED_PER_1000_LINES}\n\n{report}"
    )
    critical = [f for f in pmd if f.severity == "critical"]
    assert len(critical) <= MAX_PMD_CRITICAL, (
        f"pmd blocks {len(critical)} merges on this slice, ceiling is {MAX_PMD_CRITICAL}. "
        f"Blocking is the ruleset's decision to make, not an analyzer's: "
        f"{sorted({f.rule_id for f in critical})}\n\n{report}"
    )


@pytest.mark.skipif(shutil.which("pmd") is None, reason="no pmd on PATH: nothing to run")
def test_the_ruleset_reports_a_leak_and_says_nothing_about_a_log_guard() -> None:
    """The cut, on one file, in the form a developer would recognise.

    The rates above say the review got quieter. They cannot say it stayed useful, because a ruleset
    that reports nothing satisfies every ceiling in this module. This is the other half: the same
    file carries a leaked PreparedStatement and an unguarded debug log, `quickstart.xml` reported
    both, and only the leak is worth a developer's attention.
    """
    source = SAMPLE.read_text(encoding="utf-8")
    path = f"src/{SAMPLE.name}"
    lines = source.splitlines()
    diff = (
        f"diff --git a/{path} b/{path}\n"
        "new file mode 100644\n"
        "--- /dev/null\n"
        f"+++ b/{path}\n"
        f"@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{line}\n" for line in lines)
    )
    diffs = parse_unified_diff(diff)
    added = added_lines(diffs)

    findings = PMD.run(diffs, {path: source}, added)
    reported = {f.rule_id for f in findings}

    assert "pmd:CloseResource" in reported, (
        f"the leaked PreparedStatement in {SAMPLE.name} is not reported — the cut took a defect "
        f"with it. Reported: {sorted(reported)}"
    )
    assert "pmd:GuardLogStatement" not in reported, (
        f"GuardLogStatement is back. It was 53 findings and 53 criticals on the corpus slice, and "
        f"a missing log guard is not a reason to block a merge. Reported: {sorted(reported)}"
    )
    assert not [f for f in findings if f.severity == "critical"], (
        "nothing in this file should block a merge"
    )


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
@pytest.mark.skipif(shutil.which("pmd") is None, reason="no pmd on PATH: nothing to measure")
def test_an_analyzer_finding_is_one_finding() -> None:
    """Two problems the developer can answer separately must have two identities.

    Reproduced against postgres on review 259: one dismissal of `pmd:GuardLogStatement` at
    `ProductIndexingWorker.java:60` and six findings vanished. Identity is
    `(rule_id, file, quoted_line)` and no analyzer set `quoted_line`, so one rule in one file was
    one finding no matter how many places it fired.
    """
    findings = java_slice().findings
    pmd = [f for f in findings if f.source == "pmd"]

    unquoted = [f for f in pmd if f.quoted_line is None]
    assert not unquoted, (
        f"{len(unquoted)} pmd findings quote no line, so they share an identity with every other "
        f"finding of their rule in their file: "
        f"{sorted({(f.rule_id, f.file) for f in unquoted})}"
    )

    prints = Counter(fingerprint(f.rule_id, f.file, f.quoted_line) for f in findings)
    shared = [f for f in pmd if prints[fingerprint(f.rule_id, f.file, f.quoted_line)] > 1]
    assert len(shared) <= MAX_SHARED_FINGERPRINTS, (
        f"{len(shared)} pmd findings share an identity with another finding, ceiling is "
        f"{MAX_SHARED_FINGERPRINTS}. Answering one of them speaks for all of them:\n"
        + "\n".join(f"  {f.rule_id} {f.file}:{f.line} {f.quoted_line!r}" for f in shared)
    )


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
@pytest.mark.skipif(shutil.which("pmd") is None, reason="no pmd on PATH: nothing to measure")
def test_every_pmd_finding_on_the_slice_names_the_fix() -> None:
    """pmd is 25 of the 39 findings a developer reads here, so it is most of the review.

    `test_analyzers.py` holds the ruleset and `rules/pmd-fixes.json` to the same list of rules.
    This is the other end of it, on real code: every violation the corpus actually produces reaches
    the developer with the change named, not just the smell.
    """
    pmd = [f for f in java_slice().findings if f.source == "pmd"]
    silent = [f for f in pmd if not (f.suggestion or "").strip()]
    assert not silent, (
        f"{len(silent)} of {len(pmd)} pmd findings say what is wrong and not what to write: "
        + ", ".join(sorted({f.rule_id for f in silent}))
    )


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
@pytest.mark.skipif(shutil.which("pmd") is None, reason="no pmd on PATH: nothing to measure")
def test_every_pinned_analyzer_finding_is_still_reported() -> None:
    """The floor under the analyzers, which is 95% of the review the ceilings above bound.

    O2 cut pmd from 244 findings to 26 and every number in this module improved. Nothing here could
    have told that cut from one that dropped `CloseResource` — a ceiling is satisfied by finding
    nothing, so the phase that made the review quieter is exactly the phase that could have made it
    useless without a test noticing.

    Only the analyzer findings are pinned. The ruleset's 14 findings on this slice are already in
    `corpus-baseline.jsonl`, which covers the whole corpus and therefore every file in the slice;
    pinning them twice would mean refreshing two files for one deletion.
    """
    reported = {(f.rule_id, f.file, f.line) for f in java_slice().findings if f.source != "rules"}
    baseline.assert_floor_holds(BASELINE, reported, "the analyzers", REFRESH)
