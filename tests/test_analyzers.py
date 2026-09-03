"""The command-line analyzers: what they make of a tool's output, and what they do without it.

The parsers are pure and are tested against the JSON each tool really emits. The runners are tested
for the case that matters most in practice — the binary is not installed — because a review on a
machine without ESLint has to be a quieter review, never a failed one.
"""

from __future__ import annotations

import shutil
from dataclasses import replace
from pathlib import Path
from xml.etree import ElementTree

import pytest

from smith.reviewer.adapters.depcruise import DependencyCruiserAnalyzer, parse_depcruise
from smith.reviewer.adapters.eslint import EslintAnalyzer, parse_eslint
from smith.reviewer.adapters.pmd import load_fixes
from smith.reviewer.adapters.workspace import materialize, safe_args
from smith.reviewer.domain.diff import added_lines, parse_unified_diff
from smith.reviewer.domain.findings import apply_dispositions, fingerprint
from smith.reviewer.domain.models import ActiveDisposition

RULES_DIR = Path(__file__).resolve().parent.parent / "rules"

TS_DIFF = """\
diff --git a/src/app/order.service.ts b/src/app/order.service.ts
--- a/src/app/order.service.ts
+++ b/src/app/order.service.ts
@@ -1,2 +1,4 @@
 import { Injectable } from "@angular/core";
+import { CartService } from "./cart.service";
+
 export class OrderService {}
"""


TS_FILES = {
    "src/app/order.service.ts": 'import { Injectable } from "@angular/core";\n'
    'import { CartService } from "./cart.service";\n'
    "\n"
    "export class OrderService {}\n",
}


def _added() -> dict[str, set[int]]:
    return added_lines(parse_unified_diff(TS_DIFF))


def test_a_circular_import_becomes_one_finding_anchored_on_a_changed_line() -> None:
    added = _added()
    raw = {
        "summary": {
            "violations": [
                {
                    "from": "/tmp/smith-depcruise-x/src/app/order.service.ts",
                    "to": "src/app/cart.service.ts",
                    "rule": {"name": "no-circular", "severity": "error"},
                    "cycle": [
                        {"name": "src/app/cart.service.ts"},
                        {"name": "src/app/order.service.ts"},
                    ],
                }
            ]
        }
    }

    findings = parse_depcruise(raw, added, TS_FILES)
    assert len(findings) == 1
    assert findings[0].rule_id == "depcruise:no-circular"
    assert findings[0].file == "src/app/order.service.ts"
    # A module-level problem has no line of its own, so it lands on the first line the change added.
    assert findings[0].line == min(added["src/app/order.service.ts"])
    assert "cart.service" in findings[0].message
    assert findings[0].source == "depcruise"


def test_a_violation_in_a_module_the_change_did_not_touch_is_dropped() -> None:
    raw = {
        "summary": {
            "violations": [
                {
                    "from": "src/app/untouched.ts",
                    "to": "src/app/other.ts",
                    "rule": {"name": "no-circular", "severity": "error"},
                }
            ]
        }
    }
    assert parse_depcruise(raw, _added(), TS_FILES) == []


def test_eslint_output_becomes_findings_only_on_added_lines() -> None:
    added = _added()
    raw = [
        {
            "filePath": "/tmp/smith-eslint-x/src/app/order.service.ts",
            "messages": [
                {"line": 2, "severity": 2, "ruleId": "no-unused-vars", "message": "unused import"},
                {"line": 99, "severity": 2, "ruleId": "no-shadow", "message": "untouched line"},
                # A parse failure carries no ruleId: ESLint could not read the file, which says
                # nothing about the code.
                {"line": 2, "severity": 2, "ruleId": None, "message": "Parsing error"},
            ],
        }
    ]

    findings = parse_eslint(raw, added, TS_FILES)
    assert [(f.rule_id, f.line, f.severity) for f in findings] == [
        ("eslint:no-unused-vars", 2, "warning")
    ]


def test_the_analyzers_are_silent_without_their_binaries(monkeypatch) -> None:
    diffs = parse_unified_diff(TS_DIFF)
    added = _added()
    files = {
        "src/app/order.service.ts": 'import { CartService } from "./cart.service";',
        "src/app/cart.service.ts": 'import { OrderService } from "./order.service";',
        "eslint.config.js": "export default [];",
    }
    monkeypatch.setattr(shutil, "which", lambda _: None)

    assert EslintAnalyzer().run(diffs, files, added) == []
    assert DependencyCruiserAnalyzer().run(diffs, files, added) == []


def test_eslint_says_nothing_without_the_project_s_own_config() -> None:
    """Without a config there are no rules, and inventing some would be noise with authority."""
    diffs = parse_unified_diff(TS_DIFF)
    files = {"src/app/order.service.ts": "export class OrderService {}"}
    assert EslintAnalyzer().run(diffs, files, _added()) == []


# The cycle has to be between values, not types: dependency-cruiser reads the graph as it survives
# compilation, and TypeScript erases an import that only a type annotation used. A type-only cycle
# is not a cycle at runtime, and reporting one would be the analyzer crying wolf.
CYCLE_FILES = {
    "src/app/order.service.ts": (
        'import { CartService } from "./cart.service";\n'
        "export class OrderService {\n"
        "  total() { return new CartService().value(); }\n"
        "}\n"
    ),
    "src/app/cart.service.ts": (
        'import { OrderService } from "./order.service";\n'
        "export class CartService {\n"
        "  value() { return new OrderService(); }\n"
        "}\n"
    ),
}


