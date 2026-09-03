"""The real-code corpus, scanned once for the tests that measure against it.

Two tests read this: `test_precision.py` bounds how *much* the ruleset says, `test_baseline.py`
pins *what* it says. They only mean anything together if they run over the same input — a rate that
looks fine on one file set and a floor pinned against another would let a rule be dropped and
re-measured in the same commit without either test noticing. So the scan lives here, cached, and
both import it.

The corpus is somebody's client code: it is read, never written, and nothing from it is ever quoted
into this repository. Paths, rule ids and counts leave this module; source lines do not.

Point `SMITH_CORPUS` at a checkout to run those tests. Without one they skip, so the suite still
runs on a machine that has no corpus.
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from smith.reviewer.adapters.pmd import PmdAnalyzer
from smith.reviewer.adapters.yaml_rules import YamlRuleSource
from smith.reviewer.domain.diff import added_lines, parse_unified_diff, scope_to_diff
from smith.reviewer.domain.models import Finding, RuleContext
from smith.reviewer.domain.rules import run_rules
from smith.reviewer.domain.suppression import drop_unactionable

RULES_DIR = Path(__file__).resolve().parent.parent / "rules"
DEFAULT_CORPUS = (
    "~/corpus/sap-commerce-project"
)

# What the rules actually target. Reading anything else would pad the line count with files no
# rule can fire on and flatter the rate for free.
REVIEWED_EXTENSIONS = (".java", ".impex", ".properties", ".xml", ".js", ".ts")

# The same ruleset `container.py` wires in, named here rather than left to the default so the
# measurement cannot end up reading a different one than the server runs.
PMD = PmdAnalyzer(ruleset=RULES_DIR / "pmd-java.xml")

# Machine-written code nobody diffs. SAP Commerce regenerates `gensrc` on every build, so a rule
# firing there is not a finding anyone can act on, and one minified bundle is a single 200kB line
# that would swamp the measurement on its own.
NOT_HAND_WRITTEN = ("/gensrc/", "/target/", "/build/", "/node_modules/", ".min.js")


@dataclass(frozen=True)
class CorpusScan:
    """One run of the whole ruleset over the whole corpus."""

    files: tuple[tuple[str, str], ...]
    total_lines: int
    findings: tuple[Finding, ...]


def corpus_root() -> Path | None:
    root = Path(os.environ.get("SMITH_CORPUS", DEFAULT_CORPUS)).expanduser()
    return root if root.is_dir() else None


def _corpus_files(root: Path) -> list[tuple[str, str]]:
    """(repo-relative path, content) for every reviewable file, in a fixed order.

    Until 2026-08-21 this read an evenly-spread sample of 80 files per extension. Measuring
    several sample sizes then showed the per-rule share swinging between 27% and 54% on an
    unchanged ruleset: with a few hundred files, whether the sample happens to catch a given
    team's message bundles decides which rule looks worst. That measures the sample. The whole
    corpus is 3471 files and costs about two seconds, so the sample was never buying anything.
    """
    reviewable: list[Path] = []
    for extension in REVIEWED_EXTENSIONS:
        reviewable.extend(
            sorted(
                path
                for path in root.rglob(f"*{extension}")
                if path.is_file() and not any(marker in str(path) for marker in NOT_HAND_WRITTEN)
            )
        )

    files: list[tuple[str, str]] = []
    for path in reviewable:
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # a binary or unreadable file is not something a developer sends for review
        if content.strip():
            files.append((path.relative_to(root).as_posix(), content))
    return files


def _diff_of_whole_files(files: list[tuple[str, str]]) -> str:
    """A unified diff that adds every file in full — the worst case the rules ever see."""
    chunks: list[str] = []
    for path, content in files:
        lines = content.splitlines()
        chunks.append(
            f"diff --git a/{path} b/{path}\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            f"+++ b/{path}\n"
            f"@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{line}\n" for line in lines)
        )
    return "".join(chunks)


@lru_cache(maxsize=1)
def scan() -> CorpusScan:
    """Every finding the ruleset reports over the corpus, computed once per test session."""
    root = corpus_root()
    assert root is not None, "scan() is only callable when there is a corpus"
    files = _corpus_files(root)
    assert files, f"{root} holds no reviewable files"

    ruleset = YamlRuleSource(RULES_DIR).load("sap-commerce-base")
    diffs = parse_unified_diff(_diff_of_whole_files(files))
    added = added_lines(diffs)
    ctx = RuleContext(diffs=diffs, added=added, files=dict(files), checks=ruleset.checks)
    # Analyzers are left out for the same reason the fixtures leave them out: they shell out to
    # binaries, so a number that moves with the machine is not a measurement of our rules. What
    # they add to a review is measured separately, over `java_slice()` below.
    reported = drop_unactionable(scope_to_diff(run_rules(ctx, set()), added), ctx.files)

    return CorpusScan(
        files=tuple(files),
        total_lines=sum(len(lines) for lines in added.values()),
        findings=tuple(f for f in reported if not f.suppressed),
    )


# The java slice the analyzer measurement runs on. Java-only because `pmd` is the only analyzer that
# reads java, and 150 files because that is what `pmd` covers in 1.7 seconds — the whole corpus is
# 1900 java files and would put a minute into every test run.
#
# Shuffled with a fixed seed rather than taken in path order: the corpus is laid out by extension,
# so the first 150 sorted paths are one team's code and would measure that team, not the codebase.
JAVA_SLICE_SIZE = 150
JAVA_SLICE_SEED = 20260822


@lru_cache(maxsize=1)
def java_slice() -> CorpusScan:
    """Rules *and* analyzers over a reproducible slice of the corpus, computed once per session.

    `scan()` deliberately leaves the analyzers out, so its number is a measurement of our rules and
    moves only when a rule moves. That is the right call for a rate we tune, and it left the
    developer's actual review — where pmd is most of what they read — unmeasured. This is the other
    half, kept separate so neither number can silently absorb the other.

    It reuses `scan()`'s file list for the reason that module exists: a second measurement that
    walks the corpus on its own would drift from the first the moment either filter changes.
    """
    java = sorted((path, content) for path, content in scan().files if path.endswith(".java"))
    random.Random(JAVA_SLICE_SEED).shuffle(java)
    files = java[:JAVA_SLICE_SIZE]
    assert files, "the corpus holds no java files"

    ruleset = YamlRuleSource(RULES_DIR).load("sap-commerce-base")
    diffs = parse_unified_diff(_diff_of_whole_files(files))
    added = added_lines(diffs)
    ctx = RuleContext(diffs=diffs, added=added, files=dict(files), checks=ruleset.checks)

    findings = run_rules(ctx, set())
    # Only pmd: the slice is java, and the other two analyzers read js/ts and would return [] here.
    findings.extend(PMD.run(diffs, ctx.files, added))
    reported = drop_unactionable(scope_to_diff(findings, added), ctx.files)

    return CorpusScan(
        files=tuple(files),
        total_lines=sum(len(lines) for lines in added.values()),
        findings=tuple(f for f in reported if not f.suppressed),
    )
