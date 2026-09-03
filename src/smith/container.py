"""Composition root. The only module allowed to construct adapters and wire them into services.

Everything else receives what it needs. If you find yourself importing an adapter anywhere but here,
that is the bug.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from smith.auth.postgres import (
    SqlApiKeyRepository,
    SqlLoginThrottle,
    SqlProjectRepository,
    SqlUserRepository,
)
from smith.auth.security import Argon2Hasher
from smith.auth.service import AuthService
from smith.db import make_engine, make_session_factory, unit_of_work
from smith.reviewer.adapters.depcruise import DependencyCruiserAnalyzer
from smith.reviewer.adapters.eslint import EslintAnalyzer
from smith.reviewer.adapters.pmd import PmdAnalyzer
from smith.reviewer.adapters.postgres import (
    SqlDispositionStore,
    SqlProjectConfigSource,
    SqlReviewStore,
)
from smith.reviewer.adapters.yaml_rules import YamlRuleSource
from smith.reviewer.ports import Analyzer, RuleSource
from smith.reviewer.service import ReviewService
from smith.settings import Settings

# Import for the side effect of registering the built-in rules in the registry.
import smith.reviewer.domain.rules  # noqa: F401


@dataclass
class Services:
    """One transaction's worth of use cases, all sharing a single session."""

    auth: AuthService
    reviewer: ReviewService
    _rules: RuleSource

    def rulesets(self) -> list[str]:
        return self._rules.names()

    def rule_overlays(self) -> list[str]:
        return self._rules.overlays()


class Container:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        # Public because a composition root sometimes needs the engine itself: the test suite builds
        # its sqlite schema straight from the metadata, since alembic revisions target postgres.
        self.engine = make_engine(settings.database_url)
        self._session_factory = make_session_factory(self.engine)
        self._hasher = Argon2Hasher()
        self._rules: RuleSource = YamlRuleSource(settings.rules_dir)
        # Each one is silent when its binary is missing, so this list costs nothing on a machine
        # that has none of them.
        self._analyzers: list[Analyzer] = [
            PmdAnalyzer(ruleset=Path(settings.rules_dir) / "pmd-java.xml"),
            EslintAnalyzer(),
            DependencyCruiserAnalyzer(),
        ]

    def build(self, session: Session) -> Services:
        auth = AuthService(
            users=SqlUserRepository(session),
            projects=SqlProjectRepository(session),
            keys=SqlApiKeyRepository(session),
            hasher=self._hasher,
            throttle=SqlLoginThrottle(session),
        )
        reviewer = ReviewService(
            store=SqlReviewStore(session),
            config_source=SqlProjectConfigSource(session),
            rules=self._rules,
            analyzers=self._analyzers,
            dispositions=SqlDispositionStore(session),
            max_diff_bytes=self.settings.max_diff_bytes,
        )
        return Services(auth=auth, reviewer=reviewer, _rules=self._rules)

    @contextmanager
    def transaction(self) -> Iterator[tuple[Session, Services]]:
        """For scripts and jobs: one transaction plus the session, in case raw repo access is needed."""
        with unit_of_work(self._session_factory) as session:
            yield session, self.build(session)

    def session(self) -> Iterator[Services]:
        with unit_of_work(self._session_factory) as session:
            yield self.build(session)

    def dependency(self) -> Callable[[], Iterator[Services]]:
        """The FastAPI dependency routers use: one transaction per request, committed on success."""
        return self.session
