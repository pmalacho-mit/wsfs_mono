"""Keeping each entry's Liveblocks room in step with its file.

The seeding race the browsers used to run among themselves, moved to the one
place that has a lock to settle it with.
"""

from __future__ import annotations

import asyncio
from typing import Protocol, final
from uuid import UUID

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

from .collaboration import ICollaboration
from .rooms import (
    Carry,
    Change,
    Held,
    Plan,
    Rebase,
    Seed,
    Settled,
    carried,
    plan,
    seeded,
    standing_of,
)
from .models import RoomRow, Models
from .resolve import resolve_content
from .service import Workspaces


class Files(Protocol):
    async def now(self, entry: str) -> Held | None:
        """What the file says, or None when it is not text a room can hold."""

    async def at(self, entry: str, version: str) -> str: ...


class Standings(Protocol):
    """What this host remembers about each room, across restarts."""

    async def standing(self, entry: str) -> tuple[bool, str | None]:
        """Whether the room has been created, and where its text stands."""
        ...

    async def remember(self, entry: str, base: str | None) -> None: ...


@final
class Keeper:
    def __init__(
        self, *, collaboration: ICollaboration, files: Files, standings: Standings
    ) -> None:
        self._collaboration = collaboration
        self._files = files
        self._standings = standings
        self._alone: dict[str, asyncio.Lock] = {}
        self._known: dict[str, tuple[bool, str | None]] = {}
        """What `standings` last said, so the hot path asks nothing at all.

        THE WHOLE POINT. Every client with a file open asks this host to
        settle its room each time anybody saves -- so if answering meant a
        round trip to the collaboration server, one person typing would cost
        one per collaborator per save. It does not even cost a query: the
        table is the durable copy, this is the one that answers.
        """

    async def ensure(self, entry: str) -> str | None:
        """Make this room say what the file says, and answer where it stands.

        Free when there is nothing to do: the common case by a wide margin,
        because the common reason to ask is that somebody just saved and every
        other client heard about it.
        """
        file = await self._files.now(entry)
        if file is None:
            return None
        if await self._standing(entry) == file.version:
            return file.version
        async with self._alone_with(entry):
            if await self._standing(entry) == file.version:
                return file.version
            await self._created_once(entry)
            await self._settle(entry, file)
        return await self._standing(entry)

    async def stored(self, entry: str, version: str) -> None:
        """A room member wrote the file, so the room already holds its text.

        Nothing is sent to the collaboration server. This is the whole
        saving: the alternative is every client that hears about the write
        asking it what the room contains, which this host already knows.
        """
        await self._moved(entry, version)

    async def _standing(self, entry: str) -> str | None:
        return (await self._remembered(entry))[1]

    async def _remembered(self, entry: str) -> tuple[bool, str | None]:
        if entry not in self._known:
            self._known[entry] = await self._standings.standing(entry)
        return self._known[entry]

    async def _moved(self, entry: str, base: str | None) -> None:
        created, _ = await self._remembered(entry)
        self._known[entry] = (created, base)
        await self._standings.remember(entry, base)

    async def hand_over(self, entry: str, update: bytes) -> None:
        """Put one client's own update into the room on its behalf.

        For a client that can reach THIS server but not the collaboration one.
        Its work would otherwise sit on its machine until that connection came
        back, which can be a long time and is not a good enough reason for
        nobody else to see it.

        Forwarded rather than interpreted. The update carries its own
        identities, so it merges exactly once however many routes it arrives
        by -- including the client's own connection when that returns.
        """
        async with self._alone_with(entry):
            await self._created_once(entry)
            await self._collaboration.send(entry, update)

    def _alone_with(self, entry: str) -> asyncio.Lock:
        """One entry at a time, and only against itself.

        A registry-wide lock would put every first open behind one round trip
        to Liveblocks.
        """
        return self._alone.setdefault(entry, asyncio.Lock())

    async def _created_once(self, entry: str) -> None:
        """Created there once, ever.

        Nothing here destroys a room, so this is a fact rather than a state --
        which is why it is remembered across restarts instead of being asked
        about again on the first file anybody opens.
        """
        created, base = await self._remembered(entry)
        if created:
            return
        await self._collaboration.create(entry)
        self._known[entry] = (True, base)
        await self._standings.remember(entry, base)

    async def _settle(self, entry: str, file: Held) -> None:
        room = standing_of(
            await self._collaboration.document(entry), await self._standing(entry)
        )
        await self._act(entry, plan(room, file))
        await self._moved(entry, file.version)

    async def _act(self, entry: str, wanted: Plan) -> None:
        if isinstance(wanted, Settled):
            return
        if isinstance(wanted, Seed):
            await self._collaboration.send(entry, seeded(wanted.text))
            return
        if isinstance(wanted, Rebase):
            return  # the room already says it; only this host had to be told
        await self._carry(entry, wanted)

    async def _carry(self, entry: str, wanted: Carry) -> None:
        """Built on the room as it stands NOW, re-read rather than remembered.

        A Yjs update computed against a stale document is dropped without a
        word, so the read that decided this cannot be the read it is built on.
        """
        now = await self._files.now(entry)
        if now is None:
            return
        change = Change(
            before=await self._files.at(entry, wanted.since),
            after=now.text,
        )
        live = await self._collaboration.document(entry)
        update = self._closing(live, change)
        if update is not None:
            await self._collaboration.send(entry, update)

    def _closing(self, live: bytes, change: Change) -> bytes | None:
        """What to send, decided against the read it is built on.

        The decision was taken on an EARLIER read, and a room that caught up in
        between already holds what this was going to insert. Inserting it again
        is the doubling the whole design exists to prevent, and a CRDT cannot
        notice that two inserts say the same thing -- so the question is asked
        once more, here, where the answer cannot go stale.
        """
        if standing_of(live, None).text == change.after:
            return None
        return carried(live, change)


