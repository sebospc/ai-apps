"""The migrations, proven against the database they were written for.

The rest of the suite builds its schema from the metadata on sqlite, which says nothing about
whether the revisions run. This is the check that they do. It skips when postgres is unreachable so
the suite stays green on a machine without it; `scripts/ensure_db.sh` is what makes it run.
"""

from __future__ import annotations

import pytest
from alembic import command
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import OperationalError

from smith.migrations import alembic_config
from smith.settings import Settings

SCRATCH_DATABASE = "smith_migrations_check"


def _scratch_database() -> URL:
    """An empty database to upgrade from zero. Never the real one: this drops what it finds."""
    url = make_url(Settings().database_url)
    if not url.get_backend_name().startswith("postgresql"):
        pytest.skip("migrations target postgres")

    engine = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DATABASE}"'))
            connection.execute(text(f'CREATE DATABASE "{SCRATCH_DATABASE}"'))
    except OperationalError as exc:
        pytest.skip(f"postgres unreachable: {exc}")
    finally:
        engine.dispose()

    return url.set(database=SCRATCH_DATABASE)


def test_migrations_build_the_schema_and_stay_in_step_with_the_models() -> None:
    url = _scratch_database()
    config = alembic_config(url.render_as_string(hide_password=False))

    command.upgrade(config, "head")

    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            for table in (
                "users",
                "projects",
                "memberships",
                "api_keys",
                "reviews",
                "findings",
                "catalog_entries",
            ):
                connection.execute(text(f"SELECT 1 FROM {table}"))
    finally:
        engine.dispose()

    # Fails when a model changed without a revision to match — the failure mode migrations exist
    # to prevent.
    command.check(config)
