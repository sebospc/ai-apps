"""Unified-diff parsing and diff scoping. Ported from the previous reviewer, unchanged in behaviour."""

from __future__ import annotations

import re
from typing import TypeVar

from smith.reviewer.domain.models import FileDiff, Finding, Hunk

T = TypeVar("T")

_DIFF_HEADER = re.compile(r"^diff --git a/.+ b/(.+)$")
_HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_unified_diff(diff_text: str) -> list[FileDiff]:
    files: list[FileDiff] = []
    current_file: FileDiff | None = None
    current_hunk: Hunk | None = None
    hunk_lines: list[str] = []

    def flush_hunk() -> None:
        nonlocal current_hunk, hunk_lines
        if current_hunk is not None and current_file is not None:
            current_hunk.content = "\n".join(hunk_lines)
            current_file.hunks.append(current_hunk)
        current_hunk = None
        hunk_lines = []

    for line in diff_text.splitlines():
        header = _DIFF_HEADER.match(line)
        if header:
            flush_hunk()
            if current_file is not None:
                files.append(current_file)
            current_file = FileDiff(path=header.group(1), status="modified")
            continue

        if current_file is None:
            continue

        if line.startswith("new file mode"):
            current_file.status = "added"
            continue
        if line.startswith("deleted file mode"):
            current_file.status = "deleted"
            continue
        if line.startswith("+++ b/"):
            current_file.path = line[6:]
            continue
        if line == "+++ /dev/null":
            current_file.status = "deleted"
            continue
        if line == "--- /dev/null":
            current_file.status = "added"
            continue

        hunk = _HUNK_HEADER.match(line)
        if hunk:
            flush_hunk()
            current_hunk = Hunk(
                old_start=int(hunk.group(1)),
                old_lines=int(hunk.group(2)) if hunk.group(2) is not None else 1,
                new_start=int(hunk.group(3)),
                new_lines=int(hunk.group(4)) if hunk.group(4) is not None else 1,
                content="",
            )
            hunk_lines = [line]
            continue

        if current_hunk is not None:
            hunk_lines.append(line)

    flush_hunk()
    if current_file is not None:
        files.append(current_file)
    return files


def iter_hunk_lines(hunk: Hunk, mode: str = "added") -> list[tuple[int, str]]:
    """(line_number, text) pairs from one hunk. `mode` picks the new side, the old side, or both."""
    out: list[tuple[int, str]] = []
    current = hunk.new_start if mode != "removed" else hunk.old_start
    for raw in hunk.content.splitlines():
        if raw.startswith(("@@", "+++", "---")):
            continue
        if raw.startswith("+"):
            if mode in ("added", "any"):
                out.append((current, raw[1:]))
            if mode != "removed":
                current += 1
            continue
        if raw.startswith("-"):
            if mode == "removed":
                out.append((current, raw[1:]))
                current += 1
            continue
        # context line: present on both sides
        if mode == "any":
            out.append((current, raw[1:] if raw else raw))
        current += 1
    return out


def added_lines(diffs: list[FileDiff]) -> dict[str, set[int]]:
    """Each changed file path -> the set of its added (new-side) line numbers."""
    return {
        d.path: {n for h in d.hunks for n, _ in iter_hunk_lines(h, "added")}
        for d in diffs
    }


def lookup_by_path(file: str, by_path: dict[str, T]) -> T | None:
    """Value keyed by *file*: exact match, else a suffix match either way, else None.

    An analyzer reports `src/Foo.java` where the diff calls it `core/src/Foo.java`, and the plugin
    keys the file map however the developer's checkout is rooted. Every stage that has to line a
    finding up with a path goes through here so they all agree.
    """
    if file in by_path:
        return by_path[file]
    for path, value in by_path.items():
        if path.endswith("/" + file) or file.endswith("/" + path):
            return value
    return None


def scope_to_diff(findings: list[Finding], added: dict[str, set[int]]) -> list[Finding]:
    """Suppress findings that point at code the developer did not touch.

    A finding on a pre-existing line of a merely-touched file is noise — it is not this review's
    problem. A finding in a file outside the diff is kept: that is real cross-file impact.
    """
    out: list[Finding] = []
    for f in findings:
        lines = lookup_by_path(f.file or "", added)
        if lines is None or (f.line and f.line in lines):
            out.append(f)
            continue
        out.append(f.suppress("outside the diff's changed lines (pre-existing code)"))
    return out
