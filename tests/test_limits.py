"""What the server does when a caller sends more than a review can be.

Every case here was a measurement before it was a test. The numbers in the comments are what the
current code does, taken from a run against this suite and, for the concurrency case, against real
postgres — sqlite serialises writes on its own and would call the bug fixed without proving
anything.
"""

from __future__ import annotations

import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

from smith.auth.domain import Principal
from smith.auth.postgres import SqlProjectRepository
from smith.container import Container
from smith.db import Base
from smith.reviewer.adapters.postgres import SqlReviewStore
from smith.reviewer.adapters.workspace import run_json
from smith.reviewer.domain.models import Finding, ReviewConfig
from smith.settings import Settings

SCRATCH_DATABASE = "smith_limits_check"

# Four tokens on the line, so triage does not write it off as too short to hold logic, and 34 bytes
# each, so 10,000 of them stay under the per-file ceiling the plugin and the API both enforce.
ORDINARY_LINE = "    service.doThing(order, index);"

# Trips `no-system-out` once per line. The point of the case: a file in this state produced 10,000
# findings and a 4.1 MB response before the cap, and re-served all of it on every read.
FLOODING_LINE = '        System.out.println("order " + code);'


def _diff(path: str, line: str, count: int) -> str:
    return (
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
        f"@@ -1,0 +1,{count} @@\n" + f"+{line}\n" * count
    )


def test_a_request_too_large_to_be_a_review_is_refused_on_its_headers(client) -> None:
    """The body is never read: the refusal comes from Content-Length alone.

    A tiny body with a huge declared length is the proof. If the server had to read the body to
    decide, this request would be accepted — instead it costs a header parse.
    """
    api, key = client
    refused = api.post(
        "/v1/reviews",
        headers={"Authorization": f"Bearer {key}", "content-length": "30000000"},
        json={"diff": "x"},
    )
    assert refused.status_code == 413, refused.text
    assert refused.json()["detail"] == (
        "this request is too large to be a code review (30.0 MB, and the limit is 25.0 MB) "
        "— review a smaller change"
    )


def test_a_body_with_no_measurable_size_is_refused_rather_than_read(client) -> None:
    """Chunked is the way around a Content-Length check, so it is closed rather than trusted."""
    api, key = client
    refused = api.post(
        "/v1/reviews",
        headers={"Authorization": f"Bearer {key}", "transfer-encoding": "chunked"},
        json={"diff": "x"},
    )
    assert refused.status_code == 411, refused.text
    assert "Content-Length" in refused.json()["detail"]


def test_a_fifty_megabyte_diff_is_refused_and_creates_nothing(client) -> None:
    api, key = client
    auth = {"Authorization": f"Bearer {key}"}
    refused = api.post("/v1/reviews", headers=auth, json={"diff": "+// filler\n" * 5_000_000})

    assert refused.status_code == 413, refused.status_code
    assert "too large" in refused.json()["detail"]
    # Nothing half-written: the request never reached the reviewer at all.
    assert api.get("/v1/reviews/1", headers=auth).status_code == 422


def test_too_many_files_is_refused_in_one_sentence_instead_of_the_request_itself(client) -> None:
    """FastAPI's default quotes the offending input back, so a 45 kB request drew a 43.6 kB
    refusal — 96% of what was sent, and the plugin discards a structured detail anyway."""
    api, key = client
    files = [{"path": f"src/F{i}.java", "content": "class A {}\n"} for i in range(500)]
    refused = api.post(
        "/v1/reviews",
        headers={"Authorization": f"Bearer {key}"},
        json={"diff": _diff("src/F0.java", ORDINARY_LINE, 2), "files": files},
    )

    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"] == (
        "files: list should have at most 400 items after validation, not 500"
    )
    assert len(refused.content) < 200, "a refusal must not carry a copy of what it refused"


