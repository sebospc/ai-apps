"""Ports the identity context needs from the outside world."""

from __future__ import annotations

from typing import Protocol

from smith.auth.domain import Member, Project, Role, User


class Hasher(Protocol):
    def hash(self, secret: str) -> str: ...

    def verify(self, hashed: str, secret: str) -> bool: ...


class LoginThrottle(Protocol):
    """Fixed-window counters for failed logins, keyed by whatever identifies the attempt."""

    def blocked(self, keys: list[str]) -> bool:
        """True when any key has spent its allowance in the current window."""

    def record_failure(self, keys: list[str]) -> None: ...

    def clear(self, keys: list[str]) -> None:
        """A password that worked proves the earlier failures were not an attack on this account."""


class UserRepository(Protocol):
    def by_email(self, email: str) -> tuple[User, str] | None:
        """(user, password_hash) or None."""

    def by_id(self, user_id: int) -> User | None: ...

    def create(self, email: str, name: str, password_hash: str) -> User: ...


class ProjectRepository(Protocol):
    def by_slug(self, slug: str) -> Project | None: ...

    def by_id(self, project_id: int) -> Project | None: ...

    def create(self, slug: str, name: str, config: dict) -> Project: ...

    def save_config(self, project_id: int, config: dict) -> None: ...

    def role_of(self, user_id: int, project_id: int) -> Role | None: ...

    def add_member(self, user_id: int, project_id: int, role: Role) -> None: ...

    def set_role(self, user_id: int, project_id: int, role: Role) -> bool: ...

    def remove_member(self, user_id: int, project_id: int) -> bool: ...

    def delete(self, project_id: int) -> None:
        """Remove the project. Everything hanging off it goes with it, by foreign key."""
        ...

    def members(self, project_id: int) -> list[Member]: ...

    def count_leads(self, project_id: int) -> int: ...

    def for_user(self, user_id: int) -> list[tuple[Project, Role]]: ...


class ApiKeyRepository(Protocol):
    def create(self, project_id: int, user_id: int, name: str, prefix: str, key_hash: str) -> int: ...

    def by_prefix(self, prefix: str) -> tuple[int, int, int, str] | None:
        """(key_id, user_id, project_id, key_hash) for a live (non-revoked) key, or None."""

    def touch(self, key_id: int) -> None: ...

    def revoke(self, key_id: int, project_id: int) -> bool: ...

    def list_for_project(self, project_id: int) -> list[dict]: ...
