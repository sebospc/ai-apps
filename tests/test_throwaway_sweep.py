"""The sweep that removes the projects a killed run left behind, against real rows.

`scripts/lib/throwaway_project.mjs` deletes projects from a database somebody else's work also
lives in, so the only reading worth having is one where a real row disappears and the rows next to
it do not. It runs against postgres on a scratch database and skips when postgres is down, like the
migrations check.

The lookalikes are the point. `walk-mtnr8srh` is the exact shape of the 13 projects the leak
produced, and the sweep must leave it alone: what makes a project ours to delete is the name this
convention gives it, not a resemblance.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

from smith.auth.postgres import SqlProjectRepository
from smith.container import Container
from smith.db import Base
from smith.main import create_app
from smith.reviewer.domain.models import ReviewConfig
from smith.settings import Settings

SCRATCH_DATABASE = "smith_throwaway_sweep"
SWEEP = Path(__file__).resolve().parent.parent / "scripts" / "lib" / "throwaway_project.mjs"

LEAD_EMAIL = "sweep-lead@smith.test"
LEAD_PASSWORD = "correct-horse-battery"

HOUR_MS = 60 * 60 * 1000


def _slug(kind: str, created_ms: int) -> str:
    return f"throwaway-{kind}-{_base36(created_ms)}"


def _base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        value, rest = divmod(value, 36)
        out = digits[rest] + out
    return out or "0"


def _scratch_container() -> Container:
    url = make_url(Settings().database_url)
    if not url.get_backend_name().startswith("postgresql"):
        pytest.skip("the sweep deletes rows, so it is only proved against postgres")

    engine = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DATABASE}" WITH (FORCE)'))
            connection.execute(text(f'CREATE DATABASE "{SCRATCH_DATABASE}"'))
    except OperationalError as exc:
        pytest.skip(f"postgres unreachable: {exc}")
    finally:
        engine.dispose()

    scratch = url.set(database=SCRATCH_DATABASE).render_as_string(hide_password=False)
    container = Container(
        Settings(database_url=scratch, secret_key="test-secret", rules_dir="rules")
    )
    Base.metadata.create_all(container.engine)
    return container


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_the_sweep_removes_only_the_projects_a_run_abandoned() -> None:
    if shutil.which("node") is None:
        pytest.skip("the sweep is a node script and node is not installed")

    container = _scratch_container()
    now_ms = int(time.time() * 1000)
    # Two shapes a run produces: a plain name, and the one `review_score.mjs` builds out of a case.
    gone = [
        _slug("rehearse", now_ms - 3 * HOUR_MS),
        _slug("score-first-reading", now_ms - 3 * HOUR_MS),
    ]
    survivors = [
        _slug("rehearse", now_ms - 60_000),  # this run's own project, minutes old
        "throwaway-notes",  # the prefix, and nothing that says when it was made
        "walk-mtnr8srh",  # what the leak produced: a name the sweep must not guess at
        "throwaway-rehearse-0000zzzz",  # the shape, reading as 1970
        "throwaway-my-team-checkout",  # eight base36 characters that are a word, reading as 2003
    ]

    with container.transaction() as (session, services):
        user = services.auth.register(LEAD_EMAIL, "Sweep", LEAD_PASSWORD)
        projects = SqlProjectRepository(session)
        for slug in [*gone, *survivors]:
            project = projects.create(slug, slug, ReviewConfig().to_dict())
            projects.add_member(user.id, project.id, "lead")

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(container.settings), host="127.0.0.1", port=port, log_level="error"
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.time() + 30
        while not server.started and thread.is_alive() and time.time() < deadline:
            time.sleep(0.05)
        assert server.started, "the API under test never came up"

        done = subprocess.run(
            [
                "node",
                str(SWEEP),
                "--api",
                f"http://127.0.0.1:{port}",
                "--email",
                LEAD_EMAIL,
                "--password",
                LEAD_PASSWORD,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert done.returncode == 0, f"the sweep failed: {done.stderr}"
    finally:
        server.should_exit = True
        thread.join(timeout=30)

    with container.engine.connect() as connection:
        left = {row[0] for row in connection.execute(text("select slug from projects"))}

    left_behind = sorted(set(gone) & left)
    assert not left_behind, (
        "the sweep left behind projects an earlier run abandoned: " + ", ".join(left_behind)
    )
    removed_by_mistake = sorted(set(survivors) - left)
    assert not removed_by_mistake, (
        "the sweep deleted projects it did not create: " + ", ".join(removed_by_mistake)
    )
