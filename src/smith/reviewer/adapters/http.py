"""HTTP adapter for the reviewer. The plugin calls plan, submit and respond; the UI configures."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi import Response as HttpResponse
from pydantic import BaseModel, Field, field_validator

from smith.auth.domain import AuthError, Forbidden, Principal
from smith.auth.http import bearer_key, get_services, session_user
from smith.container import Services
from smith.reviewer.domain.models import (
    MAX_REVIEWER_PROMPT,
    ActiveDisposition,
    Finding,
    Policy,
    ReviewConfig,
)
from smith.reviewer.service import Response, ReviewError, ReviewPlan, ReviewSkipped

_MAX_FILES = 400
_MAX_FILE_CHARS = 400_000
# Enough of a line to identify it; the plugin trims to the same number before sending.
_MAX_QUOTED_LINE = 500


class SourceFile(BaseModel):
    path: str = Field(max_length=1000)
    content: str = Field(max_length=_MAX_FILE_CHARS)


class PlanRequest(BaseModel):
    diff: str = Field(min_length=1)
    branch: str = Field(default="", max_length=255)
    title: str = Field(default="", max_length=500)
    # Full post-change contents of the changed files. Needed by whole-file analyzers (PMD) and by
    # rules that must see beyond the hunk, e.g. a duplicate .properties key. Optional: without them
    # the review still runs, with fewer deterministic findings.
    files: list[SourceFile] = Field(default_factory=list, max_length=_MAX_FILES)
    # Detected by the plugin from the repository's manifest. Digits and dots only: it is untrusted
    # input that ends up compared against rule bounds, and nothing else is a version.
    platform_version: str = Field(default="", max_length=40, pattern=r"^$|^[0-9]+(\.[0-9]+)*$")


class AgentFinding(BaseModel):
    file: str = Field(max_length=1000)
    line: int | None = Field(default=None, ge=1)
    severity: Literal["critical", "warning", "suggestion", "nitpick"] = "warning"
    rule_id: str = Field(default="agent", max_length=200)
    message: str = Field(min_length=1, max_length=4000)
    issue_type: str = Field(default="bug", max_length=30)
    suggestion: str | None = Field(default=None, max_length=4000)
    # The offending line as the plugin read it in the working tree. It is what separates two
    # findings of one rule in one file, and without it answering either one answers both.
    quoted_line: str | None = Field(default=None, max_length=_MAX_QUOTED_LINE)

    @field_validator("rule_id")
    @classmethod
    def _named_rule(cls, value: str) -> str:
        """The default only covers the field being absent; an agent that writes `"rule_id": ""`
        would otherwise store a finding whose identity is a file and an empty string."""
        return value.strip() or "agent"


class SubmitRequest(BaseModel):
    findings: list[AgentFinding] = Field(default_factory=list, max_length=500)


class ReviewRequest(PlanRequest):
    """`/v2`: the change and the agent's findings in one call, because no review exists yet.

    It carries the diff a second time on purpose. The server re-runs the deterministic half over
    it rather than trusting a plan handed back by the plugin, so what is stored is always what the
    server found.
    """

    findings: list[AgentFinding] = Field(default_factory=list, max_length=500)


class ResponseItem(BaseModel):
    # A number is what the developer sees in the review; a fingerprint is what the agent keeps when
    # the conversation resumed in a new session. Both point at the same finding.
    finding: int | str
    disposition: Literal["fixed", "dismissed", "accepted"]
    note: str = Field(default="", max_length=2000)


class RespondRequest(BaseModel):
    responses: list[ResponseItem] = Field(default_factory=list, max_length=200)


class PolicyBody(BaseModel):
    block_on: Literal["critical", "warning", "suggestion", "nitpick"] = "critical"
    max_agent_findings: int = Field(default=50, ge=1, le=500)


class ConfigBody(BaseModel):
    ruleset: str = Field(default="sap-commerce-base", max_length=100)
    policy: PolicyBody = Field(default_factory=PolicyBody)
    disabled_rules: list[str] = Field(default_factory=list, max_length=1000)
    conventions: str = Field(default="", max_length=20_000)
    reviewer_prompt: str = Field(default="", max_length=MAX_REVIEWER_PROMPT)


def plugin_principal(
    request: Request,
    key: Annotated[str, Depends(bearer_key)],
    svc: Annotated[Services, Depends(get_services)],
) -> Principal:
    """Authenticate the plugin's API key. The project it may touch comes from the key, never the body."""
    try:
        actor = svc.auth.authenticate_key(key)
    except AuthError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid API key") from None
    # The one family of routes whose URL does not name the project. Everywhere else the request
    # log reads it off the path.
    request.state.project_id = actor.project_id
    return actor


