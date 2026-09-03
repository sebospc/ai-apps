"""YAML rule source. Rulesets are files on disk: `<rules_dir>/<name>.yaml`.

Guidelines (prose, judged by the agent) and checks (regex, judged by the server) live in the same
file because they describe the same rule from two sides.

A client's ruleset is an overlay: `<rules_dir>/clients/<slug>.yaml`, holding only what differs from
a base. `load("sap-commerce-base+acme")` composes them, base first.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path

import yaml

from smith.reviewer.domain.models import IGNORE_PATHS, Check, Guideline, RuleSet

logger = logging.getLogger(__name__)

# Overlays live one directory down so `names()` keeps listing bases only: a client overlay is not
# something a project can be pointed at on its own.
_OVERLAY_DIR = "clients"


class YamlRuleSource:
    def __init__(self, rules_dir: str | Path) -> None:
        self._dir = Path(rules_dir)

    def names(self) -> list[str]:
        return sorted(p.stem for p in self._dir.glob("*.yaml"))

    def overlays(self) -> list[str]:
        return sorted(p.stem for p in (self._dir / _OVERLAY_DIR).glob("*.yaml"))

    def load(self, name: str) -> RuleSet:
        """A base name, or a base and its client overlays joined by `+`."""
        base_name, *overlay_names = name.split("+")
        composed, _ = self._read(self._dir, base_name)
        for overlay_name in overlay_names:
            overlay, disabled = self._read(self._dir / _OVERLAY_DIR, overlay_name)
            composed = _compose(composed, overlay, disabled)
        return replace(composed, name=name)

    def _read(self, directory: Path, name: str) -> tuple[RuleSet, set[str]]:
        """The ruleset in one file, plus the base ids it switches off. A file that is missing or
        unreadable contributes nothing, so one bad overlay cannot take a review down."""
        path = directory / f"{Path(name).name}.yaml"  # basename only: never traverse out of rules_dir
        if not path.is_file():
            logger.warning("ruleset %s not found in %s", name, directory)
            return RuleSet(name=name), set()
        try:
            raw = yaml.safe_load(path.read_text()) or {}
        except yaml.YAMLError:
            logger.exception("ruleset %s is not valid YAML", name)
            return RuleSet(name=name), set()

        ignore_paths = raw.get("ignore_paths")
        ruleset = RuleSet(
            name=name,
            guidelines=[_guideline(r) for r in raw.get("rules") or [] if r.get("id")],
            checks=[_check(c) for c in raw.get("checks") or [] if c.get("id") and c.get("pattern")],
            ignore_paths=[str(p) for p in ignore_paths] if ignore_paths else list(IGNORE_PATHS),
        )
        return ruleset, {str(d) for d in raw.get("disabled") or []}


def _compose(base: RuleSet, overlay: RuleSet, disabled: set[str]) -> RuleSet:
    """Base first, then the client's differences. An id in `disabled:` switches off the guideline
    and every check that reports it, so a lead names the rule they mean rather than both halves."""
    return replace(
        base,
        guidelines=[g for g in base.guidelines if g.id not in disabled] + overlay.guidelines,
        checks=[c for c in base.checks if not _switched_off(c, disabled)] + overlay.checks,
    )


def _switched_off(check: Check, disabled: set[str]) -> bool:
    return check.id in disabled or check.rule_id in disabled

def _guideline(raw: dict) -> Guideline:
    scope = raw.get("scope")
    return Guideline(
        id=str(raw["id"]),
        text=str(raw.get("text", "")),
        severity=raw.get("severity", "warning"),
        why=raw.get("why"),
        fix=raw.get("fix"),
        scope=[scope] if isinstance(scope, str) else list(scope or []),
        issue_type=raw.get("default_issue_type") or "logic",
        since=_version(raw.get("since")),
        until=_version(raw.get("until")),
    )


def _version(raw: object) -> str | None:
    """YAML reads a bare `2211` as an int; a version is text either way."""
    return None if raw is None else str(raw)


def _check(raw: dict) -> Check:
    return Check(
        id=str(raw["id"]),
        file_pattern=str(raw.get("file_pattern", "*")),
        pattern=str(raw["pattern"]),
        message=str(raw.get("message", "")),
        rule_id=raw.get("rule_id"),
        severity=raw.get("severity", "warning"),
        issue_type=raw.get("issue_type", "bug"),
        exclude_file_pattern=raw.get("exclude_file_pattern"),
        exclude_line_pattern=raw.get("exclude_line_pattern"),
        match_on=raw.get("match_on", "added"),
        context_pattern=raw.get("context_pattern"),
        context_window=int(raw.get("context_window", 6)),
        suggestion=raw.get("suggestion"),
        since=_version(raw.get("since")),
        until=_version(raw.get("until")),
    )
