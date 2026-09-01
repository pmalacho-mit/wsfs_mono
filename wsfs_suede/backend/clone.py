"""Copying one workspace's files into another, and keeping the trail.

A CLONE IS A COPY, not a share. The target gets its own entries, its own logs
and its own positions, because two workspaces sharing a log would be one
workspace under two names: a write in either would surface in both, which is
the opposite of what somebody cloning a workspace wants. What copying loses is
where each file came from, and that is exactly what `models.ClonedRow` keeps.

IT GOES THROUGH THE ORDINARY DOOR. Every file is created by an ordinary
`Create`, adjudicated by `service.adjudicate` and stamped by the same choke
point everything else is -- so the target's stream announces a clone as a run
of ordinary create events, name collisions settle the way they always do, and
a client that was watching the target while it happened needs to know nothing
about cloning at all. There is no second write path here, which is the only
way there can be no second set of rules.

WHAT IS COPIED is the source's LIVE tree as it currently stands: every entry
that is not deleted and that can still be reached from the root. History is
not -- the copy is a file with one write in it, not a re-run of somebody
else's session -- and neither are drafts, refusals, snapshots or executions,
each of which is a claim about the workspace it was made in and would be a
lie about this one.

BYTES ARE NOT COPIED EITHER, and nothing needs to be. The blob store is
content-addressed and shared across the deployment, so the copy names the same
hash the original does and the two files hold one set of bytes -- which is also
why cloning a workspace full of large binaries costs nothing but rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import final
from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from . import service
from .contract import BinaryBody, Body, Create, Kind, Refusal, Rejected, TextBody
from .minted import mint
from .models import Type
from .service import Submission, Workspaces
from .stream import Emitted
from .tree import Node


@final
@dataclass(frozen=True)
class ClonedEntry:
    """One file or folder, as it arrived in the target."""

    source: UUID
    """The entry it was copied from, in the source workspace."""

    entry: UUID
    """The entry it became. Freshly minted: an id is unique across the
    deployment, so the copy cannot reuse the original's."""

    type: Type
    name: str
    """What it was called in the source. NOT NECESSARILY what it ended up
    called here: a create that collides with a name the target already holds
    is settled by the controller afterwards, and the settled name reaches
    everybody as an ordinary name event. Read the target's tree for the name
    it now has."""

    content_version: UUID | None
    """The source write this copy was taken at, or null for a folder. The
    source keeps moving afterwards, so this is the only record of the moment
    the copy describes."""


@final
@dataclass(frozen=True)
class NotCopied:
    """One entry of the source that the target does not now hold.

    NAMED BY ITS SOURCE ENTRY, not by the transaction that failed. A caller
    holding this is asking which of ITS files is missing, and the id of a
    transaction nobody but this function ever knew about does not answer that.
    """

    source: UUID
    name: str
    reason: str
    """One of `contract.Refusal` -- the same closed set every other refusal in
    this package is drawn from."""


@final
@dataclass
class Cloned:
    """What one clone did, in the order it did it."""

    source: UUID
    target: UUID
    entries: list[ClonedEntry] = field(default_factory=list)

    refused: list[NotCopied] = field(default_factory=list)
    """Everything the source has that the target did not get, and why.

    REPORTED RATHER THAN RAISED, and the whole clone stands either way. A
    workspace can refuse a create for reasons that are about the TARGET and
    have nothing to do with the source -- a folder already at its limit, a
    tree already as deep as it may go -- and throwing away every file that
    would have landed because one would not is a worse answer than saying
    which one did not. The caller decides what a partial clone is worth.

    IT ACCOUNTS FOR EVERYTHING, including the entries never attempted because
    a folder above them was refused. A file that is silently in neither list
    is a file whose absence the caller cannot even discover, which is the one
    outcome a partial copy must not have: `entries` and `refused` together are
    every live entry the source had.

    Empty is the ordinary outcome.
    """

    @property
    def complete(self) -> bool:
        return not self.refused

    @property
    def files(self) -> list[UUID]:
        """The target entries that hold content -- what there is to warm."""
        return [made.entry for made in self.entries if made.type is Type.FILE]


# -- what there is to copy -----------------------------------------------------------


