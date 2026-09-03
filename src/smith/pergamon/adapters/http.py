"""HTTP adapter for Pergamon. Read-only: the catalog, and one entry in full.

Two audiences reach the same two reads through different doors. A plugin carries a project API
key; a human carries the session cookie the web already gave them. Neither door narrows what may
be read, because the catalog is Smith's own writing and is identical for every project."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from smith.auth.domain import AuthError, Principal
from smith.auth.http import bearer_key, get_services, session_user
from smith.container import Services
from smith.pergamon.service import UnknownEntry


def catalog_principal(
    request: Request,
    key: Annotated[str, Depends(bearer_key)],
    svc: Annotated[Services, Depends(get_services)],
) -> Principal:
    """Same door as the review endpoints: a project's API key, bound to a person. The catalog is
    Smith's own writing and is the same for every project, so the key authenticates and nothing
    narrows what it may read."""
    try:
        actor = svc.auth.authenticate_key(key)
    except AuthError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid API key") from None
    # These URLs do not name a project, so the request log has to be told which one is calling.
    request.state.project_id = actor.project_id
    return actor


def _summaries(svc: Services) -> dict:
    """Id, title and about only — small enough for an agent to read whole and match a developer's
    words against, and all a list on screen shows."""
    return {"entries": [e.summary() for e in svc.catalog.entries()]}


def _whole(svc: Services, entry_id: str) -> dict:
    try:
        return svc.catalog.entry(entry_id).to_dict()
    except UnknownEntry as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None


def build_router() -> APIRouter:
    router = APIRouter(tags=["catalog"])

    # `/v1` for the same reason the review routes carry it: a plugin in the wild cannot be upgraded
    # in lockstep with the server.
    @router.get("/v1/catalog")
    def list_catalog(
        _actor: Annotated[Principal, Depends(catalog_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        return _summaries(svc)

    @router.get("/v1/catalog/{entry_id}")
    def read_entry(
        entry_id: str,
        _actor: Annotated[Principal, Depends(catalog_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        return _whole(svc, entry_id)

    # No `/v1` on the two below: the web ships with the server and never talks to an older one.
    @router.get("/catalog")
    def browse_catalog(
        _who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        return _summaries(svc)

    @router.get("/catalog/{entry_id}")
    def browse_entry(
        entry_id: str,
        _who: Annotated[tuple[int, str], Depends(session_user)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        return _whole(svc, entry_id)

    return router
