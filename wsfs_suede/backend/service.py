"""Adjudication, and the one path every applied mutation takes.

The two halves are kept apart on purpose.

`refusal()` is judgement, and it is pure: it reads the workspace and answers
why a request cannot be applied, or None. Nothing about a refusal is stored,
because nothing about a refusal happened -- presenting the same transaction
again re-runs this function and produces the same answer, computed against the
workspace as it stands rather than as it once stood.

`approve()` is the choke point, and it is the only thing that writes: it takes
the next workspace position, stamps it onto the rows, and appends them -- all
in the caller's single database transaction. The rows ARE the event log, so
there is nothing that could drift from them.

Dedup therefore only has to protect what was applied: finding a transaction id
in the logs means the change already happened, and the recorded answer is
served instead of a second application. Which logs hold it says WHICH change,
so an id reused for a different operation is refused rather than acknowledged
into silence.

Every CAS token is per-property. A write does not invalidate a concurrent
rename, because the rename presents the name's token and the write moved the
content's -- the two are independent by construction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from itertools import count, islice
from collections.abc import Awaitable, Callable, Iterator
from typing import Any, cast, final
from uuid import UUID

from sqlalchemy import literal, union_all
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from . import minted, records, refusals, stream
from .blobs import Blobs
from .contract import (
    Acknowledged,
    BinaryBody,
    Body,
    Create,
    Delete,
    Kind,
    Metadata,
    Execute,
    Move,
    Operation,
    Refusal,
    Rejected,
    Rename,
    Reparent,
    Response,
    Seen,
    Submitted,
    TextBody,
    Transacted,
    Snapshot,
    Write,
)
from .diff import diff_to_delta
from .models import ContentRow, EntryRow, Models, NameRow, TransactionRow
from .text import Text
from .tree import Lineage, Node, Tree

MOST_NESTING = 64
MOST_SIBLINGS = 10_000
MOST_NUMBERED_CANDIDATES = 98
"""How far `notes (2).md`, `notes (3).md`... is followed before a settling
create takes an entry-id suffix instead. Every candidate is one query, and
past a hundred collisions on one name the tidy answer has stopped being
worth what it costs to find."""
LONGEST_NAME_IN_BYTES = 255
UNNAMEABLE = re.compile(r"[/\\\x00-\x1f\x7f]")


@dataclass
class Outcome:
    """What the client is told, and what the workspace's streams are told."""

    response: Response
    events: list[stream.Emitted] = field(default_factory=list)


class Deferrals:
    """Entries created during this unit of work, whose names settle at the end.

    A create that collides on name is resolved by renaming it. The ordinary
    reason a create collides at all is a client that made an entry and then
    typed a real name over it -- so settling at the end of the unit of work
    rather than at the create itself lets that rename land first, and the
    collision usually turns out never to have mattered.
    """

    def __init__(self) -> None:
        self._created: list[UUID] = []

    def note(self, entry_id: UUID) -> None:
        self._created.append(entry_id)

    def __iter__(self):
        return iter(self._created)


@final
@dataclass(frozen=True)
class Workspaces:
    """One wsfs schema, with the queries that read it.

    Built once, when a host says which tables its users and workspaces live
    in, and carried from there. Nothing in this package reaches a table any
    other way, which is what lets two of these coexist in one process.
    """

    models: Models
    tree: Tree
    stream: stream.Stream
    text: Text

    @classmethod
    def over(cls, models: Models) -> "Workspaces":
        return cls(models, Tree(models), stream.Stream(models), Text(models))


