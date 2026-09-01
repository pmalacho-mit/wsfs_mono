"""Making a workspace hold these files, at these paths, with this text.

A CONVENIENCE, and a narrow one on purpose. Everything else in this package
speaks in entry ids and CAS tokens, because that is what a client with an
outbox needs; nothing composing a workspace from the outside has any of that.
A generator writing a starter project, a job dropping a report in, an
assistant saving what it produced -- each of them knows a path and a string
and would otherwise have to walk the tree, mint an id per folder, and chain
tokens by hand to say so.

DECLARATIVE, so it is worth calling twice. A path with nothing at it is
created, a path already holding that exact text is left completely alone --
no transaction, no position, no event -- and a path holding anything else is
written. That is what makes this safe to run on every deploy, or after every
edit, rather than something that has to be run exactly once.

IT GOES THROUGH THE ORDINARY DOOR, like `clone`: creates, writes and deletes
are adjudicated by `service.adjudicate` and stamped by the same choke point,
so the workspace's stream announces this as the run of ordinary events it is
and every rule about names, nesting and CAS applies unchanged.

TEXT ONLY. A path maps to a string, which is the whole of the interface. Bytes
are a blob that has to be stored before anything can name it, and pretending
otherwise -- taking a `bytes` and uploading it here -- would hide a network
call inside something that looks like a dictionary.

HALF OF IT IS A ROUTE, and which half is the point. `overwrite=False` with no
`prune` only ever ADDS -- a path already holding something else comes back
`PATH_OCCUPIED` and nothing of that file is touched -- so it destroys nothing
and clobbers nothing, and a client logged in on behalf of a user may perfectly
well mean it. That is what `POST /workspaces/{id}/files` exposes.

The other half stays in-process. Overwriting without presenting a token is a
caller saying "whatever is there, this now" about text somebody may have open,
and `prune` deletes every path the call did not name; together they are "make
the workspace look like this", which is a thing a host may mean and a browser
may not. Both are arguments here and neither is a field on the wire, so the
only way to reach them is to already be inside the process. See `PlaceFiles`.
"""

from __future__ import annotations

import enum
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import final
from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from . import service
from .contract import (
    Create,
    Delete,
    Kind,
    Refusal,
    Rejected,
    Seen,
    TextBody,
    Write,
    to_nfc,
)
from .minted import mint
from .models import Type
from .service import Submission, Workspaces
from .stream import Emitted
from .tree import Node

SEPARATOR = "/"

Segments = tuple[str, ...]
"""One path, taken apart. The tuple is the key everything here is indexed by:
a path is only ever compared to another path segment by segment, and comparing
the strings would make `a/b` and `a//b` two different files."""


def joined(path: Segments) -> str:
    return SEPARATOR.join(path)


# -- what the caller said --------------------------------------------------------------


class Unusable(ValueError):
    """A path that cannot be a path, or a set of them that cannot all be true.

    RAISED, where a workspace's refusals are reported. The difference is who
    is wrong. A folder that is full and a file already sitting where one was
    wanted are facts about the workspace, and the caller could not have known
    them -- so they come back in `Placed.refused` and everything else still
    lands. A path with a null byte in it, or a caller asking for `a` to be a
    file and `a/b` to be under it, is the CALL being wrong, and half-applying
    it would leave a workspace in a state nobody described.

    Raised before anything is written, for the same reason.
    """


def segments(path: str) -> Segments:
    """One path, taken apart and normalised -- or `Unusable`.

    NFC HERE, at the door, exactly as `contract.to_nfc` does it for a name
    arriving over the wire. A macOS caller's NFD `café/notes.md` and a Linux
    caller's NFC one have to find the same folder, and this is the only place
    that sees both spellings.

    A leading or trailing separator is trimmed, because `/src/main.py` and
    `src/main.py` plainly mean the same file and refusing one of them would be
    pedantry. An EMPTY segment in the middle is not: `src//main.py` is a typo,
    and quietly reading it as `src/main.py` is how a caller ends up unable to
    explain which of two paths it wrote.
    """
    parts = tuple(to_nfc(part) for part in path.strip(SEPARATOR).split(SEPARATOR))
    if parts == ("",):
        raise Unusable(f"{path!r} names nothing")
    for part in parts:
        if (unnameable := service.refuses_name(part)) is not None:
            raise Unusable(f"{path!r} cannot be a path: {part!r} {unnameable}")
    return parts


