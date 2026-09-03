"""The precision budget, measured against real client code instead of our own fixtures.

The synthetic fixtures under `rules/fixtures/` prove a rule fires and stays quiet on the cases the
rule's author thought of. That is recall plus a sanity check, and it is not precision: the same
person wrote the rule and the fixture, so both encode the same assumptions about what real code
looks like. This test replaces that opinion with a measurement.

It runs the full ruleset over every reviewable file in a real SAP Commerce codebase, every line
treated as newly added — the worst case a developer can hand us — and asserts three things a noisy
ruleset cannot satisfy:

  * at most `MAX_FINDINGS_PER_1000_LINES` findings per 1000 lines;
  * no single rule contributing more than `MAX_SINGLE_RULE_SHARE` of the total, because an average
    hides a flood from one bad rule behind every quiet rule around it;
  * no more than `MAX_CRITICAL_SHARE` of the total at `critical`, because volume is not truth. A
    ruleset can sit well inside the rate budget and still be mostly wrong, and a wrong finding at
    `critical` is the one that stops a merge.

Every bound here is an upper one, so every one of them is satisfied by a ruleset that says nothing
at all. `test_baseline.py` is the other direction and reads the same scan.

The corpus is somebody's client code: it is read, never written, and nothing from it is ever
quoted into this repository. The failure table names rules, counts and paths — never a line of
source.
"""

from __future__ import annotations

from collections import Counter

import pytest
from corpus import corpus_root, scan

from smith.reviewer.domain.models import Finding

# The budget, set just above what the ruleset measurably achieves so the next noisy rule fails here
# rather than in front of a developer. Measured 2026-08-23 over the whole corpus after R1 —
# 3471 files, 370,833 lines: **101 findings, 0.272 per 1000 lines**, worst rules
# `service-no-session` and `properties-duplicate-key` tied at 22%, 58 of the 101 at `critical`
# (57.4%). Every rule that still fires, and the count that produced it:
#
#   service-no-session 22 · properties-duplicate-key 22 · no-model-in-facade 14
#   session-admin-no-restore 12 · modelservice-save-in-loop 10 · facades-no-dao 5
#   format-string-no-placeholder 3 · log-cookie-value 3 · no-system-out 2
#   no-business-logic-in-controller 2 · validator-no-db-query 2 · no-printstacktrace 1
#   properties-hardcoded-secret 1 · spring-duplicate-bean-id 1 · flexiblesearch-in-loop 1
#
# Down from 438 findings and 1.18 per 1000 at the end of phase F, and from 115 and 0.31 after phase
# L. Neither phase tuned these numbers: each read every finding of its day against the source it
# quotes and deleted or fixed the rules behind the false ones — 75% of the 438, then 28% of the 115.
# `pytest -k precision -s` prints the current table.
#
# Raised 0.29 → 0.34 on 2026-08-23, alone, with no rule touched in the same commit — a bound moved
# beside the findings that fill it is a bound nobody can read afterwards. What justifies it is
# `output/inloop-sites-2026-08-23.md`: the 25 sites the `modelservice` widening would add, each read
# against its source *before* landing, 20 of which survive that reading once `removeAll(` is dropped
# from the pattern. Those 20 put the ruleset at 121 findings and 0.326 per 1000, over a bound of
# 0.29 that permits 107. The raise carries the old headroom forward rather than inventing new slack:
# 0.29 over 370,833 lines was 107 findings against the 102 it governed, five spare, and five spare
# over 121 is 126 findings — 0.34.
MAX_FINDINGS_PER_1000_LINES = 0.34

# The worst rule is at 27% against a 30% bound, the tightest this has ever been, and not because a
# rule got noisier: phase M shrank the total, so the two rules that were already read and found true
# now own a larger slice of it. Lowering the bound here would fail the build on a ruleset nobody has
# shown to be wrong. Left where phase L set it.
MAX_SINGLE_RULE_SHARE = 0.30

# Phase L started from a ruleset that was green on both budgets above while three quarters of what
# it said was wrong, so neither of them measures truth. This one is a proxy for it: `block_on`
# defaults to `critical`, so a critical finding is the one that stops a merge, and a false positive
# there costs more than anywhere else.
#
# It is a regression bound on the ratio, and the ratio has a second way to move: deleting a quiet
# non-critical rule raises it without any rule becoming noisier. That is exactly what phase M did —
# the share went 57% → 55% while the criticals behind it went **65 → 46**, so read the two together
# or the bound says the opposite of what happened. The failure message prints the absolute count for
# that reason: compare it against the 46 measured here before touching this constant.
MAX_CRITICAL_SHARE = 0.58


def _table(findings: tuple[Finding, ...], total: int) -> str:
    """Per-rule counts, worst first. This is the work list: the top row is the next rule to fix."""
    per_rule = Counter(f.rule_id for f in findings)
    example = {f.rule_id: f"{f.file}:{f.line}" for f in reversed(findings)}
    rows = [f"  {'rule':<34}{'count':>7}{'share':>8}   example"]
    rows += [
        f"  {rule_id:<34}{count:>7}{count / total:>7.0%}   {example[rule_id]}"
        for rule_id, count in per_rule.most_common()
    ]
    return "\n".join(rows)


@pytest.mark.skipif(corpus_root() is None, reason="no corpus: set SMITH_CORPUS to a real checkout")
def test_the_ruleset_stays_under_its_precision_budget() -> None:
    corpus = scan()
    findings = corpus.findings

    rate = len(findings) * 1000 / corpus.total_lines
    per_rule = Counter(f.rule_id for f in findings)
    top_rule, top_count = per_rule.most_common(1)[0] if per_rule else ("", 0)
    share = top_count / len(findings) if findings else 0.0
    critical = sum(1 for f in findings if f.severity == "critical")
    critical_share = critical / len(findings) if findings else 0.0

    report = (
        f"{len(corpus.files)} files, {corpus.total_lines} lines, {len(findings)} findings "
        f"— {rate:.2f} per 1000 lines, {critical} critical ({critical_share:.0%})\n"
        + _table(findings, len(findings) or 1)
    )

    # Printed on success too: this test is a measurement before it is a gate, and re-reading the
    # number is `pytest -k precision -s` rather than editing an assertion to make it fail.
    print(f"\n{report}")

    assert rate <= MAX_FINDINGS_PER_1000_LINES, (
        f"the ruleset is too noisy for real code: {rate:.1f} findings per 1000 lines, "
        f"budget is {MAX_FINDINGS_PER_1000_LINES}\n\n{report}"
    )
    assert share <= MAX_SINGLE_RULE_SHARE, (
        f"`{top_rule}` alone is {share:.0%} of every finding, budget is "
        f"{MAX_SINGLE_RULE_SHARE:.0%} — one rule flooding the review is a bug in that rule\n\n"
        f"{report}"
    )
    assert critical_share <= MAX_CRITICAL_SHARE, (
        f"{critical} of {len(findings)} findings are `critical` ({critical_share:.0%}), budget is "
        f"{MAX_CRITICAL_SHARE:.0%} — a critical finding blocks a merge, so it is where being wrong "
        f"costs most. 46 criticals were measured here on 2026-08-22: if that count has not grown, "
        f"the share moved because a non-critical rule was deleted and this bound is what needs "
        f"re-deriving.\n\n{report}"
    )
