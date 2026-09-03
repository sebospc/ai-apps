"""ESLint analyzer for the TypeScript half of a SAP Commerce storefront.

Ported from the previous reviewer, minus the git checkout: the server has no repository, so ESLint
runs over the files the plugin sent, materialized into a throwaway directory.

Two things it deliberately will not do. It never invents a ruleset — without the project's own
config there is nothing to lint against, and a guessed set of rules is noise wearing a rule's
authority. And it never fails a review: no binary, no config, or a crash all return [].
"""

from __future__ import annotations

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
    safe_args,
)
from smith.reviewer.domain.models import FileDiff, Finding

logger = logging.getLogger(__name__)

# ESLint severity: 2 = error, 1 = warning. Neither blocks by default; a lint rule is not a bug.
_SEVERITY = {2: "warning", 1: "suggestion"}
_SOURCES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
# A config the project sent with the change. `eslint.config.*` is flat config, `.eslintrc*` legacy.
_CONFIGS = ("eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts")
_LEGACY_CONFIG_PREFIX = ".eslintrc"
_TIMEOUT_SECONDS = 120


class EslintAnalyzer:
    name = "eslint"

    def __init__(self, timeout: int = _TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    def run(
        self, diffs: list[FileDiff], files: dict[str, str], added: dict[str, set[int]]
    ) -> list[Finding]:
        sources = {
            path: content
            for path, content in files.items()
            if path.endswith(_SOURCES) and added.get(path)
        }
        if not sources:
            return []
        config = {path: content for path, content in files.items() if _is_config(path)}
        if not config:
            logger.info("no eslint config in the change, skipping typescript analysis")
            return []
        if not shutil.which("eslint"):
            logger.info("eslint not on PATH, skipping typescript analysis")
            return []

        workdir = tempfile.mkdtemp(prefix="smith-eslint-")
        try:
            written = materialize(sources, Path(workdir))
            materialize(config, Path(workdir))
            if not written:
                return []
            raw = run_json(
                ["eslint", "--format", "json", *safe_args(written)], workdir, self._timeout
            )
            return parse_eslint(raw, added, sources) if isinstance(raw, list) else []
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def _is_config(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return name in _CONFIGS or name.startswith(_LEGACY_CONFIG_PREFIX)


def parse_eslint(
    raw: list, added: dict[str, set[int]], files: dict[str, str]
) -> list[Finding]:
    """ESLint `--format json` -> findings on added lines. Shape: [{filePath, messages: [...]}]."""
    findings: list[Finding] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        path = match_path(str(entry.get("filePath", "")), added)
        if path is None:
            continue
        lines = files.get(path, "").splitlines()
        for message in entry.get("messages", []):
            line = message.get("line")
            if not isinstance(line, int) or line not in added.get(path, set()):
                continue
            # A parse error is ESLint failing to read the file, not a problem with the code.
            if not message.get("ruleId"):
                continue
            findings.append(
                Finding(
                    file=path,
                    line=line,
                    severity=_SEVERITY.get(message.get("severity"), "suggestion"),  # type: ignore[arg-type]
                    rule_id=f"eslint:{message['ruleId']}",
                    message=str(message.get("message", "")).strip(),
                    source="eslint",
                    issue_type="style",
                    quoted_line=quote_line(lines, line),
                )
            )
    return one_per_line(findings)
