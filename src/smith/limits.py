"""What the server agrees to read, before it agrees to think about a request.

Both checks answer the same abuse: a caller sending more than a review can be. The size check reads
the headers and refuses there, so an oversized upload costs a header parse instead of its own weight
in resident memory — a 50 MB diff used to be buffered in full and then refused for being 25 times
over the diff limit.

The validation handler replaces FastAPI's default, which quotes the offending input back at the
caller. On a request carrying a 400 kB file that turns a refusal into a second copy of the thing
being refused, and the plugin throws the structure away regardless: `explainHttp` only quotes a
`detail` that is prose.
"""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

_METHODS_WITH_A_BODY = frozenset({"POST", "PUT", "PATCH"})


def install_request_limits(app: FastAPI, max_body_bytes: int) -> None:
    """Refuse a body too big to be a review, and refuse it before reading it."""

    @app.middleware("http")
    async def _bounded_body(request: Request, call_next):
        refusal = _refuse_by_size(request, max_body_bytes)
        return refusal if refusal is not None else await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def _one_sentence(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _refusal(status.HTTP_422_UNPROCESSABLE_CONTENT, _first_problem(exc))


def _refuse_by_size(request: Request, limit: int) -> JSONResponse | None:
    if request.method not in _METHODS_WITH_A_BODY:
        return None
    # A chunked body declares no size, so the only way to measure it is to read it — which is the
    # cost this check exists to avoid. Nothing that talks to this server sends one: the plugin sets
    # Content-Length itself and `fetch` sets it for a string body.
    if "chunked" in request.headers.get("transfer-encoding", "").lower():
        return _refusal(
            status.HTTP_411_LENGTH_REQUIRED,
            "this server will not read a request body whose size it cannot check first — "
            "send the request with a Content-Length",
        )
    declared = request.headers.get("content-length")
    if declared is None:
        return None
    try:
        size = int(declared)
    except ValueError:
        return _refusal(status.HTTP_400_BAD_REQUEST, "the Content-Length header is not a number")
    if size > limit:
        return _refusal(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"this request is too large to be a code review ({_mb(size)}, and the limit is "
            f"{_mb(limit)}) — review a smaller change",
        )
    return None


def _first_problem(exc: RequestValidationError) -> str:
    """One sentence naming the field and what is wrong with it, and never the value itself.

    The value is what makes the default dangerous: it is the caller's own payload, so the refusal
    grows with whatever was refused.
    """
    problems = exc.errors()
    if not problems:
        return "the request was not in the shape this endpoint expects"
    first = problems[0]
    where = ".".join(str(part) for part in first.get("loc", ()) if part != "body") or "the request"
    said = str(first.get("msg") or "is not valid")
    others = f" (and {len(problems) - 1} more like it)" if len(problems) > 1 else ""
    return f"{where}: {said[:1].lower()}{said[1:]}{others}"


def _refusal(code: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=code)


def _mb(count: int) -> str:
    return f"{count / 1_000_000:.1f} MB"
