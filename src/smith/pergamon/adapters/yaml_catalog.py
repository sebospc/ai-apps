"""Catalog entries as they are authored: YAML files in the repository, loaded by the seed script.

No port declares this, because no service depends on it — the seed script is a composition root and
is the only caller. Unlike a ruleset, which degrades to nothing so one bad file cannot take a review
down, a bad entry file stops the whole load: half a catalog is worse than none, because nobody can
tell by looking which half arrived.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from smith.pergamon.domain.models import CatalogEntry, CatalogError, entry_from_mapping


class YamlCatalogFiles:
    def __init__(self, catalog_dir: str | Path) -> None:
        self._dir = Path(catalog_dir)

    def load_all(self) -> list[CatalogEntry]:
        """Every entry under the directory. Raises `CatalogError` naming the file that is wrong,
        before anything has been written anywhere."""
        entries: list[CatalogEntry] = []
        seen: dict[str, str] = {}
        for path in sorted(self._dir.glob("*.yaml")):
            entry = self._read(path)
            if entry.id in seen:
                raise CatalogError(f"{path.name}: id {entry.id!r} is already used by {seen[entry.id]}")
            seen[entry.id] = path.name
            entries.append(entry)
        return entries

    def _read(self, path: Path) -> CatalogEntry:
        try:
            raw = yaml.safe_load(path.read_text())
        except (yaml.YAMLError, OSError) as exc:
            raise CatalogError(f"{path.name}: not readable as YAML ({exc.__class__.__name__})") from exc
        try:
            return entry_from_mapping(raw)
        except CatalogError as exc:
            raise CatalogError(f"{path.name}: {exc}") from None
