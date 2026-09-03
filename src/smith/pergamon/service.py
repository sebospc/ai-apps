"""Reading the catalog. There is no writing use case: entries are authored as files and seeded,
which is what "a person promotes a pattern" means in practice."""

from __future__ import annotations

from smith.pergamon.domain.models import CatalogEntry
from smith.pergamon.ports import CatalogStore


class UnknownEntry(Exception):
    """No entry under that id. The catalog carries no client anything, so saying so is safe."""


class CatalogService:
    def __init__(self, store: CatalogStore) -> None:
        self._store = store

    def entries(self) -> list[CatalogEntry]:
        return self._store.all()

    def entry(self, entry_id: str) -> CatalogEntry:
        found = self._store.by_id(entry_id.strip())
        if found is None:
            raise UnknownEntry("no such catalog entry")
        return found
