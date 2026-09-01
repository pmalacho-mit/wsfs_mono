"""What the tree currently denotes.

An entry's name, parent, deletion and content each live in their own log, so
"the current tree" is a query, not a table: for every entry, the newest row in
each of those logs.

Every query here is a query over ONE schema, which is why this is a class
rather than a module of functions -- the schema is the thing they all share,
and it is not known until a host says which tables its users and workspaces
live in.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from operator import itemgetter
from typing import Any, NamedTuple, final
from uuid import UUID

from sqlalchemy import ColumnElement, Row, func, literal, true, union_all
from sqlalchemy.orm import aliased
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Kind, Metadata, Occurrence
from .minted import minted_at
from .models import (
    ContentRow,
    DeletionRow,
    EntryRow,
    Models,
    NameRow,
    ParentRow,
    TransactionRow,
    Type,
)

BEFORE_ANY_POSITION = 0


def occurred(transaction: UUID, offset: int | None, accepted: datetime) -> Occurrence:
    """Both clocks that saw one transaction, from the three things a row holds.

    Taken apart rather than taking a row, because content reaches this through
    a union of two logs and arrives as columns rather than as an object.
    """
    return Occurrence(minted=minted_at(transaction), offset=offset, accepted=accepted)


def occurrence_of(row: TransactionRow) -> Occurrence:
    return occurred(row.id, row.utc_offset, row.timestamp)


Lookup = Callable[[UUID], Awaitable["Node | None"]]
"""How a walk asks for one entry -- so a caller can answer from what it knows."""


@final
@dataclass(frozen=True)
class Held:
    """Which write currently holds an entry's content, and where it landed."""

    version: UUID
    position: int
    kind: Kind
    at: Occurrence


@final
@dataclass(frozen=True)
class Node:
    """One entry as of the newest row in each of its logs."""

    entry: EntryRow
    name: str
    name_version: UUID
    name_position: int
    parent: UUID | None
    parent_version: UUID
    deleted: bool
    deleted_version: UUID
    content: Held | None
    modified: Occurrence
    """Whichever of the four rows above landed last -- the entry's mtime."""

    @property
    def id(self) -> UUID:
        return self.entry.id

    @property
    def is_folder(self) -> bool:
        return self.entry.type is Type.FOLDER

    @property
    def content_version(self) -> UUID | None:
        return None if self.content is None else self.content.version

    @property
    def content_position(self) -> int:
        return BEFORE_ANY_POSITION if self.content is None else self.content.position

    @property
    def metadata(self) -> Metadata:
        return Metadata(
            id=self.entry.id,
            type=self.entry.type,
            name=self.name,
            parent=self.parent,
            deleted=self.deleted or None,
            name_version=self.name_version,
            parent_version=self.parent_version,
            deleted_version=self.deleted_version,
            content_version=self.content_version,
            modified=self.modified,
        )


class Namespace(NamedTuple):
    """Every entry of a workspace, joined to the rows that place it."""

    statement: Any
    name: type[NameRow]
    parent: type[ParentRow]
    deletion: type[DeletionRow]


def modified_of(
    name: NameRow,
    parent: ParentRow,
    deletion: DeletionRow,
    content: Held | None,
) -> Occurrence:
    """Of the rows that currently place an entry, when the last of them landed.

    By position, because position is what orders a workspace -- not by either
    clock. A client's is not trusted enough to sort by, and the server's is
    only as fine as the machine's, so two transactions applied inside one
    microsecond could tie. The choke point already answered this question.

    A tie is not a problem when it happens: rows sharing a position share a
    transaction, so they share an occurrence too.
    """
    landed = [(row.position, occurrence_of(row)) for row in (name, parent, deletion)]
    if content is not None:
        landed.append((content.position, content.at))
    return max(landed, key=itemgetter(0))[1]


def node_of(row: Row[Any]) -> Node:
    entry, name, parent, deletion, version, position, kind, accepted, offset = row
    content = (
        None
        if version is None
        else Held(version, position, Kind(kind), occurred(version, offset, accepted))
    )
    return Node(
        entry=entry,
        name=name.name,
        name_version=name.id,
        name_position=name.position,
        parent=parent.parent_entry_id,
        parent_version=parent.id,
        deleted=deletion.deleted,
        deleted_version=deletion.id,
        content=content,
        modified=modified_of(name, parent, deletion, content),
    )


