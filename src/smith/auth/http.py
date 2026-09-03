"""HTTP adapter for identity: session login for humans, API keys for plugins."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from smith.auth.domain import AuthError, Forbidden, Principal, TooManyAttempts
from smith.container import Services

_UNAUTHORIZED = HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")


def _client_ip(request: Request) -> str:
    """The address to throttle. `X-Forwarded-For` is only trusted for its first entry, and only
    because this runs behind a reverse proxy the operator controls."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:100]
    return request.client.host if request.client else ""


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)


class KeyRequest(BaseModel):
    name: str = Field(default="", max_length=120)
    # Whose key this is. Omitted means the lead's own. A key bound to a developer is what makes
    # their reviews show up under their name.
    for_email: str | None = Field(default=None, max_length=320)


class ProjectRequest(BaseModel):
    slug: str = Field(min_length=2, max_length=100)
    name: str = Field(default="", max_length=200)


class MemberRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    role: Literal["lead", "dev"] = "dev"


def get_services(request: Request) -> Iterator[Services]:
    """One transaction per request, from the container the composition root put on app.state."""
    yield from request.app.state.container.session()


def session_user(request: Request) -> tuple[int, str]:
    """The logged-in human, from the signed session cookie."""
    uid = request.session.get("uid")
    email = request.session.get("email")
    if not isinstance(uid, int) or not isinstance(email, str):
        raise _UNAUTHORIZED
    return uid, email


def bearer_key(request: Request) -> str:
    """The plugin's API key, from `Authorization: Bearer smk_...`."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _UNAUTHORIZED
    return token.strip()


def build_router() -> APIRouter:
    router = APIRouter(tags=["auth"])

    @router.post("/auth/login")
    def login(
        body: LoginRequest,
        request: Request,
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        # Returned, not raised: a rejected login still has something to record, and the request's
        # transaction is rolled back by any exception leaving this function.
        try:
            user = svc.auth.login(body.email, body.password, _client_ip(request))
        except TooManyAttempts:
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "too many failed attempts, try again later"},
            )
        except AuthError:
            # Deliberately identical for unknown email and wrong password.
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={"detail": "invalid credentials"},
            )
        request.session.update({"uid": user.id, "email": user.email})
        return {"id": user.id, "email": user.email, "name": user.name}

    @router.post("/auth/logout")
    def logout(request: Request) -> dict:
        request.session.clear()
        return {"ok": True}

    @router.get("/auth/me")
    def me(
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        uid, email = who
        return {
            "id": uid,
            "email": email,
            "projects": [
                {"slug": p.slug, "name": p.name, "role": role} for p, role in svc.auth.projects_of(uid)
            ],
        }

    @router.post("/projects", status_code=status.HTTP_201_CREATED)
    def create_project(
        body: ProjectRequest,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        project = _guard(lambda: svc.auth.create_project(actor, body.slug, body.name, {}))
        return {"slug": project.slug, "name": project.name, "role": "lead"}

    @router.get("/projects/{slug}/members")
    def list_members(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        members = _guard(lambda: svc.auth.members(actor, slug))
        return {"members": [{"email": m.user.email, "role": m.role} for m in members]}

    @router.post("/projects/{slug}/members", status_code=status.HTTP_201_CREATED)
    def add_member(
        slug: str,
        body: MemberRequest,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        """Add a member, or change the role of one already there. Idempotent by design: a lead
        re-adding someone should not be an error they have to think about."""
        actor = _actor(svc, who)
        member = _guard(lambda: svc.auth.add_member(actor, slug, body.email, body.role))
        return {"email": member.user.email, "role": member.role}

    @router.delete("/projects/{slug}/members/{email}")
    def remove_member(
        slug: str,
        email: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        _guard(lambda: svc.auth.remove_member(actor, slug, email))
        return {"ok": True}

    @router.delete("/projects/{slug}")
    def delete_project(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        """A developer and a stranger get the same 403 `unknown project`, so this does not become a
        way to find out which projects exist."""
        actor = _actor(svc, who)
        _guard(lambda: svc.auth.delete_project(actor, slug))
        return {"ok": True}

    @router.get("/projects/{slug}/keys")
    def list_keys(
        slug: str,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        return {"keys": _guard(lambda: svc.auth.list_keys(actor, slug))}

    @router.post("/projects/{slug}/keys", status_code=status.HTTP_201_CREATED)
    def create_key(
        slug: str,
        body: KeyRequest,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        raw, key_id = _guard(lambda: svc.auth.issue_key(actor, slug, body.name, body.for_email))
        # The only time the full key is ever visible. It is not recoverable afterwards.
        return {"id": key_id, "key": raw, "for_email": body.for_email or who[1]}

    @router.delete("/projects/{slug}/keys/{key_id}")
    def revoke_key(
        slug: str,
        key_id: int,
        who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        actor = _actor(svc, who)
        _guard(lambda: svc.auth.revoke_key(actor, slug, key_id))
        return {"ok": True}

    return router


def _actor(svc: Services, who: tuple[int, str]) -> Principal:
    uid, email = who
    return Principal(user_id=uid, email=email, via="session")


def _guard(call):
    try:
        return call()
    except Forbidden as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from None
    except AuthError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
