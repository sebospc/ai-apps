"""Postgres adapter for the reviewer context: tables, review store, project config source."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    delete,
    func,
    select,
    update,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from smith.auth.postgres import ProjectRow, UserRow
from smith.db import Base
from smith.reviewer.domain.models import (
    ActiveDisposition,
    Finding,
    ReviewConfig,
    ReviewDetail,
    RuleHealth,
    ReviewStep,
    ReviewSummary,
    Verdict,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ReviewRow(Base):
    __tablename__ = "reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    branch: Mapped[str] = mapped_column(String(255), default="")
    title: Mapped[str] = mapped_column(String(500), default="")
    # planned | completed. `plan` writes the row because `submit` needs it — the agent's findings
    # are scoped against this diff's added lines, which only the server holds. A review is the
    # verdict, though, so a row still `planned` is a mechanism and not something anybody reviewed:
    # every query a lead reads filters it out. Reported 2026-09-08 as six warnings in a list, from
    # a session that was cancelled before it read a line of the code.
    status: Mapped[str] = mapped_column(String(20), default="planned")
    files_changed: Mapped[int] = mapped_column(Integer, default=0)
    # The diff's added lines, kept so a later submit can be scoped without resending the diff.
    # The diff itself is deliberately not stored: we hold the developer's code no longer than needed.
    added_lines: Mapped[dict] = mapped_column(JSON, default=dict)
    blocking: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    verdict_reason: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FindingRow(Base):
    __tablename__ = "findings"
    # Dispositions are looked up per review by fingerprint, never by fingerprint alone.
    __table_args__ = (Index("ix_findings_review_fingerprint", "review_id", "fingerprint"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("reviews.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(20))
    file: Mapped[str] = mapped_column(String(1000))
    line: Mapped[int | None] = mapped_column(Integer, nullable=True)
    severity: Mapped[str] = mapped_column(String(20))
    rule_id: Mapped[str] = mapped_column(String(200))
    issue_type: Mapped[str] = mapped_column(String(30), default="bug")
    message: Mapped[str] = mapped_column(Text)
    suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
    quoted_line: Mapped[str | None] = mapped_column(Text, nullable=True)
    suppressed: Mapped[bool] = mapped_column(Boolean, default=False)
    suppressed_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    fingerprint: Mapped[str] = mapped_column(String(40), default="")


class FindingDispositionRow(Base):
    """What was answered about a fingerprint, in one project. Append-and-revoke, never overwritten:
    a lead reading a review later needs the argument, not just its outcome."""

    __tablename__ = "finding_dispositions"
    __table_args__ = (Index("ix_dispositions_project_fingerprint", "project_id", "fingerprint"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    fingerprint: Mapped[str] = mapped_column(String(40))
    disposition: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(Text, default="")
    set_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    set_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReviewStepRow(Base):
    """Append-only trail. Never updated, never deleted: it is the record of how a review happened."""

    __tablename__ = "review_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    review_id: Mapped[int] = mapped_column(ForeignKey("reviews.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


def _to_finding(row: FindingRow) -> Finding:
    return Finding(
        file=row.file,
        line=row.line,
        severity=row.severity,  # type: ignore[arg-type]
        rule_id=row.rule_id,
        message=row.message,
        source=row.source,  # type: ignore[arg-type]
        issue_type=row.issue_type,
        suggestion=row.suggestion,
        quoted_line=row.quoted_line,
        suppressed=row.suppressed,
        suppressed_reason=row.suppressed_reason,
        fingerprint=row.fingerprint,
    )


class SqlReviewStore:
    def __init__(self, session: Session) -> None:
        self._s = session

    def create(
        self,
        project_id: int,
        user_id: int,
        branch: str,
        title: str,
        added: dict[str, set[int]],
        files_changed: int,
    ) -> int:
        row = ReviewRow(
            project_id=project_id,
            user_id=user_id,
            branch=branch[:255],
            title=title[:500],
            files_changed=files_changed,
            added_lines={p: sorted(lines) for p, lines in added.items()},
        )
        self._s.add(row)
        self._s.flush()
        return row.id

    def rule_health(self, project_id: int) -> list[RuleHealth]:
        # ponytail: counted in Python over one project's findings rather than in SQL. A project has
        # thousands of findings, not millions; move it into a GROUP BY when that stops being true.
        fired = self._s.execute(
            select(FindingRow.rule_id, FindingRow.fingerprint)
            .join(ReviewRow, ReviewRow.id == FindingRow.review_id)
            .where(ReviewRow.project_id == project_id, ReviewRow.status == "completed")
        ).all()
        dismissals = self._s.execute(
            select(FindingDispositionRow.fingerprint, FindingDispositionRow.reason)
            .where(
                FindingDispositionRow.project_id == project_id,
                FindingDispositionRow.disposition == "dismissed",
                FindingDispositionRow.revoked_at.is_(None),
            )
            .order_by(FindingDispositionRow.set_at.desc())
        ).all()

        reason_for = {fingerprint: reason for fingerprint, reason in dismissals}
        # Most recent first, because a lead reading a rule's row wants the latest argument.
        recency = {fingerprint: order for order, (fingerprint, _) in enumerate(dismissals)}

        health: dict[str, RuleHealth] = {}
        seen: dict[str, list[tuple[int, str]]] = {}
        for rule_id, fingerprint in fired:
            entry = health.setdefault(rule_id, RuleHealth(rule_id=rule_id, fired=0, dismissed=0))
            entry.fired += 1
            if fingerprint in reason_for:
                entry.dismissed += 1
                seen.setdefault(rule_id, []).append((recency[fingerprint], reason_for[fingerprint]))

        for rule_id, entry in health.items():
            ordered = sorted(dict.fromkeys(seen.get(rule_id, [])))
            entry.reasons = [reason for _, reason in ordered if reason][:5]
        return sorted(health.values(), key=lambda h: (-h.dismissal_rate, -h.fired, h.rule_id))

    def owner_of(self, review_id: int, for_update: bool = False) -> tuple[int, int, str] | None:
        # sqlite renders no FOR UPDATE at all, so the suite proves the logic and postgres provides
        # the serialisation. `tests/test_limits.py` is what measures it on the real database.
        statement = select(ReviewRow).where(ReviewRow.id == review_id)
        row = self._s.scalars(statement.with_for_update() if for_update else statement).first()
        return (row.project_id, row.user_id, row.status) if row else None

    def added_lines(self, review_id: int) -> dict[str, set[int]]:
        row = self._s.get(ReviewRow, review_id)
        if row is None:
            return {}
        return {p: set(lines) for p, lines in (row.added_lines or {}).items()}

    def add_findings(self, review_id: int, findings: list[Finding]) -> None:
        self._s.add_all(
            [
                FindingRow(
                    review_id=review_id,
                    source=f.source,
                    file=f.file[:1000],
                    line=f.line,
                    severity=f.severity,
                    rule_id=f.rule_id[:200],
                    issue_type=f.issue_type,
                    message=f.message,
                    suggestion=f.suggestion,
                    quoted_line=f.quoted_line,
                    suppressed=f.suppressed,
                    suppressed_reason=f.suppressed_reason,
                    fingerprint=f.fingerprint,
                )
                for f in findings
            ]
        )
        self._s.flush()

    def replace_agent_findings(self, review_id: int, findings: list[Finding]) -> None:
        self._s.execute(
            delete(FindingRow).where(
                FindingRow.review_id == review_id, FindingRow.source == "agent"
            )
        )
        self.add_findings(review_id, findings)

    def findings(self, review_id: int) -> list[Finding]:
        rows = self._s.scalars(
            select(FindingRow).where(FindingRow.review_id == review_id).order_by(FindingRow.id)
        ).all()
        return [_to_finding(r) for r in rows]

    def add_step(self, review_id: int, kind: str, payload: dict) -> None:
        next_seq = (
            self._s.scalar(
                select(func.coalesce(func.max(ReviewStepRow.seq), 0)).where(
                    ReviewStepRow.review_id == review_id
                )
            )
            or 0
        ) + 1
        self._s.add(ReviewStepRow(review_id=review_id, seq=next_seq, kind=kind, payload=payload))
        self._s.flush()

    def complete(self, review_id: int, verdict: Verdict) -> None:
        row = self._s.get(ReviewRow, review_id)
        if row is None:
            return
        row.status = "completed"
        row.blocking = verdict.blocking
        row.verdict_reason = verdict.reason[:500]
        row.completed_at = _now()


    def list_for_project(
        self,
        project_id: int,
        only_user_id: int | None,
        limit: int,
        author_email: str | None = None,
    ) -> list[ReviewSummary]:
        query = (
            select(ReviewRow, UserRow.email)
            .join(UserRow, UserRow.id == ReviewRow.user_id)
            .where(ReviewRow.project_id == project_id, ReviewRow.status == "completed")
            .order_by(ReviewRow.created_at.desc())
            .limit(limit)
        )
        if only_user_id is not None:
            query = query.where(ReviewRow.user_id == only_user_id)
        if author_email is not None:
            query = query.where(UserRow.email == author_email)
        rows = self._s.execute(query).all()
        return [_to_summary(r, email, self._counts(r.id)) for r, email in rows]

    def detail(self, review_id: int) -> ReviewDetail | None:
        row = self._s.get(ReviewRow, review_id)
        if row is None:
            return None
        email = self._s.scalar(select(UserRow.email).where(UserRow.id == row.user_id)) or ""
        steps = self._s.scalars(
            select(ReviewStepRow)
            .where(ReviewStepRow.review_id == review_id)
            .order_by(ReviewStepRow.seq)
        ).all()
        return ReviewDetail(
            summary=_to_summary(row, email, self._counts(review_id)),
            verdict_reason=row.verdict_reason,
            findings=self.findings(review_id),
            steps=[
                ReviewStep(seq=s.seq, kind=s.kind, payload=dict(s.payload or {}), at=_iso(s.at))
                for s in steps
            ],
        )

    def _counts(self, review_id: int) -> dict[str, int]:
        rows = self._s.execute(
            select(FindingRow.severity, func.count())
            .where(FindingRow.review_id == review_id, FindingRow.suppressed.is_(False))
            .group_by(FindingRow.severity)
        ).all()
        return {severity: count for severity, count in rows}


def _iso(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def _to_summary(row: ReviewRow, author: str, counts: dict[str, int]) -> ReviewSummary:
    return ReviewSummary(
        id=row.id,
        author=author,
        branch=row.branch,
        title=row.title,
        status=row.status,
        blocking=row.blocking,
        created_at=_iso(row.created_at),
        counts=counts,
    )


class SqlDispositionStore:
    def __init__(self, session: Session) -> None:
        self._s = session

    def set(
        self, project_id: int, fingerprint: str, disposition: str, reason: str, user_id: int
    ) -> None:
        # ponytail: uniqueness of the active row is kept here rather than by a partial unique index,
        # which sqlite and postgres spell differently. Move it into the schema if a second writer
        # ever appears — today every write goes through this method, inside one transaction.
        self._s.execute(
            update(FindingDispositionRow)
            .where(
                FindingDispositionRow.project_id == project_id,
                FindingDispositionRow.fingerprint == fingerprint,
                FindingDispositionRow.revoked_at.is_(None),
            )
            .values(revoked_at=_now())
        )
        self._s.add(
            FindingDispositionRow(
                project_id=project_id,
                fingerprint=fingerprint[:40],
                disposition=disposition,
                reason=reason,
                set_by=user_id,
            )
        )
        self._s.flush()

    def active(self, project_id: int, fingerprints: list[str]) -> dict[str, ActiveDisposition]:
        if not fingerprints:
            return {}
        return self._standing(
            project_id, FindingDispositionRow.fingerprint.in_(set(fingerprints))
        )

    def active_fixed(self, project_id: int) -> dict[str, ActiveDisposition]:
        return self._standing(project_id, FindingDispositionRow.disposition == "fixed")

    def confirm_fixed(self, project_id: int, fingerprints: list[str]) -> None:
        # Settled, not revoked: the row stays standing so the same claim is never re-checked, and a
        # lead reading the project's history still sees that the fix was made and held.
        self._settle(project_id, fingerprints, disposition="confirmed_fixed")

    def revoke(self, project_id: int, fingerprints: list[str]) -> None:
        self._settle(project_id, fingerprints, revoked_at=_now())

    def _settle(self, project_id: int, fingerprints: list[str], **values: object) -> None:
        if not fingerprints:
            return
        self._s.execute(
            update(FindingDispositionRow)
            .where(
                FindingDispositionRow.project_id == project_id,
                FindingDispositionRow.fingerprint.in_(set(fingerprints)),
                FindingDispositionRow.revoked_at.is_(None),
            )
            .values(**values)
        )
        self._s.flush()

    def _standing(self, project_id: int, clause) -> dict[str, ActiveDisposition]:
        rows = self._s.execute(
            select(FindingDispositionRow, UserRow.email)
            .join(UserRow, UserRow.id == FindingDispositionRow.set_by)
            .where(
                FindingDispositionRow.project_id == project_id,
                clause,
                FindingDispositionRow.revoked_at.is_(None),
            )
        ).all()
        return {
            row.fingerprint: ActiveDisposition(
                fingerprint=row.fingerprint,
                disposition=row.disposition,  # type: ignore[arg-type]
                reason=row.reason,
                email=email,
                at=row.set_at.date().isoformat(),
            )
            for row, email in rows
        }


class SqlProjectConfigSource:
    """Reads the review setup out of `projects.config`, owned by the identity context."""

    def __init__(self, session: Session) -> None:
        self._s = session

    def config_for(self, project_id: int) -> ReviewConfig:
        row = self._s.get(ProjectRow, project_id)
        return ReviewConfig.from_dict(dict(row.config or {}) if row else {})

    def save(self, project_id: int, config: ReviewConfig) -> None:
        row = self._s.get(ProjectRow, project_id)
        if row is not None:
            row.config = config.to_dict()
