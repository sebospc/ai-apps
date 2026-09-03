"""Load the catalog entries in `catalog/` into the table.

    uv run python scripts/seed_catalog.py

Idempotent: an entry already there is updated, and one whose file was deleted stops being served.
Every file is parsed before anything is written, so a broken entry leaves the catalog as it was
rather than half replaced.

This script is a composition root, so it is allowed to build adapters directly.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from smith.container import Container  # noqa: E402
from smith.pergamon.adapters.postgres import SqlCatalogStore  # noqa: E402
from smith.pergamon.adapters.yaml_catalog import YamlCatalogFiles  # noqa: E402
from smith.pergamon.domain.models import CatalogError  # noqa: E402
from smith.settings import Settings  # noqa: E402

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "catalog"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default=str(DEFAULT_DIR), help="directory of entry files")
    args = parser.parse_args()

    try:
        entries = YamlCatalogFiles(args.catalog).load_all()
    except CatalogError as exc:
        print(f"error: {exc}")
        return 1

    container = Container(Settings())
    with container.transaction() as (session, _services):
        store = SqlCatalogStore(session)
        for entry in entries:
            store.upsert(entry)
        removed = store.delete_missing([e.id for e in entries])

    for entry in entries:
        print(f"loaded {entry.id}")
    for entry_id in removed:
        print(f"removed {entry_id}, no longer in {args.catalog}")
    print(f"catalog holds {len(entries)} {'entry' if len(entries) == 1 else 'entries'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