@dataclass(frozen=True)
class Submission:
    """One request being adjudicated against one workspace."""

    schema: Workspaces
    session: AsyncSession
    workspace: UUID
    user: UUID
    blobs: Blobs
    positions: stream.Positions
    deferrals: Deferrals = field(default_factory=Deferrals)

    looked_up: dict[UUID, Node | None] = field(default_factory=dict)
    """Entries this submission has already read, and the ones it found absent.

    A unit of work reads the same entries over and over: every create walks
    its whole lineage to the root, and a thousand queued creates into one
    folder walk the same twenty ancestors a thousand times. Nothing else can
    write this workspace while the submission holds its controller, so the
    only thing that can make a remembered entry wrong is this submission
    itself -- and everything it applies goes through `approve`, which forgets
    the entries it stamped. Absence is remembered on the same terms: a folder
    that does not exist yet is created here or not at all.
    """

    @property
    def models(self) -> Models:
        return self.schema.models

    @property
    def text(self) -> Text:
        return self.schema.text

    @property
    def stream(self) -> "stream.Stream":
        return self.schema.stream

    async def node(self, entry_id: UUID) -> Node | None:
        if entry_id not in self.looked_up:
            self.looked_up[entry_id] = await self.schema.tree.node(
                self.session, self.workspace, entry_id
            )
        return self.looked_up[entry_id]

    def changed(self, entry_id: UUID) -> None:
        """Forget an entry, because this submission just moved it."""
        _ = self.looked_up.pop(entry_id, None)

    async def lineage(self, entry_id: UUID) -> Lineage:
        return await self.schema.tree.lineage(
            self.session, self.workspace, entry_id, look_up=self.node
        )

    async def claimed_first(self, node: Node) -> bool:
        return await self.schema.tree.claimed_first(
            self.session,
            self.workspace,
            parent=node.parent,
            name=node.name,
            before=node.name_position,
            excluding=node.id,
        )

    async def name_taken(
        self, *, parent: UUID | None, name: str, excluding: UUID | None
    ) -> bool:
        return await self.schema.tree.name_taken(
            self.session, self.workspace, parent=parent, name=name, excluding=excluding
        )

    async def children(self, parent: UUID | None) -> int:
        return await self.schema.tree.children(self.session, self.workspace, parent)

    async def descends_from(self, entry_id: UUID, ancestor_id: UUID) -> bool:
        return await self.schema.tree.descends_from(
            self.session, self.workspace, entry_id, ancestor_id, look_up=self.node
        )


# -- tokens ---------------------------------------------------------------------


async def _was_issued(
    submission: Submission,
    node: Node,
    token: UUID | None,
    among: tuple[type[TransactionRow], ...],
) -> bool:
    """A token is real if a transaction on THIS entry minted it.

    `None` is real too: it is what an entry with no content has always
    presented. A token belonging to another entry is not -- accepting it would
    let one entry's history vouch for another's.
    """
    if token is None:
        return True
    for table in among:
        row = await submission.session.get(table, token)
        if row is not None and row.entry_id == node.id:
            return True
    return False


async def _cas(
    submission: Submission,
    node: Node,
    presented: UUID | None,
    *,
    current: UUID | None,
    among: tuple[type[TransactionRow], ...],
    stale: str,
) -> str | None:
    """Compare-and-swap on one property.

    A token that is not current either lost a race or was never issued at all,
    and a client's answer to those differs entirely: rebase and retry, or
    discard local state and re-Initialize.
    """
    if presented == current:
        return None
    if not await _was_issued(submission, node, presented, among):
        return Refusal.UNKNOWN_VERSION
    return stale




# -- judgement: why a request cannot be applied, if it cannot --------------------


def refuses_name(name: str) -> str | None:
    """Why this cannot be what an entry is called, or None.

    PUBLIC because a path segment and an entry name are the same thing, and
    `place` splits paths into them. Two definitions of what a name may be
    would be two definitions that eventually disagree.
    """
    if not name or name in (".", ".."):
        return Refusal.NAME_INVALID
    if UNNAMEABLE.search(name) or name != name.strip():
        return Refusal.NAME_INVALID
    if len(name.encode()) > LONGEST_NAME_IN_BYTES:
        return Refusal.NAME_INVALID
    return None


@final
@dataclass(frozen=True)
class Unwelcoming:
    """The three ways a folder can fail to take an entry, in the words the
    site asking uses for it. A create is going to a `parent`; a move is going
    to a `destination`; the fault is the same either way and the client needs
    to hear which of its own words it applies to."""

    unknown: str
    not_a_folder: str
    deleted: str


AS_PARENT = Unwelcoming(
    unknown=Refusal.PARENT_UNKNOWN,
    not_a_folder=Refusal.PARENT_NOT_A_FOLDER,
    deleted=Refusal.PARENT_DELETED,
)

AS_DESTINATION = Unwelcoming(
    unknown=Refusal.DESTINATION_UNKNOWN,
    not_a_folder=Refusal.DESTINATION_NOT_A_FOLDER,
    deleted=Refusal.DESTINATION_DELETED,
)


