"""HTTP adapter for Pergamon. Two calls, both read-only: the catalog, and one entry in full."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from smith.auth.domain import AuthError, Principal
from smith.auth.http import bearer_key, get_services
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


def build_router() -> APIRouter:
    # `/v1` for the same reason the review routes carry it: a plugin in the wild cannot be upgraded
    # in lockstep with the server.
    router = APIRouter(tags=["catalog"])

    @router.get("/v1/catalog")
    def list_catalog(
        _actor: Annotated[Principal, Depends(catalog_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        """Id, title and about only — small enough for an agent to read whole and match a
        developer's words against."""
        return {"entries": [e.summary() for e in svc.catalog.entries()]}

    @router.get("/v1/catalog/{entry_id}")
    def read_entry(
        entry_id: str,
        _actor: Annotated[Principal, Depends(catalog_principal)],
        svc: Annotated[Services, Depends(get_services)],
    ) -> dict:
        try:
            return svc.catalog.entry(entry_id).to_dict()
        except UnknownEntry as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from None

    return router
