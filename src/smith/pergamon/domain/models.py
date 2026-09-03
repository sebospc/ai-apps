"""Catalog domain: what an entry is, and what makes one well formed. Pure — no I/O, no framework."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

# An id travels in a URL path and is what a file is named after, so it is narrower than a title.
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")

MAX_TITLE = 200
MAX_ABOUT = 4000

# What an entry must carry to be an entry at all. The rest of the format is the entries' business,
# settled by writing them; keeping this list short is what lets U2 shape the format from real ones.
REQUIRED = ("id", "title", "about")


class CatalogError(Exception):
    """An entry cannot be read. The message names what is wrong, never a stack trace."""


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    title: str
    about: str
    # Everything past the three fields above, as written. The server does not interpret it: an
    # entry is instructions for an agent, and the agent is the one that reads them.
    detail: dict[str, Any] = field(default_factory=dict)

    def summary(self) -> dict:
        """What the list call returns. Small enough that an agent reads the whole catalog to match
        a developer's words against it."""
        return {"id": self.id, "title": self.title, "about": self.about}

    def to_dict(self) -> dict:
        return self.summary() | {"detail": self.detail}


def entry_from_mapping(raw: Any) -> CatalogEntry:
    """Build an entry from parsed YAML, or raise `CatalogError` saying why it is not one."""
    if not isinstance(raw, Mapping):
        raise CatalogError("an entry must be a mapping of fields")

    missing = [f for f in REQUIRED if not _text(raw.get(f))]
    if missing:
        raise CatalogError(f"missing or empty: {', '.join(missing)}")

    entry_id = _text(raw["id"])
    if not _ID.match(entry_id):
        raise CatalogError(f"id {entry_id!r} is not a slug: lowercase letters, digits and hyphens")

    title = _text(raw["title"])
    about = _text(raw["about"])
    if len(title) > MAX_TITLE:
        raise CatalogError(f"title is longer than {MAX_TITLE} characters")
    if len(about) > MAX_ABOUT:
        raise CatalogError(f"about is longer than {MAX_ABOUT} characters")

    detail = {str(k): v for k, v in raw.items() if k not in REQUIRED}
    return CatalogEntry(id=entry_id, title=title, about=about, detail=detail)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