@final
@dataclass(frozen=True)
class Destination:
    """Where an entry is being put, walked once.

    Judging a placement asks the same walk three questions -- is the folder
    there, is it still reachable, how deep does that put the child -- and the
    walk is the expensive part. It happens here, and the answers are read off
    this.
    """

    parent: UUID | None
    holder: Node | None
    """`None` at the workspace root, and also when the id names nothing."""
    lineage: Lineage | None

    @property
    def child_depth(self) -> int:
        """How deep an entry placed here would sit."""
        return 0 if self.lineage is None else self.lineage.depth + 1


async def _destination(submission: Submission, parent: UUID | None) -> Destination:
    if parent is None:
        return Destination(parent=None, holder=None, lineage=None)
    holder = await submission.node(parent)
    return Destination(
        parent=parent,
        holder=holder,
        lineage=None if holder is None else await submission.lineage(holder.id),
    )


def _unwelcoming(where: Destination, called: Unwelcoming) -> str | None:
    """A folder that cannot take an entry, and why.

    "Never existed" and "was deleted" are kept apart deliberately. Under
    server-minted ids a parent that does not exist was impossible; a client
    that mints its own can name one that was never created -- which is
    precisely what happens to every nested create queued behind a refused
    one -- and telling that client its folder "was deleted" is a lie about
    something it never made.
    """
    if where.parent is None:
        return None  # the root takes everything
    if where.holder is None:
        return called.unknown
    if not where.holder.is_folder:
        return called.not_a_folder
    assert where.lineage is not None
    if where.holder.deleted or where.lineage.interrupted:
        return called.deleted
    return None


async def _overfull(submission: Submission, where: Destination) -> str | None:
    """A client that mints its own ids can mint unbounded ones offline, so the
    shape of the tree is bounded here rather than by how much a client sends."""
    if where.child_depth >= MOST_NESTING:
        return Refusal.TOO_DEEP
    if await submission.children(where.parent) >= MOST_SIBLINGS:
        return Refusal.FOLDER_FULL
    return None


async def _refuses_create(submission: Submission, request: Create) -> str | None:
    if (unnameable := refuses_name(request.name)) is not None:
        return unnameable
    if await _bytes_are_missing(submission, request.content):
        return Refusal.BYTES_NEVER_STORED
    where = await _destination(submission, request.parent)
    if (unwelcoming := _unwelcoming(where, AS_PARENT)) is not None:
        return unwelcoming
    return await _overfull(submission, where)


async def _bytes_are_missing(submission: Submission, body: Body | None) -> bool:
    return isinstance(body, BinaryBody) and not await submission.blobs.holds(body.hash)
    # A name collision is NOT refused here: a create has no prior version to
    # CAS against, so refusing it would be the only thing standing between two
    # offline clients and a lost `notes.md`. `_deduplicated_name` settles it.


async def _refuses_delete(submission: Submission, request: Delete) -> str | None:
    node = await submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_UNKNOWN
    if node.deleted:
        return None  # already what was asked for; nothing to refuse
    if (fabricated := await _any_unissued(submission, node, request.seen)) is not None:
        return fabricated
    if _still_as_seen(node, request.seen):
        return None
    return _what_later_versions_touched(node, request.seen)


def _presented(
    models: Models, seen: Seen
) -> tuple[tuple[UUID | None, tuple[type[TransactionRow], ...]], ...]:
    return (
        (seen.name_version, (models.name,)),
        (seen.parent_version, (models.parent,)),
        (seen.deleted_version, (models.deletion,)),
        (seen.content_version, models.content),
    )


async def _any_unissued(submission: Submission, node: Node, seen: Seen) -> str | None:
    for token, among in _presented(submission.models, seen):
        if not await _was_issued(submission, node, token, among):
            return Refusal.UNKNOWN_VERSION
    return None


def _still_as_seen(node: Node, seen: Seen) -> bool:
    return (
        seen.name_version,
        seen.parent_version,
        seen.deleted_version,
        seen.content_version,
    ) == (
        node.name_version,
        node.parent_version,
        node.deleted_version,
        node.content_version,
    )


