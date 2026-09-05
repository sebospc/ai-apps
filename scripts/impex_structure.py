"""Whether ImpEx files have a shape an import could read at all.

A composition root, so it may reach into the domain — and it reaches for the one ImpEx reader this
repository has rather than growing a second one beside it. The apply walk runs in Node and cannot
import Python, so it calls this.

    uv run python scripts/impex_structure.py <file> [<file> ...]

One problem per line as `path:line: what`, and exit 1 when there is any.
"""

from __future__ import annotations

import sys
from pathlib import Path

from smith.reviewer.domain.rules import parse_impex


def _filled(cells: tuple[str, ...]) -> int:
    """How many cells a row has once separators trailing off its end are ignored."""
    end = len(cells)
    while end and not cells[end - 1]:
        end -= 1
    return end


def _fills(header: tuple[str, ...], value: tuple[str, ...]) -> bool:
    """Whether a value line fills the header above it.

    Two counts are compared rather than one. A row written `;a;b;` and a header written `code;name`
    describe the same two columns, so trimming neither would call that row long; a row written `;a;`
    on the same header is a name deliberately left empty, so trimming both would call it short.
    Either agreement is enough, and a row missing a column agrees on neither.
    """
    return len(header) == len(value) or _filled(header) == _filled(value)


def problems(path: str, text: str) -> list[str]:
    header: tuple[str, ...] | None = None
    # Whether a header was seen at all, which is not the same question as whether its columns could
    # be counted: a header whose last cell leaves a quote open has no count, and saying "no header
    # above it" about the rows under it would name the wrong defect.
    opened = False
    found: list[str] = []
    for row in parse_impex(text):
        if row.mode:
            header = row.cells
            opened = True
            continue
        if not opened:
            found.append(
                f"{path}:{row.line}: a value line with no header above it — an ImpEx block opens "
                f"with INSERT_UPDATE, INSERT, UPDATE or REMOVE"
            )
            continue
        # A quoted cell left open spans lines, and nothing here joins them. Counting is declined
        # rather than guessed: a made-up number here is a red walk on correct ImpEx.
        if header is None or row.cells is None:
            continue
        if not _fills(header, row.cells):
            found.append(
                f"{path}:{row.line}: {len(row.cells)} values under a header of {len(header)} columns"
            )
    return found


def main(argv: list[str]) -> int:
    found = [
        problem
        for name in argv
        for problem in problems(name, Path(name).read_text(encoding="utf-8", errors="replace"))
    ]
    for problem in found:
        print(problem)
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
