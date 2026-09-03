"""Running a command-line analyzer over files that came from outside.

Everything the plugin sends is untrusted: paths, contents, the lot. One place decides how a client's
file becomes a file on this machine and how its name becomes an argument, so a second analyzer
cannot get that wrong in a new way.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from smith.reviewer.domain.models import Finding

logger = logging.getLogger(__name__)

MAX_FILES = 300


def materialize(files: dict[str, str], root: Path) -> list[str]:
    """Write client-supplied files under *root*, refusing anything that escapes it.

    A path like `../../etc/cron.d/x` or an absolute path must never be written, and a symlinked
    parent must never be followed.
    """
    written: list[str] = []
    for path, content in list(files.items())[:MAX_FILES]:
        normalized = path.replace("\\", "/")
        if normalized.startswith("/") or ".." in Path(normalized).parts:
            logger.warning("refusing unsafe path from client: %r", path)
            continue
        target = (root / normalized).resolve()
        if not target.is_relative_to(root.resolve()):
            logger.warning("refusing path escaping the work dir: %r", path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", errors="replace")
        written.append(normalized)
    return written


def safe_args(paths: list[str]) -> list[str]:
    """Prefix with `./` so a filename starting with `-` is never parsed as a flag."""
    return [p if p.startswith("./") else f"./{p}" for p in paths]


def match_path(tool_path: str, added: dict[str, set[int]]) -> str | None:
    """Resolve an analyzer's path (often absolute) back to the path the diff used."""
    candidate = tool_path.replace("\\", "/")
    for path in added:
        if candidate.endswith(path):
            return path
    return None


def quote_line(lines: list[str], line: int | None) -> str | None:
    """The content of the line a finding points at, the way `rules.py` quotes one.

    A finding's identity is `(rule_id, file, quoted_line)`, so an analyzer that leaves this None
    gives every finding of one rule in one file the same fingerprint: answering one of them then
    suppresses all of them, quoting the developer on findings they never read.

    Nothing is invented for a line the file does not have — a stale report is not a licence to
    guess at content.
    """
    if not isinstance(line, int) or not 1 <= line <= len(lines):
        return None
    return lines[line - 1].strip()


def one_per_line(findings: list[Finding]) -> list[Finding]:
    """One row per (rule, file, line): what there is to fix, not how many ways a tool found it.

    PMD reports `PreserveStackTrace` twice on one `throw` when two catch blocks reach it, naming a
    different exception each time. That is one edit for the developer, and the two rows carry the
    same fingerprint, so answering one would speak for the other.
    """
    seen: set[tuple[str, str, int | None]] = set()
    unique: list[Finding] = []
    for finding in findings:
        key = (finding.rule_id, finding.file, finding.line)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return unique


def run_json(argv: list[str], cwd: str, timeout: int = 120) -> object | None:
    """Run an analyzer and parse its JSON. Any failure is None: a broken tool degrades a review,
    it never fails one."""
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell, paths neutralized by safe_args
            argv, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.exception("%s failed to run", argv[0])
        return None
    if not proc.stdout.strip():
        if proc.returncode != 0:
            logger.warning("%s exited %s: %s", argv[0], proc.returncode, proc.stderr[:400])
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        logger.warning("%s produced no parsable JSON", argv[0])
        return None