def _what_later_versions_touched(node: Node, seen: Seen) -> str:
    """Delete's refusal names what the client would have destroyed unseen.

    A move counts as a change of name: both change where the entry lives in
    the namespace, and the contract's reasons have no third word.
    """
    return Refusal.modified(
        name=(seen.name_version, seen.parent_version)
        != (node.name_version, node.parent_version),
        content=seen.content_version != node.content_version,
    )


async def _refuses_rename(submission: Submission, request: Rename) -> str | None:
    node = await submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_UNKNOWN
    if node.deleted:
        return Refusal.ENTRY_DELETED
    if (unnameable := refuses_name(request.name)) is not None:
        return unnameable
    if (
        conflict := await _cas(
            submission,
            node,
            request.name_version,
            current=node.name_version,
            among=(submission.models.name,),
            stale=Refusal.ALREADY_RENAMED,
        )
    ) is not None:
        return conflict
    if await submission.name_taken(
        parent=node.parent, name=request.name, excluding=node.id
    ):
        return Refusal.NAME_TAKEN
    return None


async def _refuses_reparent(submission: Submission, request: Reparent) -> str | None:
    node = await submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_UNKNOWN
    if node.deleted:
        return Refusal.ENTRY_DELETED
    if (
        conflict := await _cas(
            submission,
            node,
            request.parent_version,
            current=node.parent_version,
            among=(submission.models.parent,),
            stale=Refusal.ALREADY_MOVED,
        )
    ) is not None:
        return conflict
    return await _refuses_destination(submission, node, request.parent, node.name)


async def _would_detach_the_subtree(
    submission: Submission, moving: Node, destination: UUID | None
) -> bool:
    """Moving a folder inside itself severs it from the root, unreachably."""
    return destination is not None and await submission.descends_from(
        destination, moving.id
    )


async def _refuses_move(submission: Submission, request: Move) -> str | None:
    """A move is a rename and a reparent judged together, so that neither can
    land without the other."""
    node = await submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_UNKNOWN
    if node.deleted:
        return Refusal.ENTRY_DELETED
    if (unnameable := refuses_name(request.name)) is not None:
        return unnameable
    if (stale := await _cas(
        submission, node, request.name_version,
        current=node.name_version, among=(submission.models.name,),
        stale=Refusal.ALREADY_RENAMED,
    )) is not None:
        return stale
    if (stale := await _cas(
        submission, node, request.parent_version,
        current=node.parent_version, among=(submission.models.parent,),
        stale=Refusal.ALREADY_MOVED,
    )) is not None:
        return stale
    return await _refuses_destination(submission, node, request.parent, request.name)


async def _refuses_destination(
    submission: Submission, node: Node, parent: UUID | None, name: str
) -> str | None:
    """Everything about where an entry is going, in the order a reader would
    ask it: does it exist, would it swallow itself, is there room, is the name
    free."""
    where = await _destination(submission, parent)
    if (unwelcoming := _unwelcoming(where, AS_DESTINATION)) is not None:
        return unwelcoming
    if await _would_detach_the_subtree(submission, node, parent):
        return Refusal.DESTINATION_INSIDE_ENTRY
    if (full := await _overfull(submission, where)) is not None:
        return full
    if await submission.name_taken(parent=parent, name=name, excluding=node.id):
        return Refusal.NAME_TAKEN
    return None


async def _refuses_write(submission: Submission, request: Write) -> str | None:
    node = await submission.node(request.id)
    if node is None:
        return Refusal.ENTRY_UNKNOWN
    if node.deleted:
        # The bytes are not lost with the transaction: the client parks them.
        return Refusal.ENTRY_DELETED
    if node.is_folder:
        return Refusal.NOT_A_FILE
    if (
        conflict := await _cas(
            submission,
            node,
            request.content_version,
            current=node.content_version,
            among=submission.models.content,
            stale=Refusal.ALREADY_WRITTEN,
        )
    ) is not None:
        return conflict
    if await _bytes_are_missing(submission, request.content):
        return Refusal.BYTES_NEVER_STORED
    return None


_JUDGEMENT: dict[Operation, Callable[[Submission, Any], Awaitable[str | None]]] = {
    Operation.CREATE: _refuses_create,
    Operation.DELETE: _refuses_delete,
    Operation.RENAME: _refuses_rename,
    Operation.REPARENT: _refuses_reparent,
    Operation.MOVE: _refuses_move,
    Operation.WRITE: _refuses_write,
}


