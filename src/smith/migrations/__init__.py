"""Alembic migrations, plus the one helper that lets a composition root run them in-process.

Scripts and tests build the config here instead of shelling out to the `alembic` CLI: the URL comes
from the caller, so a scratch database needs no environment juggling.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config


def alembic_config(database_url: str) -> Config:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parent))
    config.set_main_option("sqlalchemy.url", database_url)
    return config
