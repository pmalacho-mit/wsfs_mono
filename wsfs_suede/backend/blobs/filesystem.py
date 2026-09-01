"""A blob store on a local disk. Enough for one machine, and a worked example
of the protocol for the object store that replaces it."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import final

from .protocol import digest_of, names_bytes


@final
class FilesystemBlobs:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    async def holds(self, digest: str) -> bool:
        return names_bytes(digest) and await asyncio.to_thread(self._path(digest).exists)

    async def read(self, digest: str) -> bytes:
        return await asyncio.to_thread(self._path(digest).read_bytes)

    async def store(self, digest: str, data: bytes) -> bool:
        if not names_bytes(digest) or digest_of(data) != digest:
            return False
        await asyncio.to_thread(self._write_atomically, self._path(digest), data)
        return True

    def _path(self, digest: str) -> Path:
        if not names_bytes(digest):
            raise ValueError(f"not a sha256: {digest!r}")
        return self.root / digest

    @staticmethod
    def _write_atomically(path: Path, data: bytes) -> None:
        staged = path.with_suffix(".staged")
        _ = staged.write_bytes(data)
        os.replace(staged, path)