async def refusal(submission: Submission, request: Submitted) -> str | None:
    """Why this request cannot be applied to this workspace, if it cannot.

    Reads only. Re-running it is how the reason for an earlier refusal is
    recovered, so no refusal is ever written down.
    """
    return await _JUDGEMENT[request.op](submission, request)


_TOKEN_AT_STAKE: dict[Operation, Callable[[Node], UUID | None]] = {
    Operation.RENAME: lambda node: node.name_version,
    Operation.REPARENT: lambda node: node.parent_version,
    Operation.WRITE: lambda node: node.content_version,
}


async def _conflicting_version(
    submission: Submission, request: Submitted
) -> UUID | None:
    """What a client rebases onto: the current token of the property it lost.

    A delete gets none -- it presented four tokens, so what it needs back is a
    fresh look at the entry, not one value.
    """
    at_stake = _TOKEN_AT_STAKE.get(request.op)
    node = None if at_stake is None else await submission.node(request.id)
    return None if node is None or at_stake is None else at_stake(node)


# -- the choke point ---------------------------------------------------------------


Applied = tuple[TransactionRow, ...]


async def approve(submission: Submission, *applied: TransactionRow) -> Applied:
    """Take the next position, stamp it onto the rows, append them.

    The position comes from the controller that owns this workspace, in
    memory. Nothing is locked because nothing else writes here.

    Rows sharing a position are one transaction, and only a create writes more
    than one -- which is how the stream tells a birth from a change.

    The stamped rows come back rather than the number, because the rows ARE
    the event: announcing what just happened by re-reading five logs at that
    position would be asking the database to repeat what we just told it.
    """
    position = submission.positions.take()
    for row in applied:
        row.position = position
        submission.changed(row.entry_id)
    submission.session.add_all(applied)
    await submission.session.flush()
    return applied


async def _acknowledge(submission: Submission, applied: Applied) -> Outcome:
    return Outcome(Acknowledged(), await _announcing(submission, applied))


async def _announcing(
    submission: Submission, *transactions: Applied | None
) -> list[stream.Emitted]:
    return [
        await submission.stream.emitted(submission.session, list(applied))
        for applied in transactions
        if applied
    ]


def _by(user: UUID, request: Transacted) -> dict[str, Any]:
    """A transaction's own id is the primary key of every row it applies.

    Which also carries when the client acted: the id is a UUIDv7, so the
    millisecond it was minted rides along in the key. What the key cannot hold
    is which clock the client was reading, so the offset is stamped beside it.
    The server's own clock arrives by default, from `WithTime`.
    """
    return {
        "id": request.transaction,
        "user_id": user,
        "utc_offset": request.offset,
    }


# -- application: what an accepted request appends ------------------------------------


def _numbered(name: str, suffix: object) -> str:
    stem, dot, extension = name.rpartition(".")
    if not stem:  # a dotfile has no extension to protect
        return f"{name} ({suffix})"
    return f"{stem} ({suffix}){dot}{extension}"


def _candidates(desired: str) -> Iterator[str]:
    """`notes (2).md`, `notes (3).md`, and so on."""
    for index in islice(count(2), MOST_NUMBERED_CANDIDATES):
        yield _numbered(desired, index)


async def _available_name(submission: Submission, node: Node) -> str:
    """A free name near the one asked for -- and a certainly-free one if the
    neighbourhood is that crowded. Each candidate costs a query, so the
    numbered run is bounded and the fallback ends it in one step rather than
    counting on towards `MOST_SIBLINGS`."""
    for candidate in _candidates(node.name):
        if not await submission.name_taken(
            parent=node.parent, name=candidate, excluding=node.id
        ):
            return candidate
    return _numbered(node.name, node.id.hex)


async def _identify(submission: Submission, request: Create) -> EntryRow:
    """The entry has to exist before the logs that point at it do, and nothing
    else in this transaction reads it into being."""
    entry = submission.models.entry(
        id=request.id, workspace_id=submission.workspace, type=request.type
    )
    submission.session.add(entry)
    submission.changed(entry.id)  # anything that read it read its absence
    await submission.session.flush()
    return entry


