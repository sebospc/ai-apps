"""dependency-cruiser: circular imports between the TypeScript modules a change touched.

A cycle is a real architecture smell that no line-by-line rule can see, and it is the one thing
worth running a module-graph tool for. The bundled ruleset is exactly that one rule; a project that
ships its own `.dependency-cruiser.*` gets its own boundary rules instead.

The tool needs the module graph, and the server only has the files the plugin sent. Anything it
cannot resolve is simply not part of the graph, so an unresolvable import produces no finding rather
than a guess — which is the direction to be wrong in.

`depcruise` parses `.ts` only when `typescript` resolves from its own install directory, and only
below TypeScript 7. Without it the files still cruise, as modules with no dependencies at all, so
the analyzer goes quiet on a codebase full of cycles instead of failing. README says how to install
the pair; there is nothing to check for here that would not be a guess about someone's machine.
"""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
from pathlib import Path

from smith.reviewer.adapters.workspace import (
    match_path,
    materialize,
    one_per_line,
    quote_line,
    run_json,
)
from smith.reviewer.domain.models import FileDiff, Finding

logger = logging.getLogger(__name__)

_SEVERITY = {"error": "warning", "warn": "suggestion", "info": "nitpick"}
_SOURCES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
_CONFIG_PREFIX = ".dependency-cruiser"
_BUNDLED_CONFIG = json.dumps(
    {"forbidden": [{"name": "no-circular", "severity": "error", "from": {}, "to": {"circular": True}}]}
)
_TIMEOUT_SECONDS = 120


class DependencyCruiserAnalyzer:
    name = "depcruise"

    def __init__(self, timeout: int = _TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    def run(
        self, diffs: list[FileDiff], files: dict[str, str], added: dict[str, set[int]]
    ) -> list[Finding]:
        sources = {
            path: content for path, content in files.items() if path.endswith(_SOURCES)
        }
        # A cycle needs at least two modules present; one file can never demonstrate one.
        if len(sources) < 2 or not any(added.get(path) for path in sources):
            return []
        if not shutil.which("depcruise"):
            logger.info("depcruise not on PATH, skipping module graph analysis")
            return []

        workdir = tempfile.mkdtemp(prefix="smith-depcruise-")
        try:
            written = materialize(sources, Path(workdir))
            if not written:
                return []
            config = self._config(files, Path(workdir))
            raw = run_json(
                ["depcruise", "--config", config, "--output-type", "json", "."],
                workdir,
                self._timeout,
            )
            return parse_depcruise(raw, added, sources) if isinstance(raw, dict) else []
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _config(self, files: dict[str, str], root: Path) -> str:
        """The project's own ruleset when it sent one, otherwise the single bundled rule."""
        own = {path: content for path, content in files.items() if _is_config(path)}
        if own:
            written = materialize(own, root)
            if written:
                return written[0]
        path = root / ".dependency-cruiser.json"
        path.write_text(_BUNDLED_CONFIG, encoding="utf-8")
        return path.name


def _is_config(path: str) -> bool:
    return path.rsplit("/", 1)[-1].startswith(_CONFIG_PREFIX)


def _steps(violation: dict) -> list[str]:
    """Every module the violation names, `from` first, each one once."""
    steps = [str(violation.get("from", ""))]
    for step in violation.get("cycle") or []:
        name = str(step.get("name", step) if isinstance(step, dict) else step)
        if name not in steps:
            steps.append(name)
    return steps


def _anchor(steps: list[str], added: dict[str, set[int]]) -> tuple[str, str] | None:
    """The changed module that carries the finding, and the cycle read starting from it.

    depcruise reports a cycle once, from whichever module it happened to reach first, which is not
    the one the change touched half of the time. Anchoring on any member the change added lines to
    is what makes a cycle reportable from either end of it.
    """
    for index, step in enumerate(steps):
        path = match_path(step, added)
        if path and added.get(path):
            return path, " → ".join(steps[index + 1 :] + steps[:index])
    return None


def parse_depcruise(
    raw: dict, added: dict[str, set[int]], files: dict[str, str]
) -> list[Finding]:
    """`--output-type json` -> one finding per violation, anchored on the first line the change
    added to the offending module: a module-level problem has no line of its own."""
    findings: list[Finding] = []
    for violation in (raw.get("summary") or {}).get("violations", []):
        anchored = _anchor(_steps(violation), added)
        if anchored is None:
            continue
        path, via = anchored
        line = min(added[path])
        rule = violation.get("rule") or {}
        via = via or str(violation.get("to", ""))
        findings.append(
            Finding(
                file=path,
                line=line,
                severity=_SEVERITY.get(str(rule.get("severity")), "suggestion"),  # type: ignore[arg-type]
                rule_id=f"depcruise:{rule.get('name', 'boundary')}",
                message=f"{rule.get('name', 'boundary violation')}: {path} → {via}".strip(),
                source="depcruise",
                issue_type="logic",
                quoted_line=quote_line(files.get(path, "").splitlines(), line),
            )
        )
    return one_per_line(findings)