def build_router() -> APIRouter:
    # `/v1` is the plugin's contract and is versioned because a plugin in the wild cannot be
    # upgraded in lockstep with the server. The web UI reads unversioned routes: it ships with the
    # server, so there is nothing to keep compatible.
    router = APIRouter(tags=["reviewer"])

    @router.post("/v2/reviews")
    def plan_only(
        body: PlanRequest,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        """The plan, and nothing written. 200, not 201: this call creates nothing.

        No `review_id` comes back because there is no review — a session cancelled here leaves the
        database exactly as it found it. The findings arrive at `/v2/reviews/findings` with the
        diff they were reasoned about, and that is what opens a review.
        """
        files = {f.path: f.content for f in body.files}
        try:
            plan = _guard(
                lambda: svc.reviewer.plan(actor, body.diff, files, body.platform_version)
            )
        except ReviewSkipped as exc:
            return {"skipped": True, "reason": str(exc)}
        return _plan_json(plan, actor)

    @router.post("/v2/reviews/findings", status_code=status.HTTP_201_CREATED)
    def review_change(
        body: ReviewRequest,
        request: Request,
        response: HttpResponse,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        files = {f.path: f.content for f in body.files}
        try:
            review_id, verdict, shown = _guard(
                lambda: svc.reviewer.create_review(
                    actor,
                    body.diff,
                    files,
                    _agent_findings(body.findings),
                    body.branch,
                    body.title,
                    body.platform_version,
                )
            )
        except ReviewSkipped as exc:
            response.status_code = status.HTTP_200_OK
            return {"skipped": True, "reason": str(exc)}
        request.state.review_id = review_id
        return {
            "review_id": review_id,
            "blocking": verdict.blocking,
            "reason": verdict.reason,
            "counts": verdict.counts,
            # What the review actually holds, numbered. The agent reports these rather than its own
            # merge of the plan and what it sent: the server drops findings off the diff and mutes
            # answered ones, and a number `respond` reads differently from the one the developer was
            # shown files their reason against a finding they never argued with.
            "findings": _numbered(shown),
        }

    @router.post("/v1/reviews", status_code=status.HTTP_201_CREATED)
    def plan_review(
        body: PlanRequest,
        request: Request,
        response: HttpResponse,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        files = {f.path: f.content for f in body.files}
        try:
            plan = _guard(
                lambda: svc.reviewer.plan_v1(
                    actor, body.diff, files, body.branch, body.title, body.platform_version
                )
            )
        except ReviewSkipped as exc:
            # 200, not an error and not 201: nothing was created and nothing went wrong.
            response.status_code = status.HTTP_200_OK
            return {"skipped": True, "reason": str(exc)}
        request.state.review_id = plan.review_id
        return {"review_id": plan.review_id} | _plan_json(plan, actor)

    @router.get("/v1/reviews/{review_id}")
    def read_review(
        review_id: int,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        """The review as the agent last saw it, for a conversation that resumed without its plan."""
        detail = _guard(lambda: svc.reviewer.review_detail(actor, review_id))
        active = [f for f in detail.findings if not f.suppressed]
        return {
            "review_id": detail.summary.id,
            "title": detail.summary.title,
            "branch": detail.summary.branch,
            "status": detail.summary.status,
            "blocking": detail.summary.blocking,
            "reason": detail.verdict_reason,
            "counts": detail.summary.counts,
            "findings": _numbered(active),
            "suppressed_findings": [
                _finding_json(f) for f in detail.findings if f.suppressed
            ],
        }

    @router.post("/v1/reviews/{review_id}/findings")
    def submit_findings(
        review_id: int,
        body: SubmitRequest,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        findings = _agent_findings(body.findings)
        verdict, shown = _guard(lambda: svc.reviewer.submit(actor, review_id, findings))
        return {
            "review_id": review_id,
            "blocking": verdict.blocking,
            "reason": verdict.reason,
            "counts": verdict.counts,
            "findings": _numbered(shown),
        }

    @router.post("/v1/reviews/{review_id}/respond")
    def respond_to_findings(
        review_id: int,
        body: RespondRequest,
        actor: Annotated[Principal, Depends(plugin_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        responses = [
            Response(finding=r.finding, disposition=r.disposition, note=r.note)
            for r in body.responses
        ]
        verdict = _guard(lambda: svc.reviewer.respond(actor, review_id, responses))
        return {
            "review_id": review_id,
            "recorded": len(responses),
            "blocking": verdict.blocking,
            "reason": verdict.reason,
            "counts": verdict.counts,
        }

    @router.get("/projects/{slug}/reviews")
    def list_reviews(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
        author: str | None = None,
    ) -> dict:
        actor = _scoped(svc, who, slug)
        applied, reviews = _guard(lambda: svc.reviewer.list_reviews(actor, author))
        return {
            "role": actor.role,
            "author": applied,
            "reviews": [
                {
                    "id": r.id,
                    "author": r.author,
                    "branch": r.branch,
                    "title": r.title,
                    "status": r.status,
                    "blocking": r.blocking,
                    "created_at": r.created_at,
                    "counts": r.counts,
                }
                for r in reviews
            ],
        }

    @router.get("/projects/{slug}/reviews/{review_id}")
    def review_detail(
        slug: str,
        review_id: int,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _scoped(svc, who, slug)
        detail = _guard(lambda: svc.reviewer.review_detail(actor, review_id))
        return {
            "id": detail.summary.id,
            "author": detail.summary.author,
            "branch": detail.summary.branch,
            "title": detail.summary.title,
            "status": detail.summary.status,
            "blocking": detail.summary.blocking,
            "verdict_reason": detail.verdict_reason,
            "created_at": detail.summary.created_at,
            "counts": detail.summary.counts,
            "findings": [
                _finding_json(f) | {"answer": _answer_json(detail.answers.get(f.fingerprint))}
                for f in detail.findings
            ],
            "steps": [
                {"seq": s.seq, "kind": s.kind, "payload": s.payload, "at": s.at} for s in detail.steps
            ],
        }

    @router.get("/projects/{slug}/rules/health")
    def rule_health(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _scoped(svc, who, slug)
        health = _guard(lambda: svc.reviewer.rule_health(actor))
        return {
            "rules": [
                {
                    "rule_id": h.rule_id,
                    "fired": h.fired,
                    "dismissed": h.dismissed,
                    "dismissal_rate": round(h.dismissal_rate, 3),
                    "flagged": h.flagged,
                    "reasons": h.reasons,
                }
                for h in health
            ]
        }

    @router.get("/projects/{slug}/config")
    def get_config(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _scoped(svc, who, slug)
        config = _guard(lambda: svc.reviewer.config_for(actor))
        guidelines = _guard(lambda: svc.reviewer.guidelines(actor))
        return {
            "config": config.to_dict(),
            "rulesets": svc.rulesets(),
            "overlays": svc.rule_overlays(),
            "role": actor.role,
            "rules": [{"id": g.id, "text": g.text, "severity": g.severity} for g in guidelines],
        }

    @router.put("/projects/{slug}/config")
    def put_config(
        slug: str,
        body: ConfigBody,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _scoped(svc, who, slug)
        config = ReviewConfig(
            ruleset=body.ruleset,
            policy=Policy(
                block_on=body.policy.block_on, max_agent_findings=body.policy.max_agent_findings
            ),
            disabled_rules=set(body.disabled_rules),
            conventions=body.conventions,
            reviewer_prompt=body.reviewer_prompt,
        )
        _guard(lambda: svc.reviewer.save_config(actor, config))
        return {"config": config.to_dict()}

    return router


def _scoped(svc: Services, who: tuple[int, str], slug: str) -> Principal:
    uid, email = who
    return _guard(lambda: svc.auth.session_principal(uid, email, slug))


def _plan_json(plan: ReviewPlan, actor: Principal) -> dict:
    """The plan as both versions send it. `/v1` adds the `review_id` it opened; `/v2` has none."""
    return {
        # A key is bound to one project and never chooses it, so this is not a setting — it is the
        # answer to "which project am I reviewing into", which nothing else tells anybody.
        "project": actor.project_slug,
        "instructions": plan.instructions,
        "policy": plan.policy,
        "conventions": plan.conventions,
        "guidelines": plan.guidelines,
        # Empty means no version was detected, and every rule applied. The developer has to be able
        # to tell that apart from a version that filtered rules out.
        "platform_version": plan.platform_version,
        "deterministic_findings": _numbered(plan.findings),
        "suppressed_findings": [_finding_json(f) for f in plan.suppressed],
    }


def _agent_findings(submitted: list[AgentFinding]) -> list[Finding]:
    return [
        Finding(
            file=f.file,
            line=f.line,
            severity=f.severity,
            rule_id=f.rule_id,
            message=f.message,
            source="agent",
            issue_type=f.issue_type,
            suggestion=f.suggestion,
            quoted_line=f.quoted_line,
        )
        for f in submitted
    ]


def _numbered(findings: list[Finding]) -> list[dict]:
    """What the developer will see as "1", "2", "3". The fingerprint is what actually identifies
    a finding; the number is only how a human points at one."""
    return [_finding_json(f, index) for index, f in enumerate(findings, start=1)]


def _finding_json(f: Finding, index: int | None = None) -> dict:
    return {
        "index": index,
        "fingerprint": f.fingerprint,
        "file": f.file,
        "line": f.line,
        "severity": f.severity,
        "rule_id": f.rule_id,
        "issue_type": f.issue_type,
        "message": f.message,
        "suggestion": f.suggestion,
        "quoted_line": f.quoted_line,
        "source": f.source,
        "suppressed": f.suppressed,
        "suppressed_reason": f.suppressed_reason,
        "regressed": f.regressed,
    }


def _answer_json(answer: ActiveDisposition | None) -> dict | None:
    """What was decided about a finding, for a reader. `None` when nobody answered it: the UI shows
    nothing at all rather than an empty label."""
    if answer is None:
        return None
    return {
        "disposition": answer.disposition,
        "note": answer.reason,
        "by": answer.email,
        "at": answer.at,
    }


def _guard(call):
    try:
        return call()
    except Forbidden as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from None
    except ReviewError as exc:
        raise HTTPException(422, str(exc)) from None