def reachable(nodes: list[Node]) -> list[Node]:
    """The source's live tree, parents before children.

    TWO JOBS AT ONCE, because they are the same walk. Every entry has to be
    created before anything that names it as a parent, and every entry whose
    lineage runs through a tombstone has to be left behind -- deleting a folder
    tombstones the folder and not its contents, so a subtree that lost its
    reachability is still sitting in the logs, and copying it would resurrect
    at the root of the target files the source cannot see.

    Cycles are refused rather than followed. Nothing in the contract can make
    one -- a reparent into an entry's own subtree is refused -- but ids are
    client-minted and a walk that trusts that is a walk that can hang.
    """
    live = {node.id: node for node in nodes if not node.deleted}
    ordered: list[Node] = []
    settled: dict[UUID, bool] = {}

    for node in live.values():
        if node.id in settled:
            continue
        # Climb to the first rung with a known answer, remembering the way up.
        climbed: list[Node] = []
        walking: set[UUID] = set()
        at, keep = node, False
        while True:
            if at.id in walking:  # a cycle reaches no root
                break
            climbed.append(at)
            walking.add(at.id)
            if at.parent is None:
                keep = True
                break
            if at.parent in settled:
                keep = settled[at.parent]
                break
            above = live.get(at.parent)
            if above is None:  # deleted, or never there at all
                break
            at = above
        for each in reversed(climbed):  # the root end first
            settled[each.id] = keep
            if keep:
                ordered.append(each)
    return ordered


async def content_of(
    schema: Workspaces, session: AsyncSession, node: Node
) -> Body | None:
    """What this entry holds, in the shape a create carries it.

    Read AT THE WRITE the node names rather than at whatever the entry says
    now, so the copy is of one moment even when the source is being typed into
    while this runs -- `Text.at` folds backwards from the cache when the anchor
    has moved on.

    A folder holds nothing. A file with no content row cannot happen -- a file
    is born with content -- but a file whose newest write is BINARY is
    ordinary, and it copies as a reference to the same bytes.
    """
    if node.is_folder:
        return None
    held = node.content
    if held is None:
        return TextBody(content="")
    if held.kind is Kind.TEXT:
        return TextBody(content=await schema.text.at(session, node.id, held.position))
    written = await session.get(schema.models.blob_content, held.version)
    if written is None:
        raise LookupError(f"blob write {held.version} named by an entry is not there")
    return BinaryBody(hash=written.hash, size=written.size, mime=written.mime)


# -- the unit of work ------------------------------------------------------------------


async def copied_into(
    submission: Submission, source: UUID
) -> tuple[Cloned, list[Emitted]]:
    """Copy `source`'s live tree into the workspace this submission is for.

    ONE UNIT OF WORK, in the target's controller, for the same reason
    Initialize is one: the copies are a tree, and a tree half-appended is a
    workspace holding folders whose contents never arrived. Names settle at
    the end, once, exactly as they do for an outbox.

    The SOURCE is only read, and reads do not go through its controller --
    MVCC handles them, and taking two controllers to clone would be two locks
    in an order nothing agrees on. What that costs is a source being written
    to WHILE this runs: an entry created after the tree was read is not in the
    copy. Its content is not torn, because each file is read at the write the
    tree named; the boundary is simply where the read happened.
    """
    schema, session = submission.schema, submission.session
    cloned = Cloned(source=source, target=submission.workspace)
    events: list[Emitted] = []
    copies: dict[UUID, UUID] = {}
    stillborn: set[UUID] = set()
    """Source entries the target did not take. Their descendants are reported
    rather than attempted: creating a child under a parent that does not exist
    turns one real failure into one per file underneath it, each of them
    describing the parent's problem as though it were their own."""

    for node in reachable(await schema.tree.nodes(session, source)):
        if node.parent is not None and node.parent in stillborn:
            stillborn.add(node.id)
            cloned.refused.append(
                NotCopied(
                    source=node.id, name=node.name, reason=Refusal.CREATE_REFUSED
                )
            )
            continue
        copy = mint()
        request = Create(
            transaction=mint(),
            id=copy,
            type=node.entry.type,
            name=node.name,
            parent=None if node.parent is None else copies[node.parent],
            content=await content_of(schema, session, node),
        )
        outcome = await service.adjudicate(submission, request)
        events.extend(outcome.events)
        if isinstance(outcome.response, Rejected):
            stillborn.add(node.id)
            cloned.refused.append(
                NotCopied(
                    source=node.id, name=node.name, reason=outcome.response.reason
                )
            )
            continue
        copies[node.id] = copy
        cloned.entries.append(
            ClonedEntry(
                source=node.id,
                entry=copy,
                type=node.entry.type,
                name=node.name,
                content_version=node.content_version,
            )
        )
        session.add(
            schema.models.cloned(
                source_workspace_id=source,
                target_workspace_id=submission.workspace,
                source_entry_id=node.id,
                target_entry_id=copy,
                user_id=submission.user,
                source_content_version=node.content_version,
            )
        )

    events.extend(await service.settle(submission))
    return cloned, events
