"""A collaboration service held in this process, for tests and for `--dev`.

The point of it is that it shares nothing with `Liveblocks` -- not a transport,
not an API shape, not a line of code -- so the fact that `ICollaboration` is
three methods stops being a claim in a docstring and becomes something two
implementations demonstrate.

WHAT IT IS NOT is a way for two browsers to edit the same file. Nothing here is
reachable from one: rooms live in this process's memory and go when it does.
The server-side half is the whole of it, which is exactly what the keeper needs
and exactly what a test of the keeper can drive.

Every room is a `pycrdt.Doc`, so an update merges here by the same algorithm it
would merge by anywhere -- which is what makes a room test that passes against
this one evidence about the other.
"""

from __future__ import annotations

import asyncio
from typing import Any, final

from pycrdt import Doc

NOTHING_WRITTEN = Doc().get_state()
"""The state vector of a document nothing has been put into.

Read off a fresh `Doc` rather than written out as a literal, because what it
encodes -- no client has contributed -- is the fact being asked about, and its
bytes are pycrdt's business.
"""


@final
class InProcessCollaboration:
    """Rooms in a dict, and a lock so a merge is not interleaved.

    Asynchronous like the protocol it satisfies, and it does mean it: `send`
    and `document` both take the lock, because two updates arriving at once
    must merge one after the other rather than each onto the state the other
    started from.
    """

    def __init__(self) -> None:
        self._rooms: dict[str, Doc[Any]] = {}
        self._lock = asyncio.Lock()

    async def create(self, room: str) -> None:
        """Idempotent, so a keeper that remembered wrongly costs nothing."""
        async with self._lock:
            self._rooms.setdefault(room, Doc())

    async def document(self, room: str) -> bytes:
        """Empty bytes for a room nobody has written to -- see the protocol.

        A room that does not exist and a room holding nothing answer the same
        thing on purpose. Raising for the first is the mistake the protocol's
        docstring warns about: it passes casual testing and breaks seeding,
        because the keeper's whole job is telling those two apart with a lock
        rather than guessing at them from a browser.

        AN EMPTY DOCUMENT IS NOT EMPTY BYTES, which is the trap here: a fresh
        `Doc` encodes as two bytes, not zero, so returning its update verbatim
        would make a room nobody has written to look written-to and stop the
        seeding this exists to allow.
        """
        async with self._lock:
            document = self._rooms.get(room)
            if document is None or document.get_state() == NOTHING_WRITTEN:
                return b""
            return document.get_update()

    async def send(self, room: str, update: bytes) -> None:
        """Merge, refusing a room that was never created.

        The refusal is not pedantry: writing to an uncreated room is what
        Liveblocks answers ROOM_NOT_FOUND for, and an implementation that
        quietly created one here would let a missing `create` pass every test
        and fail in production.
        """
        async with self._lock:
            document = self._rooms.get(room)
            if document is None:
                raise RuntimeError(f"no such room: {room}")
            document.apply_update(update)
