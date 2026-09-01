"""The event stream, which is the logs themselves.

One applied transaction takes exactly one workspace position, and which log
its rows landed in IS which event it was. Nothing publishes events; there is
no second write to fail independently of the first, and nothing to derive by
comparing a row against its predecessor.
"""

from __future__ import annotations

from itertools import chain, groupby
from operator import attrgetter
from typing import TypeVar, final
from uuid import UUID

from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Event, Kind, Metadata, Moved, StreamEvent
from .models import (
    ContentRow,
    DeletionRow,
    EntryRow,
    Models,
    NameRow,
    ParentRow,
    TextContentRow,
    TransactionRow,
)
from .tree import Held, Node, occurrence_of


@final
class Emitted:
    """An event and the stream position it was committed at.

    The position never reaches a client -- it exists so a stream can splice
    its replay onto its live feed without sending anything twice.
    """

    __slots__ = ("position", "event")

    def __init__(self, position: int, event: StreamEvent) -> None:
        self.position = position
        self.event = event


@final
class Positions:
    """A workspace's stream positions, handed out in order.

    Seeded from the logs when a controller takes the workspace on, and kept in
    memory after that: the controller is the workspace's only writer, so there
    is nothing else to consult. A submission that rolls back leaves a gap,
    which costs nothing -- positions have to increase, not to be dense.
    """

    def __init__(self, used: int) -> None:
        self._used = used

    @property
    def at(self) -> int:
        return self._used

    def take(self) -> int:
        self._used += 1
        return self._used


@final
class Stream:
    def __init__(self, models: Models) -> None:
        self.models = models

    @property
    def logs(self) -> tuple[type[TransactionRow], ...]:
        return self.models.logs

    async def _changes(
        self,
        session: AsyncSession,
        log: type[TransactionRow],
        workspace_id: UUID,
        after: int,
        through: int | None,
    ) -> list[TransactionRow]:
        entry = self.models.entry
        applied = (
            select(log)
            .join(entry, col(entry.id) == col(log.entry_id))
            .where(col(entry.workspace_id) == workspace_id, col(log.position) > after)
        )
        if through is not None:
            applied = applied.where(col(log.position) <= through)
        return list(await session.exec(applied))

    def _value(
        self, event: Event, applied: list[TransactionRow], entry: EntryRow
    ) -> Metadata | Moved | str | UUID | bool | None:
        """What a transaction says about the entry it names."""
        if event is Event.CREATE:
            return self._born(applied, entry)
        if event is Event.MOVE:
            return Moved(
                name=_one(applied, NameRow).name,
                parent=_one(applied, ParentRow).parent_entry_id,
            )
        if event is Event.NAME:
            return _one(applied, NameRow).name
        if event is Event.PARENT:
            return _one(applied, ParentRow).parent_entry_id
        if event is Event.DELETE:
            return _one(applied, DeletionRow).deleted
        # A write is a PURE INVALIDATION SIGNAL: cached content and its kind
        # are stale, and the next Content fetch reveals the rest.
        return None

    def _born(self, applied: list[TransactionRow], entry: EntryRow) -> Metadata:
        """A create writes every log at once, which is exactly what makes it
        recognisable: no other transaction touches more than one."""
        naming = _one(applied, NameRow)
        parentage = _one(applied, ParentRow)
        deletion = _one(applied, DeletionRow)
        content = _first(applied, ContentRow)
        return Node(
            entry=entry,
            name=naming.name,
            name_version=naming.id,
            name_position=naming.position,
            parent=parentage.parent_entry_id,
            parent_version=parentage.id,
            deleted=deletion.deleted,
            deleted_version=deletion.id,
            content=None
            if content is None
            else Held(
                content.id,
                content.position,
                self._kind(content),
                occurrence_of(content),
            ),
            # A birth is ONE transaction, so every row here shares an
            # occurrence and there is nothing to pick between.
            modified=occurrence_of(naming),
        ).metadata

    def _kind(self, content: ContentRow) -> Kind:
        return Kind.TEXT if isinstance(content, TextContentRow) else Kind.BINARY

    async def emitted(
        self, session: AsyncSession, applied: list[TransactionRow]
    ) -> Emitted:
        """The event one transaction's rows are.

        Public because the choke point has these rows in its hand the moment
        it writes them: reading them back out of five logs to say what just
        happened would be asking the database to tell us what we told it.
        """
        caused = applied[0]
        entry = await session.get(self.models.entry, caused.entry_id)
        assert entry is not None
        event = announced(applied)
        return Emitted(
            position=caused.position,
            event=StreamEvent(
                type=event,
                id=caused.entry_id,
                transaction=caused.id,
                value=self._value(event, applied, entry),
                user=caused.user_id,
                at=occurrence_of(caused),
            ),
        )

    async def _between(
        self, session: AsyncSession, workspace_id: UUID, after: int, through: int | None
    ) -> list[Emitted]:
        applied = sorted(
            chain.from_iterable(
                [
                    await self._changes(session, log, workspace_id, after, through)
                    for log in self.logs
                ]
            ),
            key=lambda row: (row.position, row.id),
        )
        # Grouped by the transaction that wrote them, which is what actually
        # makes rows one event. Position only orders the result -- so two
        # writers that somehow collided on one would produce an ugly stream,
        # never a wrong one.
        return [
            await self.emitted(session, list(rows))
            for _, rows in groupby(applied, key=attrgetter("id"))
        ]

    async def since(
        self, session: AsyncSession, workspace_id: UUID, position: int
    ) -> list[Emitted]:
        """Everything after `position`, as ONE observation of the five logs.

        Repeatable read, and not for tidiness. A transaction's rows are spread
        across up to four logs, and read committed hands every statement its
        own snapshot -- so a transaction committing between two of these five
        queries is seen in some logs and not in others. A folder create caught
        that way arrives as {parent, deletion}, which is not an event at all;
        caught the other way it arrives as a bare `name`, which IS one, for an
        entry the client has never heard of. The first kills the stream loudly
        and the second loses the entry in silence, which is worse.

        The rows were one transaction when they were written, and this is what
        makes them one transaction when they are read. It has to be the first
        statement in its transaction: postgres fixes the snapshot at the first
        read and will not change the level afterwards.
        """
        _ = await session.connection(
            execution_options={"isolation_level": "REPEATABLE READ"}
        )
        return await self._between(session, workspace_id, after=position, through=None)

    async def high_water(self, session: AsyncSession, workspace_id: UUID) -> int:
        """The last position this workspace used, read out of the logs.

        Not out of a stored counter: a counter is only as current as its last
        write, and a process that dies without ceremony would leave the next
        one re-issuing positions that are already committed. The rows cannot
        lie.
        """
        entry = self.models.entry
        used: list[int | None] = [
            (
                await session.exec(
                    select(func.max(col(log.position)))
                    .join(entry, col(entry.id) == col(log.entry_id))
                    .where(col(entry.workspace_id) == workspace_id)
                )
            ).one()
            for log in self.logs
        ]
        return max((position for position in used if position is not None), default=0)