def test_a_ten_thousand_line_file_is_reviewed_and_stays_bounded(client) -> None:
    api, key = client
    auth = {"Authorization": f"Bearer {key}"}
    content = "public class Huge {\n" + f"{ORDINARY_LINE}\n" * 10_000 + "}\n"

    started = time.monotonic()
    plan = api.post(
        "/v1/reviews",
        headers=auth,
        json={
            "diff": _diff("src/Huge.java", ORDINARY_LINE, 10_000),
            "files": [{"path": "src/Huge.java", "content": content}],
        },
    )
    elapsed = time.monotonic() - started

    assert plan.status_code == 201, plan.text
    # Measured at 0.06s. The bound is loose on purpose: this fails on a rule that went quadratic,
    # not on a slow machine.
    assert elapsed < 10, f"a 10,000-line file took {elapsed:.1f}s"
    assert len(plan.json()["deterministic_findings"]) <= 200


def test_a_file_that_trips_a_rule_on_every_line_is_capped_and_says_so(client) -> None:
    """10,000 findings help nobody, and the response, the rows and every later read grow with the
    list. The cap keeps the worst of them and the agent is told what was cut."""
    api, key = client
    auth = {"Authorization": f"Bearer {key}"}
    plan = api.post(
        "/v1/reviews", headers=auth, json={"diff": _diff("src/Flood.java", FLOODING_LINE, 10_000)}
    )

    assert plan.status_code == 201, plan.text
    body = plan.json()
    assert len(body["deterministic_findings"]) == 200
    assert len(plan.content) < 400_000, "the capped response was 4.1 MB before the cap"

    # The developer hears about it, in the one text the agent reads on every review.
    assert "9800 finding(s) beyond the ones below were dropped" in body["instructions"]
    assert "`no-system-out` in `src/Flood.java`" in body["instructions"]

    # And the review keeps its shape when it is read back, not just when it is created.
    reread = api.get(f"/v1/reviews/{body['review_id']}", headers=auth)
    assert reread.status_code == 200
    assert len(reread.json()["findings"]) == 200


def test_the_cap_keeps_the_severe_findings_and_drops_the_nitpicks() -> None:
    """A cap that dropped a critical to keep a nitpick would be worse than no cap."""
    from smith.reviewer.service import _cap

    nitpicks = [
        Finding(
            file="a.java", line=i, severity="nitpick", rule_id="n", message="m", source="rules"
        )
        for i in range(50)
    ]
    critical = Finding(
        file="a.java", line=99, severity="critical", rule_id="c", message="m", source="rules"
    )
    kept, dropped = _cap([*nitpicks, critical], limit=10)

    assert critical in kept
    assert len(kept) == 10 and len(dropped) == 41


def test_under_the_cap_nothing_is_reordered() -> None:
    """The number a developer points at is the position in this list, so it may not move for free."""
    from smith.reviewer.service import _cap

    findings = [
        Finding(file="a.java", line=i, severity=s, rule_id="r", message="m", source="rules")
        for i, s in enumerate(["nitpick", "critical", "warning"])
    ]
    kept, dropped = _cap(findings, limit=10)

    assert kept == findings and dropped == []


def test_an_analyzer_that_hangs_is_cut_off_rather_than_waited_on() -> None:
    """The contract every analyzer shares: a tool that does not answer degrades the review."""
    started = time.monotonic()
    result = run_json(["sleep", "30"], cwd="/tmp", timeout=1)
    elapsed = time.monotonic() - started

    assert result is None
    assert elapsed < 10, f"a hung analyzer held the review for {elapsed:.1f}s"


def test_a_review_still_completes_when_an_analyzer_times_out(client, monkeypatch) -> None:
    api, key = client
    container: Container = api.app.state.container

    class HangingAnalyzer:
        name = "hangs"

        def run(self, diffs, files, added):
            raise subprocess.TimeoutExpired(cmd="pmd", timeout=1)

    monkeypatch.setattr(container, "_analyzers", [HangingAnalyzer()])
    plan = api.post(
        "/v1/reviews",
        headers={"Authorization": f"Bearer {key}"},
        json={"diff": _diff("src/Flood.java", FLOODING_LINE, 3)},
    )

    assert plan.status_code == 201, plan.text
    # The deterministic rules still ran: one broken tool costs its own findings and nothing else.
    assert len(plan.json()["deterministic_findings"]) == 3


