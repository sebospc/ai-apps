"""Alembic environment.

Every context's adapter module is imported for its side effect: a table only appears in
`Base.metadata` once the module declaring it has been imported, and autogenerate compares against
that metadata. Miss one and alembic will happily write a revision dropping every table it owns.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine

import smith.auth.postgres  # noqa: F401
import smith.pergamon.adapters.postgres  # noqa: F401
import smith.reviewer.adapters.postgres  # noqa: F401
from smith.db import Base
from smith.settings import Settings

target_metadata = Base.metadata


def run_migrations_online() -> None:
    url = context.config.get_main_option("sqlalchemy.url") or Settings().database_url
    engine = create_engine(url, future=True)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


# ponytail: online only. Offline (`--sql`) mode is scaffolding for a deployment process that does not
# exist yet; add it when someone actually needs to hand a DBA a .sql file.
run_migrations_online()