@final
class RememberedRooms:
    """The room table, as the keeper wants it.

    Read through the keeper's own cache, so this is touched when a room is
    first asked about and when it moves -- not on the path that repeats.
    """

    def __init__(self, models: Models, database: Database) -> None:
        self._models = models
        self._database = database

    async def standing(self, entry: str) -> tuple[bool, str | None]:
        async with self._database.session() as session:
            held = await self._held(session, UUID(entry))
            if held is None:
                return (False, None)
            return (True, None if held.base is None else str(held.base))

    async def remember(self, entry: str, base: str | None) -> None:
        async with self._database.session() as session:
            held = await self._held(session, UUID(entry))
            if held is None:
                held = self._models.room(entry_id=UUID(entry), base=None)
            held.base = None if base is None else UUID(base)
            session.add(held)
            await session.commit()

    async def _held(self, session: AsyncSession, entry: UUID) -> RoomRow | None:
        rooms = self._models.room
        return (
            await session.exec(select(rooms).where(col(rooms.entry_id) == entry))
        ).first()


@final
class WsfsFiles:
    """What wsfs says a file holds, for a keeper that knows only entries."""

    def __init__(self, workspace_schema: Workspaces, database: Database) -> None:
        self._workspace_schema = workspace_schema
        self._database = database

    async def now(self, entry: str) -> Held | None:
        async with self._database.session() as session:
            held = await self._held(session, UUID(entry))
            if held is None:
                return None
            if not self._is_text(held):
                return None
            return Held(text=await self._text_of(session, held), version=str(held.id))

    async def at(self, entry: str, version: str) -> str:
        async with self._database.session() as session:
            held = await self._held(session, UUID(entry), UUID(version))
            if held is None or not self._is_text(held):
                return ""
            return await self._text_of(session, held)

    async def _held(
        self, session: AsyncSession, entry: UUID, version: UUID | None = None
    ):
        workspace = await self._workspace_of(session, entry)
        if workspace is None:
            return None
        return await resolve_content(
            self._workspace_schema, session, workspace, entry, version
        )

    def _is_text(self, held: object) -> bool:
        return isinstance(held, self._workspace_schema.models.text_content)

    async def _text_of(self, session: AsyncSession, held) -> str:
        return await self._workspace_schema.text.at(
            session, held.entry_id, held.position
        )

    async def _workspace_of(self, session: AsyncSession, entry: UUID) -> UUID | None:
        """An entry belongs to exactly one workspace, so nobody need be told.

        None when the server has never heard of it, which is ordinary rather
        than exceptional: a client shows a file the moment it is asked for and
        opens its room straight away, so the room can be asked about before
        the create it belongs to has landed.
        """
        rows = self._workspace_schema.models.entry
        found = (await session.exec(select(rows).where(col(rows.id) == entry))).first()
        return None if found is None else found.workspace_id
