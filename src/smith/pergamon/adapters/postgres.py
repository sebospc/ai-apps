"""Postgres adapter for Pergamon: one table, and the store that reads it.

One table, because the server records nothing about a generation — no commissions, no answers, no
generated code. What happens in a session stays in the developer's editor and in their git history.
"""

from __future__ import annotations

from sqlalchemy import JSON, String, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from smith.db import Base
from smith.pergamon.domain.models import MAX_TITLE, CatalogEntry


class CatalogEntryRow(Base):
    __tablename__ = "catalog_entries"

    # The slug is the identity a developer's agent asks for, so it is the key rather than a serial
    # with a unique index beside it.
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    title: Mapped[str] = mapped_column(String(MAX_TITLE))
    about: Mapped[str] = mapped_column(Text)
    # The rest of the entry, as authored. Shape belongs to the entries, not to the schema: adding a
    # field to the format must not need a migration.
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


class SqlCatalogStore:
    def __init__(self, session: Session) -> None:
        self._s = session

    def all(self) -> list[CatalogEntry]:
        rows = self._s.scalars(select(CatalogEntryRow).order_by(CatalogEntryRow.title)).all()
        return [_entry(r) for r in rows]

    def by_id(self, entry_id: str) -> CatalogEntry | None:
        row = self._s.get(CatalogEntryRow, entry_id)
        return _entry(row) if row is not None else None

    def upsert(self, entry: CatalogEntry) -> None:
        row = self._s.get(CatalogEntryRow, entry.id)
        if row is None:
            self._s.add(
                CatalogEntryRow(
                    id=entry.id, title=entry.title, about=entry.about, detail=entry.detail
                )
            )
            return
        row.title = entry.title
        row.about = entry.about
        row.detail = entry.detail

    def delete_missing(self, keep_ids: list[str]) -> list[str]:
        """The catalog is what the files say. An entry deleted from the repository stops being
        served, rather than lingering because it was seeded once."""
        stale = [r for r in self._s.scalars(select(CatalogEntryRow)).all() if r.id not in keep_ids]
        for row in stale:
            self._s.delete(row)
        return [row.id for row in stale]


def _entry(row: CatalogEntryRow) -> CatalogEntry:
    return CatalogEntry(id=row.id, title=row.title, about=row.about, detail=dict(row.detail or {}))
