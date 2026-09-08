"""Identity use cases. Depends on ports only."""

from __future__ import annotations

import re
import secrets

from smith.auth.domain import (
    UNUSABLE_PASSWORD,
    AuthError,
    Forbidden,
    Member,
    Principal,
    Project,
    Role,
    TooManyAttempts,
    User,
    key_prefix,
    new_api_key,
)
from smith.auth.ports import (
    ApiKeyRepository,
    Hasher,
    LoginThrottle,
    ProjectRepository,
    UserRepository,
)

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$")

_dummy_hash: str | None = None


def _decoy(hasher: Hasher, presented: str) -> None:
    """Burn one real verification when no record matched.

    Without it, a wrong email returns before any hashing and a wrong password returns after ~100ms
    of argon2 — a timing oracle for enumerating accounts and probing key prefixes.
    """
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hasher.hash(secrets.token_urlsafe(32))
    hasher.verify(_dummy_hash, presented)


class AuthService:
    def __init__(
        self,
        users: UserRepository,
        projects: ProjectRepository,
        keys: ApiKeyRepository,
        hasher: Hasher,
        throttle: LoginThrottle,
    ) -> None:
        self._users = users
        self._projects = projects
        self._keys = keys
        self._hasher = hasher
        self._throttle = throttle

    # --- humans (web UI) ---

    def register(self, email: str, name: str, password: str) -> User:
        email = email.strip().lower()
        if len(password) < 12:
            raise AuthError("password must be at least 12 characters")
        if self._users.by_email(email):
            raise AuthError("email already registered")
        return self._users.create(email, name.strip(), self._hasher.hash(password))

    def login(self, email: str, password: str, ip: str = "") -> User:
        email = email.strip().lower()
        # Both keys, because either one alone is easy to walk around: an attacker with a botnet
        # rotates the address, and one on a single host walks the account list.
        keys = [f"email:{email}"] + ([f"ip:{ip}"] if ip else [])

        # Checked before anything is hashed. argon2 is the expensive part on purpose, which makes
        # an unthrottled login endpoint a way to spend the server's CPU as well as guess passwords.
        if self._throttle.blocked(keys):
            raise TooManyAttempts("too many failed attempts, try again later")

        found = self._users.by_email(email)
        if found is None:
            _decoy(self._hasher, password)
            self._throttle.record_failure(keys)
            raise AuthError("invalid credentials")
        user, password_hash = found
        if password_hash == UNUSABLE_PASSWORD:
            # A developer account created by a lead. It has no password and must not get one by
            # accident; same error as any other failure, so it leaks nothing.
            _decoy(self._hasher, password)
            self._throttle.record_failure(keys)
            raise AuthError("invalid credentials")
        if not self._hasher.verify(password_hash, password):
            self._throttle.record_failure(keys)
            raise AuthError("invalid credentials")
        self._throttle.clear(keys)
        return user

    def session_principal(self, user_id: int, email: str, project_slug: str | None = None) -> Principal:
        if project_slug is None:
            return Principal(user_id=user_id, email=email, via="session")
        project = self._require_project(project_slug)
        role = self._projects.role_of(user_id, project.id)
        if role is None:
            raise Forbidden("not a member of this project")
        return Principal(user_id, email, project.id, role, via="session")

    def projects_of(self, user_id: int) -> list[tuple[Project, Role]]:
        return self._projects.for_user(user_id)

    # --- projects and membership ---

    def create_project(self, actor: Principal, slug: str, name: str, config: dict) -> Project:
        """Whoever creates a project leads it. No org-wide admin role exists, and none is needed."""
        slug = slug.strip().lower()
        if not slug or not _SLUG_RE.match(slug):
            raise AuthError("slug must be lowercase letters, digits and dashes")
        if self._projects.by_slug(slug):
            raise AuthError("a project with that slug already exists")
        project = self._projects.create(slug, name.strip() or slug, config)
        self._projects.add_member(actor.user_id, project.id, "lead")
        return project

    def add_member(self, actor: Principal, project_slug: str, email: str, role: Role) -> Member:
        """Put someone on a project, creating a passwordless account if they have none yet.

        A developer never signs in — they use a key. Creating the account here is what makes their
        reviews attributable to them instead of to whoever handed them the key.
        """
        project = self._require_lead(actor, project_slug)
        email = email.strip().lower()
        if role not in ("lead", "dev"):
            raise AuthError("role must be lead or dev")

        found = self._users.by_email(email)
        user = found[0] if found else self._users.create(email, email, UNUSABLE_PASSWORD)

        current = self._projects.role_of(user.id, project.id)
        if current is None:
            self._projects.add_member(user.id, project.id, role)
        elif current != role:
            self._change_role(project, user.id, current, role)
        return Member(user=user, role=role)

    def set_member_role(self, actor: Principal, project_slug: str, email: str, role: Role) -> None:
        project = self._require_lead(actor, project_slug)
        user = self._require_member_user(project, email)
        current = self._projects.role_of(user.id, project.id)
        if current is None:
            raise AuthError("not a member of this project")
        if current != role:
            self._change_role(project, user.id, current, role)

    def remove_member(self, actor: Principal, project_slug: str, email: str) -> None:
        project = self._require_lead(actor, project_slug)
        user = self._require_member_user(project, email)
        role = self._projects.role_of(user.id, project.id)
        if role == "lead" and self._projects.count_leads(project.id) <= 1:
            raise Forbidden("a project must keep at least one lead")
        if not self._projects.remove_member(user.id, project.id):
            raise AuthError("not a member of this project")

    def delete_project(self, actor: Principal, project_slug: str) -> None:
        """Remove a project and everything recorded under it.

        The last exit the product had none of. A lead may delete their own last project: the
        "keep at least one lead" rule is about who is left inside a project, and it does not
        outlive the project itself.
        """
        project = self._require_lead(actor, project_slug)
        self._projects.delete(project.id)

    def members(self, actor: Principal, project_slug: str) -> list[Member]:
        project = self._require_lead(actor, project_slug)
        return self._projects.members(project.id)

    def _change_role(self, project: Project, user_id: int, current: Role, role: Role) -> None:
        if current == "lead" and role != "lead" and self._projects.count_leads(project.id) <= 1:
            raise Forbidden("a project must keep at least one lead")
        self._projects.set_role(user_id, project.id, role)

    def _require_member_user(self, project: Project, email: str) -> User:
        found = self._users.by_email(email.strip().lower())
        if found is None:
            raise AuthError("no such user")
        return found[0]

    # --- machines (plugin) ---

    def issue_key(
        self, actor: Principal, project_slug: str, name: str, for_email: str | None = None
    ) -> tuple[str, int]:
        """Mint a project-scoped key for a member. Returns (full_key, key_id), shown once.

        `for_email` is what makes a lead able to see who did what: a key handed to a developer is
        bound to *that developer*, so their reviews are attributed to them and not to the lead who
        created the key.
        """
        project = self._require_lead(actor, project_slug)
        if for_email:
            owner = self._require_member_user(project, for_email)
            if self._projects.role_of(owner.id, project.id) is None:
                raise Forbidden("that user is not a member of this project")
        else:
            owner = User(id=actor.user_id, email=actor.email, name="")
        raw, prefix = new_api_key()
        key_id = self._keys.create(project.id, owner.id, name, prefix, self._hasher.hash(raw))
        return raw, key_id

    def authenticate_key(self, raw: str) -> Principal:
        prefix = key_prefix(raw)
        if prefix is None:
            raise AuthError("malformed key")
        found = self._keys.by_prefix(prefix)
        if found is None:
            _decoy(self._hasher, raw)
            raise AuthError("unknown key")
        key_id, user_id, project_id, key_hash = found
        if not self._hasher.verify(key_hash, raw):
            raise AuthError("invalid key")
        user = self._users.by_id(user_id)
        self._keys.touch(key_id)
        role = self._projects.role_of(user_id, project_id)
        project = self._projects.by_id(project_id)
        return Principal(
            user_id=user_id,
            email=user.email if user else "",
            project_id=project_id,
            role=role,
            via="api_key",
            project_slug=project.slug if project else "",
        )

    def revoke_key(self, actor: Principal, project_slug: str, key_id: int) -> None:
        project = self._require_lead(actor, project_slug)
        if not self._keys.revoke(key_id, project.id):
            raise AuthError("no such key")

    def list_keys(self, actor: Principal, project_slug: str) -> list[dict]:
        project = self._require_lead(actor, project_slug)
        return self._keys.list_for_project(project.id)

    def _require_project(self, slug: str) -> Project:
        project = self._projects.by_slug(slug)
        if project is None:
            # Same answer as "you are not a member": a stranger cannot map which projects exist.
            raise Forbidden("unknown project")
        return project

    def _require_lead(self, actor: Principal, slug: str) -> Project:
        """A non-member is told the project is unknown, exactly as if it did not exist.

        Telling them "only a project lead can do this" would confirm the project is real, which is
        the enumeration `_require_project` refuses one line above. A member who is not a lead has
        already been told the project exists by being in it, so they get the useful message.
        """
        project = self._require_project(slug)
        role = self._projects.role_of(actor.user_id, project.id)
        if role is None:
            raise Forbidden("unknown project")
        if role != "lead":
            raise Forbidden("only a project lead can do this")
        return project