def parsed(files: Mapping[str, str]) -> dict[Segments, str]:
    """Every path the caller gave, taken apart, with what it should hold.

    Two checks that a single path cannot fail on its own. Two spellings of one
    path -- which normalisation and separator trimming both make possible --
    would be one file the caller believes it said two things about. And a path
    that is also a PREFIX of another is a caller asking for one entry to be
    both a file and the folder above one, which no filesystem can do.
    """
    wanted: dict[Segments, str] = {}
    for path, content in files.items():
        taken = segments(path)
        if taken in wanted:
            raise Unusable(f"{path!r} was given twice, spelled two ways")
        wanted[taken] = content
    for path in wanted:
        for depth in range(1, len(path)):
            if path[:depth] in wanted:
                raise Unusable(
                    f"{joined(path[:depth])!r} is asked to be a file and to hold "
                    f"{joined(path)!r}"
                )
    return wanted


def folders_of(wanted: Iterable[Segments]) -> list[Segments]:
    """Every folder these paths need, shallowest first.

    Order is not tidiness: a folder cannot be created before the folder it
    goes in, and sorting by depth is the whole of getting that right.
    """
    return sorted({path[:depth] for path in wanted for depth in range(1, len(path))}, key=len)


# -- what the workspace has ------------------------------------------------------------


def held_paths(nodes: list[Node]) -> dict[Segments, Node]:
    """Every live entry's path, walked DOWN from the root.

    Down rather than up, and that is what makes reachability free: an entry
    under a tombstoned folder is never reached, so it never gets a path, so
    nothing here can find it or write to it -- which is right, because a
    caller naming `attic/notes.md` means the folder it can see, not the one
    somebody deleted last week. Creating a fresh `attic` is the correct answer
    and the one that falls out.

    Names are unique among LIVE siblings -- the controller settles collisions
    -- so a path names at most one entry and this map cannot lose one.
    """
    live = {node.id: node for node in nodes if not node.deleted}
    below: dict[UUID | None, list[Node]] = {}
    for node in live.values():
        if node.parent is None or node.parent in live:
            below.setdefault(node.parent, []).append(node)

    paths: dict[Segments, Node] = {}
    walking: deque[tuple[Segments, Node]] = deque(
        ((node.name,), node) for node in below.get(None, [])
    )
    while walking:
        at, node = walking.popleft()
        paths[at] = node
        for child in below.get(node.id, []):
            walking.append((at + (child.name,), child))
    return paths


async def text_of(
    schema: Workspaces, session: AsyncSession, node: Node
) -> str | None:
    """What this file currently says, or None when it does not say text.

    None for a folder and for a file whose newest write was BYTES, and the
    caller of this treats both the same way: neither can equal the string
    being placed, so neither is ever left alone. A binary file handed a string
    is written over, which is what asking for it to hold that string means.
    """
    held = node.content
    if held is None or held.kind is not Kind.TEXT:
        return None
    return await schema.text.at(session, node.id, held.position)


# -- what came of it -------------------------------------------------------------------


class Change(str, enum.Enum):
    """What one path needed doing to it.

    UNCHANGED is the one worth having a word for. It is not a failure and not
    a no-op the caller should ignore -- it is this function's whole claim to
    being safe to run repeatedly, and a caller watching for churn wants to see
    that the second run was all of these.
    """

    CREATED = "created"
    WRITTEN = "written"
    UNCHANGED = "unchanged"
    DELETED = "deleted"


@final
@dataclass(frozen=True)
class PlacedEntry:
    path: str
    entry: UUID
    type: Type
    change: Change


@final
@dataclass(frozen=True)
class NotPlaced:
    """One path the workspace would not have, and why.

    NAMED BY THE PATH the caller gave, because that is the only name the
    caller has for it -- an entry id would be an answer to a question nobody
    asked.
    """

    path: str
    reason: str
    """One of `contract.Refusal` -- the same closed set every other refusal in
    this package is drawn from."""


