"""Hasher adapter. The only place argon2 is imported."""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError


class Argon2Hasher:
    def __init__(self) -> None:
        self._ph = PasswordHasher()

    def hash(self, secret: str) -> str:
        return self._ph.hash(secret)

    def verify(self, hashed: str, secret: str) -> bool:
        try:
            return self._ph.verify(hashed, secret)
        except (VerifyMismatchError, VerificationError, ValueError):
            return False