SHAPES = (NameRow, ParentRow, DeletionRow, ContentRow)

ANNOUNCES: dict[frozenset[type[TransactionRow]], Event] = {
    frozenset({NameRow, ParentRow, DeletionRow}): Event.CREATE,
    frozenset({NameRow, ParentRow, DeletionRow, ContentRow}): Event.CREATE,
    frozenset({NameRow, ParentRow}): Event.MOVE,
    frozenset({NameRow}): Event.NAME,
    frozenset({ParentRow}): Event.PARENT,
    frozenset({DeletionRow}): Event.DELETE,
    frozenset({ContentRow}): Event.WRITE,
}


def announced(applied: list[TransactionRow]) -> Event:
    """Which logs a transaction wrote IS which event it was.

    A create writes the three that place an entry (and the content a file is
    born with); a move writes the two that say where it lives; everything else
    writes exactly one.
    """
    wrote = frozenset(
        shape for shape in SHAPES if any(isinstance(row, shape) for row in applied)
    )
    if wrote not in ANNOUNCES:
        # Unreachable: every operation writes one of these combinations, and
        # `since` reads all five logs at one snapshot so a transaction cannot
        # be seen half-written. Named anyway, because the bare KeyError this
        # replaces said only that a frozenset was missing.
        raise AssertionError(
            f"no event writes {sorted(shape.__name__ for shape in wrote)} "
            f"(transaction {applied[0].id})"
        )
    return ANNOUNCES[wrote]


Row = TypeVar("Row", bound=TransactionRow)


def _one(applied: list[TransactionRow], kind: type[Row]) -> Row:
    """The row a create wrote to one particular log -- there is exactly one."""
    (found,) = (row for row in applied if isinstance(row, kind))
    return found


def _first(applied: list[TransactionRow], kind: type[Row]) -> Row | None:
    """A folder is born without content, so this one may be missing."""
    return next((row for row in applied if isinstance(row, kind)), None)