@final
@dataclass
class Placed:
    """What one call did, path by path."""

    workspace: UUID
    entries: list[PlacedEntry] = field(default_factory=list)
    refused: list[NotPlaced] = field(default_factory=list)
    """Paths the workspace declined -- a file already sitting where a folder
    was needed, a folder where a file was, a tree already as deep as it may
    go. Reported rather than raised, exactly as `clone.Cloned.refused` is and
    for the same reason: one path that could not land is not a reason to
    throw away every path that did."""

    @property
    def complete(self) -> bool:
        return not self.refused

    def _were(self, change: Change) -> list[PlacedEntry]:
        return [entry for entry in self.entries if entry.change is change]

    @property
    def created(self) -> list[PlacedEntry]:
        return self._were(Change.CREATED)

    @property
    def written(self) -> list[PlacedEntry]:
        return self._were(Change.WRITTEN)

    @property
    def unchanged(self) -> list[PlacedEntry]:
        return self._were(Change.UNCHANGED)

    @property
    def deleted(self) -> list[PlacedEntry]:
        return self._were(Change.DELETED)

    @property
    def files(self) -> list[UUID]:
        """The files whose text this call moved -- what there is to warm.

        Created AND written, unlike a clone's, which are all new. A room that
        already exists still has to be told the file changed under it, and
        `keeper.ensure` is how; the unchanged ones are left alone because
        nothing about them moved.
        """
        return [
            placed.entry
            for placed in self.entries
            if placed.type is Type.FILE
            and placed.change in (Change.CREATED, Change.WRITTEN)
        ]


# -- the unit of work ------------------------------------------------------------------


async def placed_into(
    submission: Submission,
    wanted: Mapping[Segments, str],
    *,
    prune: bool = False,
    overwrite: bool = True,
) -> tuple[Placed, list[Emitted]]:
    """Make this workspace hold exactly these files, at these paths.

    `wanted` is already taken apart and checked -- see `parsed`, which is what
    raises on a call that cannot be satisfied at all, and does it before this
    is reached so that nothing is half-written.

    ONE UNIT OF WORK, in the workspace's controller, like Initialize and like
    a clone: what is being appended is a tree, and a tree half-appended is a
    workspace holding folders whose contents never arrived.

    `overwrite=False` turns "make it so" into "add these": a path already
    holding text that differs is refused `PATH_OCCUPIED` instead of written
    over, and every other path still lands. It is checked AFTER the
    text-equality test, so a call repeated verbatim is still all `UNCHANGED`
    rather than suddenly all refused -- what the flag withholds is the right
    to change text, not the right to say what the text already is.

    Folders are unaffected by it. Creating the folders a path needs takes
    nothing away from anybody, and a folder already there is reused rather
    than written, so there is nothing for the flag to protect.
    """
    schema, session = submission.schema, submission.session
    placed = Placed(workspace=submission.workspace)
    events: list[Emitted] = []

    current = held_paths(await schema.tree.nodes(session, submission.workspace))
    holders: dict[Segments, UUID] = {
        path: node.id for path, node in current.items() if node.is_folder
    }
    unusable: dict[Segments, str] = {}
    """Folder paths nothing can be put under, and why not.

    Filled from BOTH halves of the same question -- a file already sitting at
    that path, and a folder this call tried and failed to create -- because a
    file underneath either one fails identically and should be told which.
    Shallowest-first order is what makes it transitive: a folder whose own
    parent is in here goes in here, so a leaf never has to walk back up.
    """

    async def refused_because(request: Create | Write | Delete) -> str | None:
        """Adjudicate one request, keep its events, and say why not, if not.

        THE REASON, not a flag. A file the workspace declined declined it for
        a reason of its own -- too deep, a full folder, a name it will not
        take -- and a caller reading `Placed.refused` is reading it to find
        out which. Only a file whose FOLDER could not be made is told
        `CREATE_REFUSED`, because that one really is somebody else's problem.
        """
        outcome = await service.adjudicate(submission, request)
        events.extend(outcome.events)
        answer = outcome.response
        return answer.reason if isinstance(answer, Rejected) else None

    # -- the folders the paths need, shallowest first --------------------------------

    for path in folders_of(wanted):
        if path[:-1] in unusable:
            unusable[path] = unusable[path[:-1]]
            continue
        held = current.get(path)
        if held is not None:
            if not held.is_folder:
                unusable[path] = Refusal.PARENT_NOT_A_FOLDER
            continue  # a folder already there is the folder that was wanted
        made = mint()
        if await refused_because(
            Create(
                transaction=mint(),
                id=made,
                type=Type.FOLDER,
                name=path[-1],
                parent=holders.get(path[:-1]),
                content=None,
            )
        ) is not None:
            """`CREATE_REFUSED` rather than this folder's own reason, which is
            the same call `reconcile` makes for an outbox: "too deep" is true
            of the folder and would be a lie about the file inside it."""
            unusable[path] = Refusal.CREATE_REFUSED
            continue
        holders[path] = made
        placed.entries.append(
            PlacedEntry(joined(path), made, Type.FOLDER, Change.CREATED)
        )

    # -- the files themselves ---------------------------------------------------------

    for path, content in sorted(wanted.items()):
        pretty = joined(path)
        if (blocked := unusable.get(path[:-1])) is not None:
            placed.refused.append(NotPlaced(pretty, blocked))
            continue
        held = current.get(path)

        if held is None:
            made = mint()
            if (why := await refused_because(
                Create(
                    transaction=mint(),
                    id=made,
                    type=Type.FILE,
                    name=path[-1],
                    parent=holders.get(path[:-1]),
                    content=TextBody(content=content),
                )
            )) is not None:
                placed.refused.append(NotPlaced(pretty, why))
                continue
            placed.entries.append(
                PlacedEntry(pretty, made, Type.FILE, Change.CREATED)
            )
            continue

        if held.is_folder:
            placed.refused.append(NotPlaced(pretty, Refusal.NOT_A_FILE))
            continue
        if await text_of(schema, session, held) == content:
            """The point of the whole exercise. Nothing is written, so nothing
            takes a position, nothing is announced, and a client with the file
            open does not see it flicker."""
            placed.entries.append(
                PlacedEntry(pretty, held.id, Type.FILE, Change.UNCHANGED)
            )
            continue
        if not overwrite:
            """Told to add, and something else is already here. Refused rather
            than raised: one occupied path is not a reason to throw away the
            files that had nowhere to conflict with."""
            placed.refused.append(NotPlaced(pretty, Refusal.PATH_OCCUPIED))
            continue
        if held.content_version is None:
            raise LookupError(f"file {held.id} holds no content to write against")
        if (why := await refused_because(
            Write(
                transaction=mint(),
                id=held.id,
                content_version=held.content_version,
                content=TextBody(content=content),
            )
        )) is not None:
            placed.refused.append(NotPlaced(pretty, why))
            continue
        placed.entries.append(PlacedEntry(pretty, held.id, Type.FILE, Change.WRITTEN))

    # -- and, if asked, everything else -----------------------------------------------

    if prune:
        events.extend(await _pruned(submission, placed, current, wanted))

    events.extend(await service.settle(submission))
    return placed, events


