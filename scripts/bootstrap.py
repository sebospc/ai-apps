"""Create the schema, the first lead, a project and its first API key.

    uv run python scripts/bootstrap.py --email me@co.com --password '...' --project acme

Prints the API key once. Paste it into the plugin; it cannot be retrieved again.

This script is a composition root, so it is allowed to build adapters directly.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from alembic import command  # noqa: E402

from smith.auth.domain import AuthError, Principal  # noqa: E402
from smith.auth.postgres import SqlProjectRepository, SqlUserRepository  # noqa: E402
from smith.container import Container  # noqa: E402
from smith.migrations import alembic_config  # noqa: E402
from smith.reviewer.domain.models import ReviewConfig  # noqa: E402
from smith.settings import Settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True, help="at least 12 characters")
    parser.add_argument("--name", default="")
    parser.add_argument("--project", required=True, help="project slug")
    parser.add_argument("--project-name", default="")
    parser.add_argument("--ruleset", default="sap-commerce-base")
    args = parser.parse_args()

    settings = Settings()
    command.upgrade(alembic_config(settings.database_url), "head")
    container = Container(settings)

    with container.transaction() as (session, services):
        users = SqlUserRepository(session)
        projects = SqlProjectRepository(session)

        found = users.by_email(args.email.strip().lower())
        if found:
            user = found[0]
            print(f"user {user.email} already exists, reusing")
        else:
            try:
                user = services.auth.register(args.email, args.name or args.email, args.password)
            except AuthError as exc:
                print(f"error: {exc}")
                return 1
            print(f"created user {user.email}")

        project = projects.by_slug(args.project)
        if project is None:
            project = projects.create(
                args.project,
                args.project_name or args.project,
                ReviewConfig(ruleset=args.ruleset).to_dict(),
            )
            print(f"created project {project.slug}")

        if projects.role_of(user.id, project.id) is None:
            projects.add_member(user.id, project.id, "lead")
            print(f"{user.email} is now lead of {project.slug}")

        actor = Principal(user_id=user.id, email=user.email, via="session")
        raw, _ = services.auth.issue_key(actor, project.slug, "bootstrap")

    print("\nAPI key (shown once):")
    print(f"  {raw}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
