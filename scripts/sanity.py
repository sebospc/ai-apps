#!/usr/bin/env python
"""What everything costs, and whether it still holds.

    uv run python scripts/sanity.py           one table, exit 0 while every budget holds
    uv run python scripts/sanity.py --json    the same numbers, for a script to read

A test says a thing works. This says how much it costs and whether it drifted, which is the half
that was missing: every phase since AA fixed something a green suite had been reporting as fine.
Budgets are deliberately loose. They exist to catch a command that grew by half in one phase, not to
argue about twenty tokens.

It needs no server, no corpus and no network. Anything it cannot measure it reports as unmeasured
rather than skipping, because a number that quietly disappears is how a regression hides.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
COMMANDS = ROOT / "plugin" / "commands"
RULES = ROOT / "rules"
FIXTURES = RULES / "fixtures"

# The command file is loaded whole on every invocation, so it is the floor under every review. It is
# also where the behaviour lives, which is why these are ceilings and not targets.
COMMAND_BUDGETS = {"smith-review": 5200, "smith-apply": 3600, "smith-update": 900}

# Four bytes to a token is the rough ratio for English prose. Every number here is a comparison
# against itself over time, never a billing figure.
def tokens(text: str) -> int:
    return round(len(text) / 4)


@dataclass
class Report:
    rows: list[dict] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    def measure(self, group: str, name: str, value: int, budget: int | None, unit: str = "") -> None:
        over = budget is not None and value > budget
        self.rows.append(
            {"group": group, "name": name, "value": value, "budget": budget, "unit": unit, "ok": not over}
        )
        if over:
            self.failures.append(f"{group} · {name}: {value}{unit} over its budget of {budget}{unit}")

    def unmeasured(self, group: str, name: str, why: str) -> None:
        """Something that could not be read. Reported, never silently dropped."""
        self.rows.append({"group": group, "name": name, "value": None, "ok": True, "why": why})

    def note(self, line: str) -> None:
        self.failures.append(f"  {line}")


def measure_commands(report: Report) -> None:
    for path in sorted(COMMANDS.glob("*.md")):
        report.measure("command", path.stem, tokens(path.read_text()), COMMAND_BUDGETS.get(path.stem), " tok")


def measure_ruleset(report: Report) -> None:
    try:
        base = yaml.safe_load((RULES / "sap-commerce-base.yaml").read_text()) or {}
    except (OSError, yaml.YAMLError) as exc:
        report.unmeasured("ruleset", "sap-commerce-base", f"could not be read: {exc}")
        return

    guidelines = base.get("rules") or []
    checks = base.get("checks") or []
    report.measure("ruleset", "guidelines", len(guidelines), None)
    report.measure("ruleset", "checks", len(checks), None)

    # A guideline with no scope is offered for every file in every change. That is how one about
    # Spring facades reached a jQuery file, so the budget is zero and stays zero.
    unscoped = [g["id"] for g in guidelines if not g.get("scope")]
    report.measure("ruleset", "guidelines with no scope", len(unscoped), 0)
    if unscoped:
        report.note(f"unscoped: {', '.join(unscoped)}")

    # `why` and `fix` are half of what a guideline costs in tokens and all of what makes its finding
    # worth reading. One missing is a finding the developer cannot act on.
    for name in ("why", "fix"):
        missing = [g["id"] for g in guidelines if not g.get(name)]
        report.measure("ruleset", f"guidelines with no {name}", len(missing), 0)
        if missing:
            report.note(f"no {name}: {', '.join(missing)}")

    measure_fixtures(report, checks)


def measure_fixtures(report: Report, checks: list[dict]) -> None:
    cases = sorted(p for p in FIXTURES.iterdir() if p.is_dir()) if FIXTURES.is_dir() else []
    report.measure("fixtures", "cases", len(cases), None)

    covered: set[str] = set()
    quiet = 0
    for case in cases:
        try:
            raw = json.loads((case / "expected.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        findings = raw if isinstance(raw, list) else raw.get("findings", [])
        if not findings:
            quiet += 1
        covered.update(f["rule_id"] for f in findings if f.get("rule_id"))

    # A quiet fixture is ordinary code that must produce nothing. Without them a ruleset can only be
    # shown to fire, never shown to stay silent, and silence is the whole product.
    report.measure("fixtures", "quiet cases", quiet, None)

    emitted = {c.get("rule_id") or c.get("id") for c in checks} - {None}
    uncovered = sorted(emitted - covered)
    report.measure("fixtures", "check ids with no fixture", len(uncovered), 0)
    if uncovered:
        report.note(f"no fixture: {', '.join(uncovered)}")


def measure_walks(report: Report) -> None:
    """A walk nobody can run has to read as zero, not as absence.

    Most walks build their repository from `SMITH_CORPUS`, so on a machine without one the whole
    functional layer silently did not exist — which is how three real defects in it went unseen.
    """
    source = (ROOT / "scripts" / "walk_skill.mjs").read_text()
    table = source[source.index("const WALKS = {") :]
    names = re.findall(r'^ {2}"?([a-z][a-z-]*)"?: \{$', table, re.MULTILINE)
    report.measure("walks", "defined", len(names), None)

    needs_corpus = []
    for name in names:
        # A name with a hyphen is quoted in the source, so both spellings have to be looked for.
        start = next(
            (table.index(form) for form in (f'"{name}": {{', f"{name}: {{") if form in table), None
        )
        if start is not None and "buildRepo(" in table[start : start + 1400]:
            needs_corpus.append(name)
    report.measure("walks", "need a corpus", len(needs_corpus), None)

    corpus = os.environ.get("SMITH_CORPUS")
    usable = bool(corpus and Path(corpus).is_dir())
    report.measure("walks", "runnable here", len(names) - (0 if usable else len(needs_corpus)), None)
    if not usable:
        report.unmeasured("walks", "corpus", "SMITH_CORPUS is unset or missing")


def measure_plan(report: Report) -> None:
    api = os.environ.get("SMITH_API_URL", "http://localhost:8099")
    key = os.environ.get("SMITH_SANITY_KEY")
    if not key:
        report.unmeasured("plan", "size", f"no SMITH_SANITY_KEY; start {api} and pass a key")
        return
    try:
        out = subprocess.run(
            ["node", str(ROOT / "plugin" / "bin" / "smith"), "plan"],
            cwd=os.environ.get("SMITH_SANITY_REPO", ROOT),
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "SMITH_URL": api, "SMITH_KEY": key},
        )
        plan = json.loads(out.stdout)
    except Exception as exc:  # a measurement that cannot run is a report, never a crash
        report.unmeasured("plan", "size", f"could not reach {api}: {str(exc)[:80]}")
        return

    report.measure("plan", "total", tokens(json.dumps(plan)), 3000, " tok")
    for name in ("guidelines", "instructions", "deterministic_findings"):
        report.measure("plan", name, tokens(json.dumps(plan.get(name))), None, " tok")


def render(report: Report) -> None:
    group = ""
    for row in report.rows:
        if row["group"] != group:
            group = row["group"]
            print(f"\n{group}")
        if row["value"] is None:
            print(f"  {'—':>8}  {row['name']:<32} not measured: {row['why']}")
            continue
        budget = "" if row["budget"] is None else f"  (budget {row['budget']}{row['unit']})"
        mark = " " if row["ok"] else "!"
        print(f"{mark} {row['value']:>8}{row['unit']}  {row['name']}{budget}")
    print()
    if report.failures:
        print(f"{len([f for f in report.failures if not f.startswith('  ')])} over budget:")
        for line in report.failures:
            print(f"  {line}")
    else:
        print("every budget holds")


def main() -> int:
    report = Report()
    measure_commands(report)
    measure_ruleset(report)
    measure_walks(report)
    measure_plan(report)

    if "--json" in sys.argv:
        print(json.dumps({"rows": report.rows, "failures": report.failures}, indent=2))
    else:
        render(report)
    return 1 if report.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
