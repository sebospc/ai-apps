"""Pergamon's catalog: the two calls the plugin makes, and the seed that fills the table.

Runs on sqlite like the rest of the suite. `tests/test_migrations.py` is what proves the revision
this table arrives in works on postgres.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from smith.container import Container
from smith.pergamon.adapters.postgres import SqlCatalogStore
from smith.pergamon.adapters.yaml_catalog import YamlCatalogFiles
from smith.pergamon.domain.models import CatalogError, entry_from_mapping
from conftest import LEAD_PASSWORD

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "scripts" / "seed_catalog.py"

# The whole format past id, title and about. Every one of these earns its place by being used by
# at least two of the three entries; a field one entry wants goes in that entry's prose instead.
SECTIONS = ("ask", "build", "good", "integration")
INTEGRATION = ("extensions", "localextensions", "platform_extensions", "item_types", "written_against")

CRONJOB = """
id: scheduled-cronjob
title: A cronjob with its own configuration and a schedule
about: A CronJob type, its performable, and the ImpEx that creates the instance.
ask:
  - What is the job called?
build:
  - A type in items.xml extending CronJob.
"""

WIDGET = """
id: a-widget
title: Something else entirely
about: Second entry, so the list is a list.
"""


@pytest.fixture()
def seeded(client) -> tuple:
    """The fixture client plus two entries in its catalog, written through the store the API reads."""
    api, key = client
    container: Container = api.app.state.container
    with container.transaction() as (session, _):
        store = SqlCatalogStore(session)
        for text in (CRONJOB, WIDGET):
            store.upsert(_entry(text))
    return api, {"Authorization": f"Bearer {key}"}


def _entry(text: str):
    return entry_from_mapping(yaml.safe_load(text))


def test_the_list_carries_id_title_and_about_and_nothing_else(seeded) -> None:
    """An agent reads the whole catalog to match a developer's words against it, so the list stays
    small on purpose. A `detail` leaking in here is how it stops being readable at thirty entries."""
    api, auth = seeded
    body = api.get("/v1/catalog", headers=auth).json()

    # Title order, not insertion order: the same catalog reads the same way twice.
    assert [e["id"] for e in body["entries"]] == ["scheduled-cronjob", "a-widget"]
    assert all(set(e) == {"id", "title", "about"} for e in body["entries"])


def test_one_entry_comes_back_whole(seeded) -> None:
    api, auth = seeded
    body = api.get("/v1/catalog/scheduled-cronjob", headers=auth).json()

    assert body["title"] == "A cronjob with its own configuration and a schedule"
    assert body["detail"]["ask"] == ["What is the job called?"]
    assert body["detail"]["build"] == ["A type in items.xml extending CronJob."]


def test_an_id_nobody_wrote_is_a_404(seeded) -> None:
    api, auth = seeded
    assert api.get("/v1/catalog/no-such-feature", headers=auth).status_code == 404


def test_the_catalog_needs_a_key_and_says_the_same_thing_the_review_calls_say(seeded) -> None:
    """A plugin pointed at a revoked key must get one message from every endpoint, or the failure
    reads as an outage on one call and a credential problem on another."""
    api, _auth = seeded
    review_body = {"diff": "diff --git a/A.java b/A.java\n"}

    for headers in ({}, {"Authorization": "Bearer smk_deadbeef_nope"}):
        catalog = api.get("/v1/catalog", headers=headers)
        entry = api.get("/v1/catalog/scheduled-cronjob", headers=headers)
        review = api.post("/v1/reviews", headers=headers, json=review_body)

        assert catalog.status_code == entry.status_code == review.status_code == 401
        assert catalog.json()["detail"] == entry.json()["detail"] == review.json()["detail"]


def test_a_revoked_key_stops_reading_the_catalog(client) -> None:
    api, _key = client
    api.post("/auth/login", json={"email": "lead@co.com", "password": LEAD_PASSWORD})
    issued = api.post("/projects/acme/keys", json={"name": "temporary"}).json()
    auth = {"Authorization": f"Bearer {issued['key']}"}
    assert api.get("/v1/catalog", headers=auth).status_code == 200

    api.delete(f"/projects/acme/keys/{issued['id']}")

    assert api.get("/v1/catalog", headers=auth).status_code == 401


def test_an_entry_without_the_three_fields_is_refused_by_name(tmp_path) -> None:
    (tmp_path / "broken.yaml").write_text("id: half-written\ntitle: No about here\n")

    with pytest.raises(CatalogError) as exc:
        YamlCatalogFiles(tmp_path).load_all()

    assert "broken.yaml" in str(exc.value)
    assert "about" in str(exc.value)


def test_two_files_claiming_one_id_are_refused(tmp_path) -> None:
    """Without this the second file silently wins and the catalog quietly holds one entry fewer
    than the repository shows."""
    (tmp_path / "a.yaml").write_text(CRONJOB)
    (tmp_path / "b.yaml").write_text(CRONJOB)

    with pytest.raises(CatalogError) as exc:
        YamlCatalogFiles(tmp_path).load_all()

    assert "b.yaml" in str(exc.value) and "a.yaml" in str(exc.value)


def test_an_id_that_is_not_a_slug_is_refused(tmp_path) -> None:
    """The id lands in a URL path and names a file. Anything else is a trap, not an entry."""
    (tmp_path / "odd.yaml").write_text("id: Not A Slug\ntitle: T\nabout: A\n")

    with pytest.raises(CatalogError) as exc:
        YamlCatalogFiles(tmp_path).load_all()

    assert "odd.yaml" in str(exc.value)


def test_every_entry_in_this_repository_parses() -> None:
    """The files that ship are held to the same bar as the ones a test writes."""
    entries = YamlCatalogFiles(ROOT / "catalog").load_all()

    assert entries, "catalog/ is empty: the seed would load nothing"
    assert len({e.id for e in entries}) == len(entries)


def test_every_entry_in_this_repository_carries_the_whole_format() -> None:
    """The format settled by writing three real entries, held here rather than in the domain: the
    server does not interpret an entry, the agent does, and every entry that will exist is a file
    in this repository — so the suite is the only boundary that sees them all. Without this a
    fourth entry ships half written and an agent finds out mid-session."""
    for entry in YamlCatalogFiles(ROOT / "catalog").load_all():
        assert set(entry.detail) == set(SECTIONS), f"{entry.id}: expected exactly {SECTIONS}"

        for section in ("ask", "build", "good"):
            lines = entry.detail[section]
            assert isinstance(lines, list) and lines, f"{entry.id}: {section} is empty"
            # A line carrying ": " parses as a mapping, so it stays well formed to the loader and
            # arrives at the agent as nonsense. Quoting the line is the fix.
            assert all(isinstance(line, str) and line.strip() for line in lines), (
                f"{entry.id}: a {section} line is not text, quote the one holding a colon"
            )

        integration = entry.detail["integration"]
        assert isinstance(integration, dict), f"{entry.id}: integration is not a mapping"
        assert set(integration) == set(INTEGRATION), f"{entry.id}: expected exactly {INTEGRATION}"
        for fact in INTEGRATION[:-1]:
            assert isinstance(integration[fact], list), f"{entry.id}: integration.{fact} is not a list"
        # Spartacus is optional on purpose: a backend-only feature was written against no storefront
        # and would have to invent a version to satisfy a required field.
        assert integration["written_against"].get("sap_commerce"), f"{entry.id}: no platform version"


def test_seeding_twice_leaves_one_row_updated_and_a_broken_file_writes_nothing(tmp_path) -> None:
    """The three things the seed promises, proven against the script that ships rather than a
    re-implementation of it: idempotent, updating, and all-or-nothing."""
    database = tmp_path / "seed.db"
    _schema(f"sqlite+pysqlite:///{database}")
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    (catalog / "cronjob.yaml").write_text(CRONJOB)

    assert _seed(catalog, database).returncode == 0
    assert _seed(catalog, database).returncode == 0
    assert [e.id for e in _rows(database)] == ["scheduled-cronjob"]

    (catalog / "cronjob.yaml").write_text(CRONJOB.replace("A cronjob with", "A renamed cronjob with"))
    assert _seed(catalog, database).returncode == 0
    assert [e.title for e in _rows(database)] == ["A renamed cronjob with its own configuration and a schedule"]

    (catalog / "widget.yaml").write_text(WIDGET)
    # Named to sort after the valid file: a seed that writes each entry as it reads it would have
    # stored the widget by the time it reached this one, which is the half-load being guarded.
    (catalog / "z-broken.yaml").write_text("id: half-written\ntitle: No about here\n")
    failed = _seed(catalog, database)

    assert failed.returncode == 1
    assert "z-broken.yaml" in failed.stdout
    # The valid new file in the same load did not arrive: half a catalog is the failure this guards.
    assert [e.id for e in _rows(database)] == ["scheduled-cronjob"]


def test_an_entry_whose_file_was_deleted_stops_being_served(tmp_path) -> None:
    database = tmp_path / "prune.db"
    _schema(f"sqlite+pysqlite:///{database}")
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    (catalog / "cronjob.yaml").write_text(CRONJOB)
    (catalog / "widget.yaml").write_text(WIDGET)
    _seed(catalog, database)

    (catalog / "widget.yaml").unlink()
    removed = _seed(catalog, database)

    assert "removed a-widget" in removed.stdout
    assert [e.id for e in _rows(database)] == ["scheduled-cronjob"]


def _schema(url: str) -> None:
    from smith.db import Base, make_engine

    engine = make_engine(url)
    Base.metadata.create_all(engine)
    engine.dispose()


def _seed(catalog: Path, database: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SEED), "--catalog", str(catalog)],
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/bin:/bin",
            "SMITH_DATABASE_URL": f"sqlite+pysqlite:///{database}",
        },
    )


def _rows(database: Path) -> list:
    from smith.db import make_engine, make_session_factory, unit_of_work

    engine = make_engine(f"sqlite+pysqlite:///{database}")
    try:
        with unit_of_work(make_session_factory(engine)) as session:
            return SqlCatalogStore(session).all()
    finally:
        engine.dispose()
