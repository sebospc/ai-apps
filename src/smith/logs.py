"""Process-level logging: one JSON line per request, and a reference the caller can quote.

Not a port and not an adapter. Logging is not something a context asks for — it is how the
process reports on itself — so it sits beside `settings` and `container` rather than behind an
interface.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-Id"

logger = logging.getLogger("smith.request")


class JsonFormatter(logging.Formatter):
    """One line, one JSON object.

    Extra fields arrive under a single `fields` key because `extra=` writes straight onto the
    LogRecord, and a key that collides with one of its attributes (`name`, `module`, `args`)
    raises instead of logging.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update(getattr(record, "fields", {}))
        if record.exc_info:
            payload["traceback"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    """Install the JSON formatter on the root logger, once per process."""
    root = logging.getLogger()
    root.setLevel(level)
    # Added, never assigned over: pytest's caplog hangs its own handler here during a test.
    if not any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
    # Uvicorn's access line says strictly less than ours and would double every request. Its
    # startup banner is worth keeping, but only if it arrives in the same shape as everything
    # else: a log stream that is JSON except for four lines is not a JSON log stream.
    logging.getLogger("uvicorn.access").disabled = True
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True


def install_request_log(app: FastAPI) -> None:
    """Add the request log as the outermost layer, so it times and catches everything below it."""

    @app.middleware("http")
    async def log_request(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = uuid.uuid4().hex[:12]
        request.state.request_id = request_id
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # The caller gets a reference and never a traceback; the traceback goes to the log
            # under the same reference, which is the only thing that ties the two together.
            logger.exception("unhandled error", extra={"fields": {"request_id": request_id}})
            response = JSONResponse(
                status_code=500,
                content={
                    "detail": (
                        "the server hit an unexpected error. Quote reference "
                        f"{request_id} when you report it"
                    ),
                    "request_id": request_id,
                },
            )
        response.headers[REQUEST_ID_HEADER] = request_id
        logger.info("request", extra={"fields": _fields(request, response, request_id, started)})
        return response


def _fields(request: Request, response: Response, request_id: str, started: float) -> dict:
    route = request.scope.get("route")
    fields: dict = {
        "request_id": request_id,
        "method": request.method,
        # The template, so lines from different reviews aggregate. `path` keeps the concrete one.
        "route": getattr(route, "path", "unmatched"),
        "path": request.url.path[:200],
        "status": response.status_code,
        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
    }
    project = getattr(request.state, "project_id", None)
    if project is not None:
        fields["project"] = project
    review_id = _review_id(request)
    if review_id is not None:
        fields["review_id"] = review_id
    return fields


def _review_id(request: Request) -> int | None:
    """From the URL on the routes that carry one, from the endpoint on the route that mints one."""
    raw = request.scope.get("path_params", {}).get("review_id")
    if raw is None:
        raw = getattr(request.state, "review_id", None)
    try:
        return int(raw)
    except (TypeError, ValueError):
        # A malformed id in the URL is a 422 and names no review.
        return None
