"""Fixtures shared by more than one test module."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from smith.auth.domain import Principal
from smith.auth.postgres import SqlProjectRepository
from smith.container import Container
from smith.db import Base
from smith.main import create_app
from smith.reviewer.domain.models import ReviewConfig
from smith.settings import Settings

LEAD_PASSWORD = "correct-horse-battery"


@pytest.fixture()
def client(tmp_path) -> tuple[TestClient, str]:
    settings = Settings(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'smith.db'}",
        secret_key="test-secret",
        rules_dir="rules",
    )
    app = create_app(settings)
    container: Container = app.state.container
    # Built from the metadata, not from the migrations: revisions are written for postgres and
    # sqlite cannot replay them. `tests/test_migrations.py` is what proves the revisions work.
    Base.metadata.create_all(container.engine)

    with container.transaction() as (session, services):
        user = services.auth.register("lead@co.com", "Lead", LEAD_PASSWORD)
        projects = SqlProjectRepository(session)
        project = projects.create("acme", "Acme", ReviewConfig().to_dict())
        projects.add_member(user.id, project.id, "lead")
        raw, _ = services.auth.issue_key(
            Principal(user_id=user.id, email=user.email, via="session"), "acme", "test"
        )
    return TestClient(app), raw