async def _apply_create(submission: Submission, request: Create) -> Outcome:
    entry = await _identify(submission, request)
    stamp = _by(submission.user, request)
    # One minted id names every row, so a client can predict all four of its
    # own tokens. They diverge on first mutation.
    # A file is born with content and a folder with none, so a create is the
    # only transaction that writes a fourth log.
    models = submission.models
    appended: list[TransactionRow] = [
        models.name(entry_id=entry.id, name=request.name, **stamp),
        models.parent(entry_id=entry.id, parent_entry_id=request.parent, **stamp),
        models.deletion(entry_id=entry.id, deleted=False, **stamp),
    ]
    written = await _content_row(
        submission, entry.id, request, request.content, base=""
    )
    if written is not None:
        appended.append(written)
    born = await approve(submission, *appended)
    await _anchor_text(submission, written, request.content)
    submission.deferrals.note(entry.id)
    return await _acknowledge(submission, born)


async def _anchor_text(
    submission: Submission, written: ContentRow | None, body: Body | None
) -> None:
    if isinstance(written, submission.models.text_content) and isinstance(body, TextBody):
        await submission.text.remember(submission.session, written, body.content)


async def settle(submission: Submission) -> list[stream.Emitted]:
    """Rename anything created here that is still sharing a sibling's name.

    Runs once, at the end of the unit of work, after every queued transaction
    has had its say. Rather than quietly substituting a name nobody asked for,
    the create was applied as asked and is renamed now -- so a client learns
    the settled name through the ordinary `name` event, and nothing about the
    create response is special.
    """
    return await _announcing(
        submission,
        *[await _settled(submission, entry) for entry in submission.deferrals],
    )


async def _settled(submission: Submission, entry_id: UUID) -> Applied | None:
    node = await submission.node(entry_id)
    if node is None or node.deleted:
        return None  # a tombstone holds no name to collide with
    if not await submission.claimed_first(node):
        return None
    return await approve(submission, await _issued_by_the_controller(submission, node))


async def _issued_by_the_controller(submission: Submission, node: Node) -> NameRow:
    """The one transaction no client minted. Its id is the controller's, and
    it reaches every client as an ordinary name event. Attributed to whoever
    is presenting the work, because their work is what needed settling.

    A v7 like everyone else's, so this transaction answers "when did it happen"
    out of its id the way every other one does. No offset: the only clock that
    saw this is this process's, and that is what `WithTime` already records --
    claiming a client's zone for work no client asked for would be a fiction.
    """
    return submission.models.name(
        id=minted.mint(),
        entry_id=node.id,
        user_id=submission.user,
        name=await _available_name(submission, node),
    )


async def _apply_delete(submission: Submission, request: Delete) -> Outcome:
    node = await _live(submission, request)
    if node.deleted:
        # Acknowledging beats inventing a refusal for work already done.
        return Outcome(Acknowledged())
    stamp = _by(submission.user, request)
    return await _acknowledge(
        submission,
        await approve(
            submission,
            submission.models.deletion(entry_id=node.id, deleted=True, **stamp),
        ),
    )


async def _apply_rename(submission: Submission, request: Rename) -> Outcome:
    node = await _live(submission, request)
    stamp = _by(submission.user, request)
    return await _acknowledge(
        submission,
        await approve(
            submission,
            submission.models.name(entry_id=node.id, name=request.name, **stamp),
        ),
    )


async def _apply_reparent(submission: Submission, request: Reparent) -> Outcome:
    node = await _live(submission, request)
    stamp = _by(submission.user, request)
    return await _acknowledge(
        submission,
        await approve(
            submission,
            submission.models.parent(
                entry_id=node.id, parent_entry_id=request.parent, **stamp
            ),
        ),
    )


async def _apply_move(submission: Submission, request: Move) -> Outcome:
    node = await _live(submission, request)
    stamp = _by(submission.user, request)
    models = submission.models
    return await _acknowledge(
        submission,
        await approve(
            submission,
            models.name(entry_id=node.id, name=request.name, **stamp),
            models.parent(entry_id=node.id, parent_entry_id=request.parent, **stamp),
        ),
    )


