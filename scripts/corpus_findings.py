"""Dump every finding a ruleset produces over the real corpus, as JSONL.

`tests/test_precision.py` measures how *much* the ruleset says. This prints *what* it says, so two
checkouts can be compared finding by finding — which is the only way to see what a deleted rule
stopped catching. The baseline in `tests/data/` is refreshed by the test that reads it
(`SMITH_REFRESH_BASELINE=1 uv run pytest -k baseline -s`) rather than from here, so the file and
the check that reads it can never be computed two different ways.

The rules and the engine come from `--tree` (a checkout of this repository, default: this one), the
files come from `--corpus`. Pointing `--tree` at an older checkout runs that day's ruleset over
today's corpus, so a diff of two runs is a diff of the rules and nothing else.

    uv run python scripts/corpus_findings.py > today.jsonl
    git archive <sha> | tar -x -C /tmp/old
    uv run python scripts/corpus_findings.py --tree /tmp/old > old.jsonl

This is a composition root, so it builds its adapters directly.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS = (
    "~/corpus/sap-commerce-project"
)

# Kept identical to `tests/test_precision.py`: the two numbers are compared against each other.
REVIEWED_EXTENSIONS = (".java", ".impex", ".properties", ".xml", ".js", ".ts")
NOT_HAND_WRITTEN = ("/gensrc/", "/target/", "/build/", "/node_modules/", ".min.js")


def corpus_files(root: Path) -> list[tuple[str, str]]:
    """(repo-relative path, content) for every reviewable file, in a fixed order."""
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
            continue
        if content.strip():
            files.append((path.relative_to(root).as_posix(), content))
    return files


def diff_of_whole_files(files: list[tuple[str, str]]) -> str:
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


def _load_tree(tree: Path) -> dict[str, object]:
    """Import the reviewer out of `tree` instead of the installed package."""
    sys.path.insert(0, str(tree / "src"))
    for name in [module for module in sys.modules if module.startswith("smith")]:
        del sys.modules[name]

    modules = {
        "yaml_rules": importlib.import_module("smith.reviewer.adapters.yaml_rules"),
        "diff": importlib.import_module("smith.reviewer.domain.diff"),
        "models": importlib.import_module("smith.reviewer.domain.models"),
        "rules": importlib.import_module("smith.reviewer.domain.rules"),
    }
    try:
        modules["suppression"] = importlib.import_module("smith.reviewer.domain.suppression")
    except ModuleNotFoundError:
        pass  # phase L3 added it; an older tree has no suppression stage to run
    return modules


def findings_of(tree: Path, files: list[tuple[str, str]]) -> list[object]:
    smith = _load_tree(tree)
    ruleset = smith["yaml_rules"].YamlRuleSource(tree / "rules").load("sap-commerce-base")

    diffs = smith["diff"].parse_unified_diff(diff_of_whole_files(files))
    added = smith["diff"].added_lines(diffs)
    ctx = smith["models"].RuleContext(
        diffs=diffs, added=added, files=dict(files), checks=ruleset.checks
    )
    # Analyzers stay out for the same reason `test_precision.py` leaves them out: they shell out to
    # binaries, so a number that moves with the machine is not a measurement of our rules.
    reported = smith["diff"].scope_to_diff(smith["rules"].run_rules(ctx, set()), added)
    if "suppression" in smith:
        reported = smith["suppression"].drop_unactionable(reported, ctx.files)
    return [f for f in reported if not getattr(f, "suppressed", False)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", type=Path, default=REPO, help="checkout the rules come from")
    parser.add_argument(
        "--corpus", type=Path, default=Path(os.environ.get("SMITH_CORPUS", DEFAULT_CORPUS))
    )
    args = parser.parse_args()

    corpus = args.corpus.expanduser()
    if not corpus.is_dir():
        parser.error(f"no corpus at {corpus}")

    files = corpus_files(corpus)
    findings = findings_of(args.tree.resolve(), files)

    total_lines = sum(len(content.splitlines()) for _, content in files)
    print(
        f"{args.tree}: {len(files)} files, {total_lines} lines, {len(findings)} findings",
        file=sys.stderr,
    )
    for finding in findings:
        print(
            json.dumps(
                {
                    "rule_id": finding.rule_id,
                    "file": finding.file,
                    "line": finding.line,
                    "severity": finding.severity,
                    "message": finding.message,
                }
            )
        )


if __name__ == "__main__":
    main()