@final
class Tree:
    def __init__(self, models: Models) -> None:
        self.models = models

    # -- the shapes every query below is built from --------------------------

    def _newest(
        self,
        log: type[TransactionRow],
        workspace_id: UUID,
        entry_id: UUID | None = None,
    ) -> Any:
        """Each entry's most recent change to one property.

        `entry_id` narrows the newest-per-entry computation to one entry
        BEFORE it runs, rather than filtering its result afterwards. That is
        the difference between an index seek on `(entry_id, position)` and a
        scan of the whole workspace's log -- and single-entry lookups are the
        hot path: every ancestor of every create walks through one.
        """
        entry = self.models.entry
        rows = (
            select(log)
            .join(entry, col(entry.id) == col(log.entry_id))
            .where(col(entry.workspace_id) == workspace_id)
        )
        if entry_id is not None:
            rows = rows.where(col(log.entry_id) == entry_id)
        return aliased(
            log,
            (
                rows.distinct(col(log.entry_id))
                .order_by(col(log.entry_id), col(log.position).desc())
                .subquery()
            ),
        )

    def _namespace(self, workspace_id: UUID, entry_id: UUID | None = None) -> Namespace:
        entry = self.models.entry
        name, parent, deletion = (
            self._newest(log, workspace_id, entry_id)
            for log in (self.models.name, self.models.parent, self.models.deletion)
        )
        statement = (
            select(entry, name, parent, deletion)
            .join(name, col(name.entry_id) == col(entry.id))
            .join(parent, col(parent.entry_id) == col(entry.id))
            .join(deletion, col(deletion.entry_id) == col(entry.id))
            .where(col(entry.workspace_id) == workspace_id)
        )
        if entry_id is not None:
            statement = statement.where(col(entry.id) == entry_id)
        return Namespace(
            statement=statement, name=name, parent=parent, deletion=deletion
        )

    def _newest_content(self, workspace_id: UUID, entry_id: UUID | None = None) -> Any:
        """Content lives in two logs, and the newer row is the entry's kind:
        there is no kind field anywhere, so there is none to fall out of step."""
        entry = self.models.entry

        def written(log: type[ContentRow], kind: Kind):
            rows = (
                select(
                    col(log.entry_id).label("entry_id"),
                    col(log.id).label("version"),
                    col(log.position).label("position"),
                    literal(kind.value).label("kind"),
                    col(log.timestamp).label("accepted"),
                    col(log.utc_offset).label("offset"),
                )
                .join(entry, col(entry.id) == col(log.entry_id))
                .where(col(entry.workspace_id) == workspace_id)
            )
            return rows if entry_id is None else rows.where(col(log.entry_id) == entry_id)

        both = union_all(
            written(self.models.text_content, Kind.TEXT),
            written(self.models.blob_content, Kind.BINARY),
        ).subquery()
        return (
            select(
                both.c.entry_id,
                both.c.version,
                both.c.position,
                both.c.kind,
                both.c.accepted,
                both.c.offset,
            )
            .distinct(both.c.entry_id)
            .order_by(both.c.entry_id, both.c.position.desc())
            .subquery()
        )

    def _current(self, workspace_id: UUID, entry_id: UUID | None = None):
        placed = self._namespace(workspace_id, entry_id)
        content = self._newest_content(workspace_id, entry_id)
        return placed.statement.add_columns(
            content.c.version,
            content.c.position,
            content.c.kind,
            content.c.accepted,
            content.c.offset,
        ).outerjoin(content, content.c.entry_id == self.models.entry.id)

    # -- reading it ------------------------------------------------------------

    async def node(
        self, session: AsyncSession, workspace_id: UUID, entry_id: UUID
    ) -> Node | None:
        row = (await session.exec(self._current(workspace_id, entry_id))).first()
        return None if row is None else node_of(row)

    async def nodes(self, session: AsyncSession, workspace_id: UUID) -> list[Node]:
        """Every entry INCLUDING tombstones -- reconciliation depends on them,
        so tombstones must outlive the longest offline session a client has."""
        return [node_of(row) for row in await session.exec(self._current(workspace_id))]

    def _live_children(self, workspace_id: UUID, holder: UUID | None):
        placed = self._namespace(workspace_id)
        return placed, placed.statement.where(
            _under(placed.parent, holder),
            col(placed.deletion.deleted) == False,  # noqa: E712
        )

    async def name_taken(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        *,
        parent: UUID | None,
        name: str,
        excluding: UUID | None,
    ) -> bool:
        """Uniqueness among LIVE siblings, case-sensitively.

        Case-sensitive because the tree is read by a Linux-shaped runtime
        where `Foo.py` and `foo.py` are two importable modules. Changing this
        later means reconciling workspaces that already hold colliding pairs.

        Not a database constraint: name and parent are versioned, so no
        partial unique index can express it. What holds it up is the workspace
        controller -- one writer at a time, per workspace.
        """
        placed, siblings = self._live_children(workspace_id, parent)
        conflicting = siblings.where(
            col(placed.name.name) == name, self._other_than(excluding)
        )
        return (await session.exec(conflicting)).first() is not None

    async def claimed_first(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        *,
        parent: UUID | None,
        name: str,
        before: int,
        excluding: UUID,
    ) -> bool:
        """Whether a live sibling took this name earlier than `before`.

        First claim wins, so two entries that arrive holding one name are
        settled in the order they arrived rather than the order they are
        looked at.
        """
        placed, siblings = self._live_children(workspace_id, parent)
        earlier = siblings.where(
            col(placed.name.name) == name,
            col(placed.name.position) < before,
            col(self.models.entry.id) != excluding,
        )
        return (await session.exec(earlier)).first() is not None

    async def children(
        self, session: AsyncSession, workspace_id: UUID, parent: UUID | None
    ) -> int:
        _, siblings = self._live_children(workspace_id, parent)
        return (
            await session.exec(select(func.count()).select_from(siblings.subquery()))
        ).one()

    def _other_than(self, entry_id: UUID | None) -> ColumnElement[bool]:
        return true() if entry_id is None else col(self.models.entry.id) != entry_id

    # -- walking it -------------------------------------------------------------

    async def ancestors(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        entry_id: UUID,
        *,
        look_up: Lookup | None = None,
    ) -> AsyncIterator[Step]:
        """From the entry's parent up to the workspace root.

        Yields what it FOUND at each rung, not just the id it followed: the
        walk had to fetch the node to keep climbing, and every caller wants
        it. Handing back ids alone made `lineage` fetch each one a second
        time, which doubled the cost of the walk for nothing.

        `look_up` is how a caller that already knows some of these entries
        supplies them. A unit of work walking a thousand creates into one
        folder climbs the same rungs a thousand times, and the walk is the
        expensive part of judging a placement -- but only the caller knows
        whether its knowledge is still good, so the default is to ask the
        database every time.
        """
        find = look_up or (lambda at: self.node(session, workspace_id, at))
        seen: set[UUID] = set()
        at = await find(entry_id)
        while at is not None and at.parent is not None and at.parent not in seen:
            followed = at.parent
            seen.add(followed)
            at = await find(followed)
            yield Step(id=followed, node=at)

    async def lineage(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        entry_id: UUID,
        *,
        look_up: Lookup | None = None,
    ) -> Lineage:
        """Deleting a folder tombstones the folder, not its contents. What the
        subtree loses is reachability, and that is what nothing may be added to."""
        walked: list[UUID] = []
        interrupted = False
        async for step in self.ancestors(
            session, workspace_id, entry_id, look_up=look_up
        ):
            walked.append(step.id)
            interrupted = interrupted or step.node is None or step.node.deleted
        return Lineage(ancestors=tuple(walked), interrupted=interrupted)

    async def descends_from(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        entry_id: UUID,
        ancestor_id: UUID,
        *,
        look_up: Lookup | None = None,
    ) -> bool:
        return entry_id == ancestor_id or (
            await self.lineage(session, workspace_id, entry_id, look_up=look_up)
        ).under(ancestor_id)


@final
@dataclass(frozen=True)
class Step:
    """One rung of a walk up the tree: the parent an entry pointed at, and
    what is actually there -- which is `None` when it points at nothing, a
    routine possibility now that clients mint their own ids."""

    id: UUID
    node: "Node | None"


def _under(parent: type[ParentRow], holder: UUID | None) -> ColumnElement[bool]:
    at = col(parent.parent_entry_id)
    return at.is_(None) if holder is None else at == holder


@final
@dataclass(frozen=True)
class Lineage:
    """One walk from an entry up to the workspace root, answering everything
    the walk can answer: how deep it sits, what encloses it, and whether
    anything on the way up has been deleted."""

    ancestors: tuple[UUID, ...]
    interrupted: bool

    @property
    def depth(self) -> int:
        return len(self.ancestors)

    def under(self, ancestor_id: UUID) -> bool:
        return ancestor_id in self.ancestors
