"""PMD analyzer. Ported from the previous reviewer, minus the git checkout it used to need.

The server has no repository, so PMD runs over the changed files the plugin sent, materialized into
a throwaway directory. Findings are filtered to added lines: PMD sees whole files and would
otherwise report pre-existing code the developer never touched.

If the `pmd` binary is not installed, this returns [] — a missing tool degrades the review, it
never fails it. Writing the client's files and turning their names into arguments is
`adapters/workspace.py`, shared with the other command-line analyzers.

What it runs is `rules/pmd-java.xml`, not PMD's `quickstart.xml`. That file says why, and the
short version is that quickstart put 244 findings in front of a developer where our whole ruleset
put 14, and blocked their merge on a missing log guard.

PMD's text names the defect and stops there, so the fix comes from `rules/pmd-fixes.json`, one
line per rule in the ruleset. That is rule content, which is why it lives beside the ruleset rather
than in this file, and a test fails on any rule the two files disagree about.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from smith.reviewer.adapters.workspace import match_path as _match_path
from smith.reviewer.adapters.workspace import one_per_line as _one_per_line
from smith.reviewer.adapters.workspace import quote_line as _quote_line
from smith.reviewer.adapters.workspace import materialize as _materialize
from smith.reviewer.adapters.workspace import safe_args as _safe_args
from smith.reviewer.domain.models import FileDiff, Finding

logger = logging.getLogger(__name__)

# PMD rule priority (1 = highest) -> our severity. Priority 2 is a warning, not a critical: the
# verdict blocks on critical, and PMD hands priority 2 to style rules, so mapping it up was what
# let a missing `if (LOG.isDebugEnabled())` block a merge.
_PMD_SEVERITY = {1: "critical", 2: "warning", 3: "warning", 4: "suggestion", 5: "nitpick"}
_RULESET = Path("rules/pmd-java.xml")
FIXES_FILENAME = "pmd-fixes.json"
_TIMEOUT_SECONDS = 120
_MAX_FILES = 300


class PmdAnalyzer:
    name = "pmd"

    def __init__(self, ruleset: str | Path = _RULESET, timeout: int = _TIMEOUT_SECONDS) -> None:
        # Absolute now, because `_run_pmd` runs with cwd set to the throwaway workspace and a
        # relative ruleset would resolve against that instead of against the server's directory.
        self._ruleset = str(Path(ruleset).resolve())
        self._fixes = load_fixes(Path(ruleset))
        self._timeout = timeout

    def run(
        self, diffs: list[FileDiff], files: dict[str, str], added: dict[str, set[int]]
    ) -> list[Finding]:
        java = {
            path: content
            for path, content in files.items()
            if path.endswith(".java") and path in added and added[path]
        }
        if not java:
            return []
        if not shutil.which("pmd"):
            logger.info("pmd not on PATH, skipping java analysis")
            return []

        workdir = tempfile.mkdtemp(prefix="smith-pmd-")
        try:
            written = _materialize(java, Path(workdir))
            if not written:
                return []
            raw = self._run_pmd(written, workdir)
            return _parse(raw, added, java, self._fixes) if raw else []
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _run_pmd(self, relative_paths: list[str], cwd: str) -> dict | None:
        args = _safe_args(relative_paths)
        if not args:
            return None
        try:
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell, paths neutralized above
                ["pmd", "check", "-d", *args, "-R", self._ruleset, "-f", "json", "--no-cache"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=self._timeout,
            )
        except (OSError, subprocess.TimeoutExpired):
            logger.exception("pmd run failed")
            return None
        # PMD exits 4 when it found violations — that is success, not an error.
        if proc.returncode not in (0, 4) and not proc.stdout.strip():
            logger.warning("pmd exited %s: %s", proc.returncode, proc.stderr[:400])
            return None
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            logger.warning("pmd produced no parsable JSON")
            return None


def load_fixes(ruleset: str | Path) -> dict[str, str]:
    """The one-line fix for each rule in the ruleset, read from its sibling `pmd-fixes.json`.

    Missing or unreadable, the review still happens and the findings only name the defect: a fix
    that cannot be loaded degrades the review the same way a missing binary does.
    """
    path = Path(ruleset).with_name(FIXES_FILENAME)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("no pmd fixes at %s, findings will name the defect only", path)
        return {}
    return {rule: str(fix) for rule, fix in loaded.items()}


def _parse(
    raw: dict, added: dict[str, set[int]], files: dict[str, str], fixes: dict[str, str]
) -> list[Finding]:
    findings: list[Finding] = []
    for entry in raw.get("files", []):
        path = _match_path(str(entry.get("filename", "")), added)
        if path is None:
            continue
        # Split once per file, not once per violation: PMD reports many findings per file.
        lines = files.get(path, "").splitlines()
        for violation in entry.get("violations", []):
            line = violation.get("beginline")
            if not isinstance(line, int) or line not in added.get(path, set()):
                continue
            rule = str(violation.get("rule", "unknown"))
            findings.append(
                Finding(
                    file=path,
                    line=line,
                    severity=_PMD_SEVERITY.get(violation.get("priority"), "warning"),  # type: ignore[arg-type]
                    rule_id=f"pmd:{rule}",
                    message=str(violation.get("description", "")).strip(),
                    source="pmd",
                    issue_type="bug",
                    suggestion=fixes.get(rule),
                    quoted_line=_quote_line(lines, line),
                )
            )
    return _one_per_line(findings)
