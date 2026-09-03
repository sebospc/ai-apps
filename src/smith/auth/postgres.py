"""Postgres adapter for the identity context: ORM tables + repository implementations."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    delete,
    func,
    select,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from smith.auth.domain import Member, Project, Role, User
from smith.db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserRow(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class LoginAttemptRow(Base):
    """One fixed window of failed logins for one key ("ip:..." or "email:...").

    In postgres because there is one process and one database; a second store for a counter this
    small would be infrastructure nobody asked for.
    """

    __tablename__ = "login_attempts"

    key: Mapped[str] = mapped_column(String(320), primary_key=True)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    failures: Mapped[int] = mapped_column(Integer, default=0)


class ProjectRow(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    # Everything a lead can configure about reviews: ruleset, block_on, guidelines, disabled rules.
    # A JSON column instead of five tables — the shape is read whole, written whole, never queried by.
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class MembershipRow(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "project_id", name="uq_membership"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10))


class ApiKeyRow(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120), default="")
    prefix: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    key_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


def _to_user(row: UserRow) -> User:
    return User(id=row.id, email=row.email, name=row.name)


def _to_project(row: ProjectRow) -> Project:
    return Project(id=row.id, slug=row.slug, name=row.name, config=dict(row.config or {}))


MAX_FAILURES = 10
WINDOW = timedelta(minutes=15)


class SqlLoginThrottle:
    """Fixed window, not a sliding one: an attacker gets at most `MAX_FAILURES` tries per window,
    and the code stays something a reader can hold in their head."""

    def __init__(self, session: Session, now: Callable[[], datetime] = _now) -> None:
        self._s = session
        self._now = now

    def blocked(self, keys: list[str]) -> bool:
        for key in keys:
            row = self._live(key)
            if row is not None and row.failures >= MAX_FAILURES:
                return True
        return False

    def record_failure(self, keys: list[str]) -> None:
        for key in keys:
            row = self._live(key)
            if row is None:
                row = self._s.get(LoginAttemptRow, key) or LoginAttemptRow(key=key)
                row.window_started_at = self._now()
                row.failures = 0
                self._s.add(row)
            row.failures += 1
        self._s.flush()

    def clear(self, keys: list[str]) -> None:
        for key in keys:
            row = self._s.get(LoginAttemptRow, key)
            if row is not None:
                self._s.delete(row)
        self._s.flush()

    def _live(self, key: str) -> LoginAttemptRow | None:
        """The row for the window still running, or None when it has expired."""
        row = self._s.get(LoginAttemptRow, key)
        if row is None:
            return None
        started = row.window_started_at
        if started.tzinfo is None:  # sqlite hands back naive datetimes
            started = started.replace(tzinfo=timezone.utc)
        return row if self._now() - started < WINDOW else None


class SqlUserRepository:
    def __init__(self, session: Session) -> None:
        self._s = session

    def by_email(self, email: str) -> tuple[User, str] | None:
        row = self._s.scalar(select(UserRow).where(UserRow.email == email))
        return (_to_user(row), row.password_hash) if row else None

    def by_id(self, user_id: int) -> User | None:
        row = self._s.get(UserRow, user_id)
        return _to_user(row) if row else None

    def create(self, email: str, name: str, password_hash: str) -> User:
        row = UserRow(email=email, name=name, password_hash=password_hash)
        self._s.add(row)
        self._s.flush()
        return _to_user(row)


class SqlProjectRepository:
    def __init__(self, session: Session) -> None:
        self._s = session

    def by_slug(self, slug: str) -> Project | None:
        row = self._s.scalar(select(ProjectRow).where(ProjectRow.slug == slug))
        return _to_project(row) if row else None

    def by_id(self, project_id: int) -> Project | None:
        row = self._s.get(ProjectRow, project_id)
        return _to_project(row) if row else None

    def create(self, slug: str, name: str, config: dict) -> Project:
        row = ProjectRow(slug=slug, name=name, config=config)
        self._s.add(row)
        self._s.flush()
        return _to_project(row)

    def save_config(self, project_id: int, config: dict) -> None:
        row = self._s.get(ProjectRow, project_id)
        if row is not None:
            row.config = config

    def role_of(self, user_id: int, project_id: int) -> Role | None:
        role = self._s.scalar(
            select(MembershipRow.role).where(
                MembershipRow.user_id == user_id, MembershipRow.project_id == project_id
            )
        )
        return role  # type: ignore[return-value]

    def add_member(self, user_id: int, project_id: int, role: Role) -> None:
        self._s.add(MembershipRow(user_id=user_id, project_id=project_id, role=role))
        self._s.flush()

    def set_role(self, user_id: int, project_id: int, role: Role) -> bool:
        row = self._s.scalar(
            select(MembershipRow).where(
                MembershipRow.user_id == user_id, MembershipRow.project_id == project_id
            )
        )
        if row is None:
            return False
        row.role = role
        return True

    def remove_member(self, user_id: int, project_id: int) -> bool:
        result = self._s.execute(
            delete(MembershipRow).where(
                MembershipRow.user_id == user_id, MembershipRow.project_id == project_id
            )
        )
        return bool(result.rowcount)

    def delete(self, project_id: int) -> None:
        """One statement. Reviews, findings, steps, dispositions, keys and memberships all declare
        `ondelete="CASCADE"` against `projects.id`, so the database removes them and neither context
        has to reach into the other's tables to do it."""
        self._s.execute(delete(ProjectRow).where(ProjectRow.id == project_id))

    def members(self, project_id: int) -> list[Member]:
        rows = self._s.execute(
            select(UserRow, MembershipRow.role)
            .join(MembershipRow, MembershipRow.user_id == UserRow.id)
            .where(MembershipRow.project_id == project_id)
            .order_by(MembershipRow.role, UserRow.email)
        ).all()
        return [Member(user=_to_user(u), role=r) for u, r in rows]  # type: ignore[misc]

    def count_leads(self, project_id: int) -> int:
        return (
            self._s.scalar(
                select(func.count())
                .select_from(MembershipRow)
                .where(MembershipRow.project_id == project_id, MembershipRow.role == "lead")
            )
            or 0
        )

    def for_user(self, user_id: int) -> list[tuple[Project, Role]]:
        rows = self._s.execute(
            select(ProjectRow, MembershipRow.role)
            .join(MembershipRow, MembershipRow.project_id == ProjectRow.id)
            .where(MembershipRow.user_id == user_id)
            .order_by(ProjectRow.name)
        ).all()
        return [(_to_project(p), r) for p, r in rows]  # type: ignore[misc]


