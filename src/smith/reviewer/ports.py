"""Ports the reviewer needs. Everything outside the domain arrives through one of these."""

from __future__ import annotations

from typing import Protocol

from smith.reviewer.domain.models import (
    ActiveDisposition,
    Disposition,
    FileDiff,
    Finding,
    RuleHealth,
    ReviewConfig,
    ReviewDetail,
    ReviewSummary,
    RuleSet,
    Verdict,
)


class RuleSource(Protocol):
    def load(self, name: str) -> RuleSet:
        """Load a ruleset by name — `base` or `base+client`. Unknown name -> empty RuleSet, never
        an exception."""

    def names(self) -> list[str]: ...

    def overlays(self) -> list[str]:
        """Client overlays, which compose onto a base rather than standing on their own."""


class Analyzer(Protocol):
    """An external deterministic tool (PMD today). Must degrade to [] when unavailable."""

    name: str

    def run(
        self, diffs: list[FileDiff], files: dict[str, str], added: dict[str, set[int]]
    ) -> list[Finding]: ...


class ProjectConfigSource(Protocol):
    def config_for(self, project_id: int) -> ReviewConfig: ...

    def save(self, project_id: int, config: ReviewConfig) -> None: ...


class DispositionStore(Protocol):
    """A developer's answers to findings, scoped to a project and outliving any single review."""

    def set(
        self, project_id: int, fingerprint: str, disposition: Disposition, reason: str, user_id: int
    ) -> None:
        """Revoke whatever was standing for this (project, fingerprint) and record this instead."""

    def active(self, project_id: int, fingerprints: list[str]) -> dict[str, ActiveDisposition]:
        """The answers still standing, keyed by fingerprint. Unanswered fingerprints are absent."""

    def active_fixed(self, project_id: int) -> dict[str, ActiveDisposition]:
        """Every `fixed` claim in the project still waiting to be confirmed by the next review."""

    def confirm_fixed(self, project_id: int, fingerprints: list[str]) -> None:
        """The fix held: settle those claims as `confirmed_fixed` so they are not checked again."""

    def revoke(self, project_id: int, fingerprints: list[str]) -> None:
        """Drop the standing answers: the finding is back and whatever was said about it is stale."""


class ReviewStore(Protocol):
    def rule_health(self, project_id: int) -> list[RuleHealth]:
        """Per rule: how often it fired in this project, how often it was dismissed, and why."""

    def create(
        self,
        project_id: int,
        user_id: int,
        branch: str,
        title: str,
        added: dict[str, set[int]],
        files_changed: int,
    ) -> int: ...

    def owner_of(self, review_id: int, for_update: bool = False) -> tuple[int, int, str] | None:
        """(project_id, user_id, status) or None.

        `for_update` holds the review until the transaction ends, so two calls writing to the same
        review take turns instead of interleaving.
        """

    def added_lines(self, review_id: int) -> dict[str, set[int]]: ...

    def add_findings(self, review_id: int, findings: list[Finding]) -> None: ...

    def replace_agent_findings(self, review_id: int, findings: list[Finding]) -> None:
        """Drop any previous agent findings for this review, then store these. Makes resubmit idempotent."""

    def findings(self, review_id: int) -> list[Finding]: ...

    def add_step(self, review_id: int, kind: str, payload: dict) -> None:
        """Append-only trail of what happened, in order. This is what a lead reads later."""

    def complete(self, review_id: int, verdict: Verdict) -> None: ...

    def list_for_project(
        self,
        project_id: int,
        only_user_id: int | None,
        limit: int,
        author_email: str | None = None,
    ) -> list[ReviewSummary]:
        """Newest first. `only_user_id` restricts to one author — that is how a developer is limited
        to their own reviews without the caller having to filter afterwards. `author_email` is the
        lead's own filter, applied on top: both narrow, neither widens."""

    def detail(self, review_id: int) -> ReviewDetail | None: ...