@pytest.mark.skipif(shutil.which("depcruise") is None, reason="dependency-cruiser is not installed")
def test_dependency_cruiser_really_finds_the_cycle() -> None:
    """The parser is tested against captured output; this proves the wiring against the real tool."""
    diffs = parse_unified_diff(TS_DIFF)
    findings = DependencyCruiserAnalyzer().run(diffs, CYCLE_FILES, _added())
    assert [f.rule_id for f in findings] == ["depcruise:no-circular"]
    # The change touched only order.service.ts, and dependency-cruiser reports the cycle from
    # whichever module it reached first. The finding still lands on the changed one.
    assert findings[0].file == "src/app/order.service.ts"
    assert "cart.service" in findings[0].message


@pytest.mark.skipif(shutil.which("depcruise") is None, reason="dependency-cruiser is not installed")
def test_dependency_cruiser_is_silent_once_the_cycle_is_broken() -> None:
    """The same two modules, with the back edge removed: a real tool run that must find nothing."""
    diffs = parse_unified_diff(TS_DIFF)
    files = {
        **CYCLE_FILES,
        "src/app/cart.service.ts": "export class CartService {\n  value() { return 1; }\n}\n",
    }
    assert DependencyCruiserAnalyzer().run(diffs, files, _added()) == []


def test_a_client_path_can_never_escape_the_work_directory(tmp_path) -> None:
    written = materialize(
        {
            "src/app/ok.ts": "export const ok = 1;",
            "../../etc/cron.d/evil": "* * * * * root rm -rf /",
            "/etc/passwd": "root:x:0:0",
        },
        tmp_path,
    )
    assert written == ["src/app/ok.ts"]
    assert [p.name for p in tmp_path.rglob("*") if p.is_file()] == ["ok.ts"]
    # A filename starting with a dash must reach the tool as a path, never as a flag.
    assert safe_args(["-Rmalicious.ts"]) == ["./-Rmalicious.ts"]


CART_CONTENT = """\
export class Cart {
  private readonly total = 0;
  private readonly subtotal = 0;
  private readonly tax = 0;
"""

CART_DIFF = """\
diff --git a/src/app/cart.ts b/src/app/cart.ts
--- a/src/app/cart.ts
+++ b/src/app/cart.ts
@@ -1,1 +1,4 @@
 export class Cart {
+  private readonly total = 0;
+  private readonly subtotal = 0;
+  private readonly tax = 0;
"""


def test_dismissing_one_analyzer_finding_leaves_the_other_two_reported() -> None:
    """A finding's identity is the offending line's content, and an analyzer that leaves that
    empty makes every finding of one rule in one file literally the same finding.

    Reproduced against postgres on review 259 before this test existed: a developer dismissed one
    `pmd:GuardLogStatement`, six disappeared, and the five they never answered carried a
    suppression quoting them as having ruled it out.
    """
    added = added_lines(parse_unified_diff(CART_DIFF))
    files = {"src/app/cart.ts": CART_CONTENT}
    raw = [
        {
            "filePath": "/tmp/smith-eslint-x/src/app/cart.ts",
            "messages": [
                {"line": line, "severity": 2, "ruleId": "no-unused-vars", "message": "unused"}
                for line in (2, 3, 4)
            ],
        }
    ]

    findings = [
        replace(f, fingerprint=fingerprint(f.rule_id, f.file, f.quoted_line))
        for f in parse_eslint(raw, added, files)
    ]
    assert len({f.fingerprint for f in findings}) == 3, (
        "three problems on three different lines are three findings, not one"
    )

    answered = {
        findings[0].fingerprint: ActiveDisposition(
            fingerprint=findings[0].fingerprint,
            disposition="dismissed",
            reason="that one is on purpose",
            email="dev@example.com",
            at="2026-08-22",
        )
    }
    suppressed = [f for f in apply_dispositions(findings, answered) if f.suppressed]

    assert [f.line for f in suppressed] == [2], (
        "answering one finding must never speak for the ones the developer left alone"
    )


def _ruleset_rules() -> set[str]:
    """The rule names `pmd-java.xml` references, e.g. `CloseResource`."""
    root = ElementTree.parse(RULES_DIR / "pmd-java.xml").getroot()
    return {
        str(rule.get("ref", "")).rsplit("/", 1)[-1]
        for rule in root.iter("{http://pmd.sourceforge.net/ruleset/2.0.0}rule")
    }


def test_every_pmd_rule_names_the_fix_it_wants() -> None:
    """PMD says what is wrong and never what to type, so the ruleset and its fixes move together.

    Without this a rule can be added to `pmd-java.xml` and reach a developer as a defect with no
    change attached — the shape of finding they have to go and ask someone about.
    """
    fixes = load_fixes(RULES_DIR / "pmd-java.xml")
    missing = sorted(_ruleset_rules() - set(fixes))
    assert not missing, (
        f"these rules fire with no fix behind them, add one line each to rules/pmd-fixes.json: "
        f"{missing}"
    )
    assert all(fix.strip() for fix in fixes.values()), (
        f"empty fixes in rules/pmd-fixes.json: "
        f"{sorted(rule for rule, fix in fixes.items() if not fix.strip())}"
    )


def test_no_pmd_fix_describes_a_rule_the_ruleset_dropped() -> None:
    """The same map read backwards, so a deleted rule cannot leave its fix behind to rot."""
    orphans = sorted(set(load_fixes(RULES_DIR / "pmd-java.xml")) - _ruleset_rules())
    assert not orphans, f"rules/pmd-fixes.json names rules pmd-java.xml no longer runs: {orphans}"