class SqlApiKeyRepository:
    def __init__(self, session: Session) -> None:
        self._s = session

    def create(self, project_id: int, user_id: int, name: str, prefix: str, key_hash: str) -> int:
        row = ApiKeyRow(
            project_id=project_id, user_id=user_id, name=name, prefix=prefix, key_hash=key_hash
        )
        self._s.add(row)
        self._s.flush()
        return row.id

    def by_prefix(self, prefix: str) -> tuple[int, int, int, str] | None:
        row = self._s.scalar(
            select(ApiKeyRow).where(ApiKeyRow.prefix == prefix, ApiKeyRow.revoked_at.is_(None))
        )
        return (row.id, row.user_id, row.project_id, row.key_hash) if row else None

    def touch(self, key_id: int) -> None:
        row = self._s.get(ApiKeyRow, key_id)
        if row is not None:
            row.last_used_at = _now()

    def revoke(self, key_id: int, project_id: int) -> bool:
        row = self._s.get(ApiKeyRow, key_id)
        if row is None or row.project_id != project_id or row.revoked_at is not None:
            return False
        row.revoked_at = _now()
        return True

    def list_for_project(self, project_id: int) -> list[dict]:
        rows = self._s.execute(
            select(ApiKeyRow, UserRow.email)
            .join(UserRow, UserRow.id == ApiKeyRow.user_id)
            .where(ApiKeyRow.project_id == project_id)
            .order_by(ApiKeyRow.created_at.desc())
        ).all()
        return [
            {
                "id": r.id,
                "name": r.name,
                # Whose key it is — the whole point of per-developer attribution.
                "user_email": email,
                "prefix": r.prefix,
                "created_at": r.created_at,
                "last_used_at": r.last_used_at,
                "revoked": r.revoked_at is not None,
            }
            for r, email in rows
        ]