async def _apply_write(submission: Submission, request: Write) -> Outcome:
    node = await _live(submission, request)
    body = request.content
    written = await _content_row(
        submission,
        node.id,
        request,
        body,
        base=await submission.text.at(
            submission.session, node.id, node.content_position
        ),
    )
    assert written is not None
    applied = await approve(submission, written)
    await _anchor_text(submission, written, body)
    return await _acknowledge(submission, applied)


async def _content_row(
    submission: Submission,
    entry_id: UUID,
    request: Transacted,
    body: Body | None,
    *,
    base: str,
) -> ContentRow | None:
    if body is None:
        return None
    stamp = _by(submission.user, request)
    if isinstance(body, BinaryBody):
        return submission.models.blob_content(
            entry_id=entry_id, hash=body.hash, size=body.size, mime=body.mime, **stamp
        )
    return submission.models.text_content(
        entry_id=entry_id,
        size=len(body.content.encode()),
        mime="text/plain",
        delta=diff_to_delta(base, after=body.content),
        **stamp,
    )


async def _live(submission: Submission, request: Transacted) -> Node:
    """The entry an accepted request names -- judgement has already found it."""
    node = await submission.node(request.id)
    if node is None:
        raise LookupError(
            f"entry {request.id} vanished between judgement and application"
        )
    return node


_APPLICATION: dict[Operation, Callable[[Submission, Any], Awaitable[Outcome]]] = {
    Operation.CREATE: _apply_create,
    Operation.DELETE: _apply_delete,
    Operation.RENAME: _apply_rename,
    Operation.REPARENT: _apply_reparent,
    Operation.MOVE: _apply_move,
    Operation.WRITE: _apply_write,
}


# -- dedup, and the two halves joined -------------------------------------------------

def _content_log(models: Models, body: Body) -> type[ContentRow]:
    return models.text_content if body.type is Kind.TEXT else models.blob_content


def _writes(models: Models, request: Submitted) -> tuple[type[TransactionRow], ...]:
    """Which logs a transaction of this shape lands in.

    This is the same fact `stream.announced` reads backwards: which logs a
    transaction wrote IS which operation it was. Stated forwards here, it is
    what lets dedup tell a replay from an id reused for something else.
    """
    if isinstance(request, Create):
        placing = (models.name, models.parent, models.deletion)
        if request.content is None:
            return placing  # a folder is born with no content
        return (*placing, _content_log(models, request.content))
    if isinstance(request, Write):
        return (_content_log(models, request.content),)
    return {
        Operation.MOVE: (models.name, models.parent),
        Operation.RENAME: (models.name,),
        Operation.REPARENT: (models.parent,),
        Operation.DELETE: (models.deletion,),
    }[request.op]


async def _spent_on(
    submission: Submission, transaction: UUID
) -> dict[type[TransactionRow], UUID]:
    """Every log this id already sits in, and the entry each of them names.

    Across ALL five logs, always. Asking only about the logs this request
    would write is the shape that lets a reused id through: an id spent on a
    rename and presented again as a write finds nothing in the content log,
    looks unspent, and applies -- leaving one entry with two properties whose
    tokens are the same UUID.

    One round trip rather than one per log, because the answer has to span
    logs this request has no other reason to touch.
    """
    logs = submission.models.logs
    asked = union_all(
        *(
            select(literal(index).label("log"), col(log.entry_id).label("entry_id"))
            .where(col(log.id) == transaction)
            for index, log in enumerate(logs)
        )
    ).subquery()
    rows = (await submission.session.exec(select(asked.c.log, asked.c.entry_id))).all()
    return {logs[index]: entry_id for index, entry_id in rows}


async def _already_applied(
    submission: Submission, request: Submitted
) -> Outcome | None:
    """A transaction id is spent once, on one operation, against one entry.

    A replay is free, and that is the whole point: the client re-presents the
    id it minted and is told the change already happened. But "already
    happened" has to mean THIS change. A create writes name, parent and
    deletion at one id; a rename reusing that id would find its name row,
    match on entry, and be acknowledged without renaming anything -- silent
    divergence, which is the one outcome nothing here may produce.

    So the shape is checked, not just the entry: the logs holding this id must
    be EXACTLY the logs this request would write, and every one of them must
    point at the entry it names. Anything else is a reused id, and is refused
    out loud rather than absorbed.

    Exactly, in both directions. A create writes three logs and a rename one,
    so reuse across them is caught by the sets differing -- but a rename and a
    write share no log at all, and comparing only the logs THIS request writes
    would find nothing and call the id fresh.
    """
    writes = _writes(submission.models, request)
    spent = await _spent_on(submission, request.transaction)
    if not spent:
        return None
    reused = set(spent) != set(writes) or any(
        entry_id != request.id for entry_id in spent.values()
    )
    return Outcome(Rejected(reason=Refusal.ID_TAKEN) if reused else Acknowledged())


