"""Is this change worth opening a review at all?

A review costs a developer their attention, so a change that cannot plausibly carry a bug should
not ask for any. Pure: diffs in, a plain-language reason or None out.
"""

from __future__ import annotations

import re
from fnmatch import fnmatch

from smith.reviewer.domain.diff import iter_hunk_lines
from smith.reviewer.domain.models import FileDiff

# Above this many tokens, an added line is carrying enough to be wrong. Tokens are words, not
# whitespace-separated chunks: `db.password=Sup3rSecret!` is one chunk and three real tokens.
_SUBSTANTIAL_TOKENS = 3
_TOKEN = re.compile(r"\w+")


def is_trivial(diffs: list[FileDiff], ignore_paths: list[str]) -> str | None:
    """The reason this change needs no review, or None when it does.

    Precision over recall: a wrong "trivial" hides a real bug, so both tests are conservative —
    every file has to be ignorable, or every added line has to be too short to hold logic.
    """
    if not diffs:
        return "the diff changes no files"

    ignored = [d.path for d in diffs if _ignorable(d.path, ignore_paths)]
    if len(ignored) == len(diffs):
        return f"only documentation or generated files changed: {_listing(ignored)}"

    for diff in diffs:
        for hunk in diff.hunks:
            for _, text in iter_hunk_lines(hunk, "added"):
                if len(_TOKEN.findall(text)) > _SUBSTANTIAL_TOKENS:
                    return None
    return "nothing was added but blank lines and fragments too short to hold logic"


def _ignorable(path: str, ignore_paths: list[str]) -> bool:
    # ponytail: fnmatch on the path and on its basename, not a gitignore engine — no `**`, no
    # negation. Move to pathspec if a project ever needs to un-ignore a subtree.
    name = path.rsplit("/", 1)[-1]
    return any(fnmatch(path, p) or fnmatch(name, p) for p in ignore_paths)


def _listing(paths: list[str]) -> str:
    shown = sorted(paths)
    if len(shown) <= 3:
        return ", ".join(shown)
    return f"{', '.join(shown[:3])} and {len(shown) - 3} more"
