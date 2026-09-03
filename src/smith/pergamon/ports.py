"""Ports Pergamon needs. One, because the server only reads a catalog it does not generate from."""

from __future__ import annotations

from typing import Protocol

from smith.pergamon.domain.models import CatalogEntry


class CatalogStore(Protocol):
    def all(self) -> list[CatalogEntry]:
        """Every entry, ordered by title so the list reads the same way twice."""

    def by_id(self, entry_id: str) -> CatalogEntry | None: ...

    def upsert(self, entry: CatalogEntry) -> None:
        """Write the entry, replacing whatever stood under that id. Used by the seed script."""

    def delete_missing(self, keep_ids: list[str]) -> list[str]:
        """Drop entries no longer in the catalog files, returning what was dropped."""
