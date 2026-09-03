"""Identity domain: pure entities and the API-key format. No I/O, no framework, no hashing library."""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Literal

Role = Literal["lead", "dev"]

KEY_SCHEME = "smk"
_PREFIX_LEN = 8
_SECRET_LEN = 32


# A developer never signs into the web UI — they only need a key. Their account carries this instead
# of a password hash, which no password can ever produce, so login is impossible until a lead sets one.
UNUSABLE_PASSWORD = "!"


@dataclass(frozen=True)
class User:
    id: int
    email: str
    name: str


@dataclass(frozen=True)
class Member:
    user: User
    role: Role


@dataclass(frozen=True)
class Project:
    id: int
    slug: str
    name: str
    config: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Principal:
    """Who is calling and what they may touch. Produced by either auth path (cookie or API key)."""

    user_id: int
    email: str
    project_id: int | None = None
    role: Role | None = None
    via: Literal["session", "api_key"] = "session"

    @property
    def is_lead(self) -> bool:
        return self.role == "lead"


class AuthError(Exception):
    """Credentials are missing, malformed, revoked or wrong. Never says which — callers map to 401."""


class TooManyAttempts(AuthError):
    """Refused before any password was checked. A subclass of AuthError so nothing that already
    handles a failed login can accidentally treat this as a success."""


class Forbidden(Exception):
    """Authenticated but not allowed to do this."""


def new_api_key() -> tuple[str, str]:
    """Return (full_key, prefix). The full key is shown to the user once and never stored."""
    prefix = secrets.token_hex(_PREFIX_LEN // 2)
    secret = secrets.token_urlsafe(_SECRET_LEN)
    return f"{KEY_SCHEME}_{prefix}_{secret}", prefix


def key_prefix(raw: str) -> str | None:
    """Extract the lookup prefix from a presented key, or None if it is not our format.

    The prefix is a public index, not a credential: it narrows the DB lookup to one row so we run
    exactly one (expensive) hash verification instead of one per key in the table.
    """
    parts = raw.strip().split("_", 2)
    if len(parts) != 3 or parts[0] != KEY_SCHEME:
        return None
    if len(parts[1]) != _PREFIX_LEN or not parts[2]:
        return None
    return parts[1]
