"""What this package needs of a blob store, and nothing more.

Bytes are named by their sha256, which is what makes `Store` idempotent:
re-uploading the same bytes is a no-op, a mismatched hash is refused before
anything is written, and a cached blob can never be stale -- only pointers to
it can. Any store that can honour those three answers will do.
"""

from __future__ import annotations

import hashlib
import re
from typing import Protocol, runtime_checkable

SHA256 = re.compile(r"^[0-9a-f]{64}$")


def digest_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def names_bytes(digest: str) -> bool:
    """Whether this could be a sha256 at all -- checked before it reaches a
    store, so no implementation has to defend its own namespace."""
    return SHA256.match(digest) is not None


@runtime_checkable
class Blobs(Protocol):
    """Async because a real store is a network away, even when the first one
    written is not."""

    async def holds(self, digest: str) -> bool: ...

    async def read(self, digest: str) -> bytes: ...

    async def store(self, digest: str, data: bytes) -> bool:
        """False when the bytes are not what the name claims -- nothing written."""
        ...