async def _pruned(
    submission: Submission,
    placed: Placed,
    current: Mapping[Segments, Node],
    wanted: Mapping[Segments, str],
) -> list[Emitted]:
    """Delete every live entry these paths did not name.

    THE DESTRUCTIVE HALF, and it is opt-in for that reason alone. "Make the
    workspace look like this" is a thing a caller can genuinely mean -- a
    generated project, a fixture, a workspace rebuilt from a source of truth
    -- and it is also one keystroke from emptying somebody's work, so nothing
    here does it unless asked.

    DEEPEST FIRST, so a folder is emptied before it is tombstoned. Deleting a
    folder tombstones the folder and not its contents, so the other order
    would leave the subtree in the logs, unreachable and undeleted -- exactly
    the state `held_paths` has to walk around.

    A path that is KEPT keeps its ancestors: every folder a wanted path needs
    is in the kept set too, so this can never delete a folder something above
    still lives in.

    Nothing already touched above is reachable here, so the tokens read at the
    start are still this entry's -- which is what a delete has to present.
    """
    kept = set(wanted) | set(folders_of(wanted))
    deepest = sorted(current.items(), key=lambda held: len(held[0]), reverse=True)
    events: list[Emitted] = []
    for path, node in deepest:
        if path in kept:
            continue
        outcome = await service.adjudicate(
            submission,
            Delete(
                transaction=mint(),
                id=node.id,
                seen=Seen(
                    name_version=node.name_version,
                    parent_version=node.parent_version,
                    deleted_version=node.deleted_version,
                    content_version=node.content_version,
                ),
            ),
        )
        events.extend(outcome.events)
        if isinstance(outcome.response, Rejected):
            placed.refused.append(NotPlaced(joined(path), outcome.response.reason))
            continue
        placed.entries.append(
            PlacedEntry(joined(path), node.id, node.entry.type, Change.DELETED)
        )
    return events
