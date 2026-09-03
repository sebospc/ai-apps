"""Process entry point. One FastAPI app, one router per bounded context.

Splitting a context into its own service means building a second app here with only that router —
the domain code does not change.
"""

from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from smith.auth import http as auth_http
from smith.container import Container
from smith.limits import install_request_limits
from smith.logs import configure_logging, install_request_log
from smith.pergamon.adapters import http as catalog_http
from smith.reviewer.adapters import http as reviewer_http
from smith.settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging()

    container = Container(settings)
    app = FastAPI(title="Smith Reviewer", version="0.1.0")
    app.state.container = container

    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        session_cookie="smith_session",
        max_age=settings.session_days * 86400,
        same_site="lax",
        https_only=settings.cookie_secure,
    )

    install_request_limits(app, settings.max_request_bytes)

    # Last means outermost: the request log wraps the session cookie and the size check too, so a
    # request that dies decoding one, or is refused for its size, still gets a line and a reference.
    install_request_log(app)

    app.include_router(auth_http.build_router())
    app.include_router(reviewer_http.build_router())
    app.include_router(catalog_http.build_router())

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
