"""Infrastructure settings. Product configuration lives in the DB, not here."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="SMITH_", extra="ignore")

    database_url: str = "postgresql+psycopg://smith:smith@localhost:5433/reviewer"
    secret_key: str = "dev-only-change-me"
    cookie_secure: bool = False
    session_days: int = 7
    max_diff_bytes: int = 2_000_000
    # Refused on the headers, before the body is read. Sized against a real client codebase: every
    # reviewable file in it comes to 20.3 MB, so no honest review reaches this and an upload that
    # does is not one.
    max_request_bytes: int = 25_000_000
    rules_dir: str = "rules"
