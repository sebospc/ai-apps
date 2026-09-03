"""SQLAlchemy plumbing shared by every bounded context in this process.

Each context owns its own tables and its own repositories; they share only this engine/metadata
because they share one database today. Splitting a context out means pointing it at its own URL.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def make_engine(url: str):
    engine = create_engine(url, pool_pre_ping=True, future=True)

    if engine.dialect.name == "sqlite":
        # Tests run on sqlite for speed, and sqlite ignores foreign keys unless asked. Without this,
        # every `ondelete="CASCADE"` in the schema is inert under test and only discovered in
        # production. Postgres needs no equivalent — it always enforces them.
        @event.listens_for(engine, "connect")
        def _enforce_foreign_keys(connection, _record):  # pragma: no cover - driver callback
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


def make_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


@contextmanager
def unit_of_work(factory: sessionmaker[Session]) -> Iterator[Session]:
    """One transaction per use case: commit on success, roll back on any exception."""
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