async def _minted_elsewhere(submission: Submission, request: Create) -> bool:
    """An entry id already in use.

    Checked globally rather than within the workspace: a client that can
    assert an id must not learn, from the shape of the refusal, that the id
    exists somewhere it cannot see.
    """
    return (
        await submission.session.get(submission.models.entry, request.id) is not None
    )


async def declined(
    submission: Submission, request: Submitted, reason: str
) -> Outcome:
    """Every refusal leaves this way, so none of them can leave without being
    recorded. What was asked is kept whether or not it was granted -- see
    `refusals`."""
    await refusals.record(
        submission, request, reason, *_writes(submission.models, request)
    )
    return Outcome(
        Rejected(reason=reason, version=await _conflicting_version(submission, request))
    )


def _asks_to_be_kept(request: Submitted) -> bool:
    return isinstance(request, Write) and request.draft


async def kept(submission: Submission, request: Write) -> Outcome:
    """Recorded beside the refusals, and not applied to anything.

    No judgement runs: a draft is not competing for the file, so there is no
    race for it to lose and no token for it to consume.
    """
    await refusals.record(
        submission, request, Refusal.NOT_SHARED, *_writes(submission.models, request)
    )
    return Outcome(Acknowledged(draft=True))


async def adjudicate(submission: Submission, request: Submitted) -> Outcome:
    if isinstance(request, (Snapshot, Execute)):
        return await _recorded(submission, request)
    if _asks_to_be_kept(request):
        return await kept(submission, cast(Write, request))
    applied = await _already_applied(submission, request)
    if applied is not None:
        if isinstance(applied.response, Rejected):
            return await declined(submission, request, applied.response.reason)
        return applied  # a replay after a dropped response: free, by design
    if isinstance(request, Create) and await _minted_elsewhere(submission, request):
        return await declined(submission, request, Refusal.ID_TAKEN)
    refused = await refusal(submission, request)
    if refused is not None:
        return await declined(submission, request, refused)
    return await _APPLICATION[request.op](submission, request)


async def _recorded(
    submission: Submission, request: Snapshot | Execute
) -> Outcome:
    """A claim, kept, that changes nothing.

    OUT OF THE LOG MACHINERY ENTIRELY, and deliberately: neither of these
    mutates an entry, so neither takes a position, writes a log, or announces
    an event. Running them through it would put them in the stream, where a
    subscriber folding an entry's history would have to learn to ignore them.

    Refused for one thing only -- whether the claim refers to anything. A
    snapshot naming a version nobody issued, or an execution against a
    snapshot nobody took, is a sentence with no subject.
    """
    session, models = submission.session, submission.models
    workspace_id = submission.workspace

    if await records.already_recorded(session, models, request):
        return Outcome(Acknowledged())  # a replay after a dropped response

    reason = (
        await records.refuses_snapshot(session, models, workspace_id, request)
        if isinstance(request, Snapshot)
        else await records.refuses_execution(session, models, workspace_id, request)
    )
    if reason is not None:
        """Not through `declined`: that records what was asked in the refusal
        store, which is shaped around entry properties -- and neither of these
        is one. There is nothing here a later write could be diffed against."""
        return Outcome(Rejected(reason=reason, version=None))

    if isinstance(request, Snapshot):
        for row in records.snapshot_rows(models, workspace_id, submission.user, request):
            session.add(row)
    else:
        session.add(
            records.execution_row(models, workspace_id, submission.user, request)
        )
    return Outcome(Acknowledged())


async def snapshot(
    schema: Workspaces, session: AsyncSession, workspace_id: UUID
) -> list[Metadata]:
    return [node.metadata for node in await schema.tree.nodes(session, workspace_id)]