# --------------------------------------------------------------------------------------------------
# Concurrency, on the database that has to survive it
# --------------------------------------------------------------------------------------------------


def _postgres_container() -> Container:
    """A container on a scratch database. Skips when postgres is down, like the migrations check."""
    url = make_url(Settings().database_url)
    if not url.get_backend_name().startswith("postgresql"):
        pytest.skip("this case is about postgres row locking")

    engine = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with engine.connect() as connection:
            connection.execute(
                text(f'DROP DATABASE IF EXISTS "{SCRATCH_DATABASE}" WITH (FORCE)')
            )
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


def test_two_submits_of_one_review_at_once_leave_one_set_of_findings() -> None:
    """Both callers read the review before either wrote it, and both wrote.

    Measured before the row lock: the review ended up holding 4 agent findings when each call
    submitted 2, and two steps sharing sequence number 2 — findings nobody submitted together and a
    verdict computed from neither half. The window is short, so the race is run several times: one
    round missing it proves nothing, and the corruption showed up in most rounds.
    """
    container = _postgres_container()
    with container.transaction() as (session, services):
        user = services.auth.register("lead@co.com", "Lead", "correct-horse-battery")
        projects = SqlProjectRepository(session)
        project = projects.create("acme", "Acme", ReviewConfig().to_dict())
        projects.add_member(user.id, project.id, "lead")
        raw, _ = services.auth.issue_key(
            Principal(user_id=user.id, email=user.email, via="session"), "acme", "test"
        )
    with container.transaction() as (_, services):
        principal = services.auth.authenticate_key(raw)

    for round_number in range(8):
        with container.transaction() as (_, services):
            review_id = services.reviewer.plan(
                principal, _diff(f"src/R{round_number}.java", FLOODING_LINE, 3), {}
            ).review_id
        _race_two_submits(container, principal, review_id)

        with container.transaction() as (session, _):
            store = SqlReviewStore(session)
            agent_findings = [f for f in store.findings(review_id) if f.source == "agent"]
            detail = store.detail(review_id)

        # One submit wins whole. Replacing the agent's findings has to mean replacing them.
        assert len(agent_findings) == 2, [f.rule_id for f in agent_findings]
        assert len({f.rule_id for f in agent_findings}) == 1, "both submissions survived"

        sequences = [step.seq for step in detail.steps]
        assert len(sequences) == len(set(sequences)), f"the audit trail collided: {sequences}"
        assert detail.summary.status == "completed"


def _race_two_submits(container: Container, principal: Principal, review_id: int) -> None:
    """Two submits released at the same instant, each from a transaction that is already open.

    Reading the review before the barrier matters: a transaction that has issued no statement holds
    no connection yet, so without it the barrier would release both threads before either had a
    database to race on.
    """
    both_inside = threading.Barrier(2)
    failures: list[str] = []

    def submit(who: str) -> None:
        findings = [
            Finding(
                file=f"src/R{review_id}.java",
                line=line,
                severity="warning",
                rule_id=f"agent-{who}",
                message=f"from {who}",
                source="agent",
                issue_type="bug",
            )
            for line in (1, 2)
        ]
        try:
            with container.transaction() as (_, services):
                services.reviewer.review_detail(principal, review_id)
                both_inside.wait(timeout=30)
                services.reviewer.submit(principal, review_id, findings)
        except Exception as exc:  # a lost race is a result, not a crash
            failures.append(f"{who}: {type(exc).__name__}: {exc}")

    racers = [threading.Thread(target=submit, args=(who,)) for who in ("A", "B")]
    for thread in racers:
        thread.start()
    for thread in racers:
        thread.join(timeout=60)
    assert not failures, failures
