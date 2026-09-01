# pyright: reportUnusedFunction=false
"""The router a host mounts, and the units of work behind it.

Every WRITE -- transactional requests and Initialize alike -- flows through the
workspace's controller: serialized per workspace, fanned out after commit.
READS (Content, blobs) bypass it; MVCC handles them.

Nothing here decides anything that belongs to the host. It is handed a schema
(`build_models`), a database, a blob store, and a dependency that says which
user may reach a workspace -- and it makes no other assumption about either.

TOPOLOGY INVARIANT: exactly one process serves a workspace's writes and
streams, and nothing enforces it (ARCHITECTURE.md invariant 11).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Protocol, final
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
)
from fastapi import Path as APIPath
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from ...wsfs_suede__sqlmodel_utils_suede.associations import now
from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

from . import history as history_of
from . import records
from . import study as studying
from . import tutor as tutoring
from .minted import minted_at
from . import clone as cloning
from . import place as placing
from . import reconstruct, refusals, service
from .blobs import Blobs
from .clone import Cloned
from .place import Placed
from .contract import (
    Accepted,
    Answering,
    Asked,
    Asking,
    Clearing,
    Create,
    Detected,
    Executed,
    Executions,
    History,
    InitializeRequest,
    InitializeResponse,
    Judged,
    Judging,
    Occurrence,
    PlacementRequest,
    ReconstructionRequest,
    ReconstructionResponse,
    Recorded,
    Refusal,
    Rejected,
    Rejection,
    RoomStanding,
    RoomStored,
    SnapshotEntry,
    SnapshotTaken,
    StrandedDrafts,
    StreamEvent,
    Submitted,
    TextContentResponse,
    Transcript,
)
from .controller import ControllerRegistry, WorkspaceController
from .collaboration import ICollaboration
from .models import Models
from .keeper import Keeper, WsfsFiles, RememberedRooms
from .service import Workspaces
from .stream import Emitted
from .resolve import resolve_content

TOKEN_TTL = timedelta(seconds=60)

SHARDING_ACKNOWLEDGED = "WSFS_WORKSPACES_ARE_ROUTED_STICKILY"

Authorize = Callable[..., Awaitable[UUID]]
"""A host dependency: given the request, the user who may reach this
workspace. Raising is how a host refuses -- this package never asks who
anybody is, and never decides whether they may."""


def refuse_to_split_the_brain() -> None:
    """One process per workspace is a correctness requirement, and `--workers 4`
    is one keystroke from silently violating it. Session affinity is not the
    fix either: routing that may fail is, for correctness, routing that does
    not exist. Anyone who has genuinely solved it says so out loud.

    This reads the environment, which is where the mistake usually lives but
    not where it always lives: `WEB_CONCURRENCY` is only uvicorn's DEFAULT for
    `--workers`, so an explicit `--workers 4` sets nothing here and starts
    four processes anyway. Nothing in this codebase catches that -- running
    one instance is the host's promise, and ARCHITECTURE.md invariant 11 says
    what it costs to break it."""
    workers = int(os.getenv("WEB_CONCURRENCY", "1"))
    if workers > 1 and not os.getenv(SHARDING_ACKNOWLEDGED):
        raise RuntimeError(
            f"WEB_CONCURRENCY={workers} would serve one workspace from several "
            f"processes. Run a single worker, or set {SHARDING_ACKNOWLEDGED} "
            "once each workspace is pinned to exactly one of them."
        )


@final
@dataclass(frozen=True)
class Backend:
    """One wsfs, bound: its schema, where it stores things, and who serializes
    writes to it."""

    schema: Workspaces
    database: Database
    blobs: Blobs
    registry: ControllerRegistry
    heartbeat_seconds: float
    max_blob_bytes: int
    keeper: Keeper
    answering: tutoring.Tutoring

    @classmethod
    def over(
        cls,
        models: Models,
        database: Database,
        blobs: Blobs,
        *,
        heartbeat_seconds: float,
        grace_seconds: float,
        max_blob_bytes: int,
        liveblocks: ICollaboration,
        tutor: tutoring.ITutor,
    ) -> "Backend":
        schema = Workspaces.over(models)
        return cls(
            schema=schema,
            database=database,
            blobs=blobs,
            registry=ControllerRegistry(
                database, schema.stream, grace_seconds=grace_seconds
            ),
            heartbeat_seconds=heartbeat_seconds,
            max_blob_bytes=max_blob_bytes,
            keeper=Keeper(
                collaboration=liveblocks,
                files=WsfsFiles(schema, database),
                standings=RememberedRooms(schema.models, database),
            ),
            answering=tutoring.Tutoring(tutor, now),
        )

    @property
    def models(self) -> Models:
        return self.schema.models


# -- reconciliation --------------------------------------------------------------


@dataclass
class Reconciliation:
    """Initialize's verdict on a presented outbox, in the order it was given."""

    applied: list[UUID] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    events: list[Emitted] = field(default_factory=list)

    def record(self, transaction: UUID, outcome: service.Outcome) -> None:
        self.events.extend(outcome.events)
        answer = outcome.response
        if isinstance(answer, Rejected):
            self.rejected.append(
                Rejection(
                    transaction=transaction,
                    reason=answer.reason,
                    version=answer.version,
                )
            )
        else:
            self.applied.append(transaction)


@final
class Stillborn:
    """Entries whose queued create was refused.

    New with queued creates: everything later in the outbox that names one
    would otherwise be adjudicated against an entry that does not exist,
    turning one real failure into a cascade of confusing secondary ones.
    """

    def __init__(self) -> None:
        self._ids: set[UUID] = set()

    def __contains__(self, request: Submitted) -> bool:
        return request.id in self._ids

    def note(self, request: Submitted, outcome: service.Outcome) -> None:
        if isinstance(request, Create) and outcome.response.rejected:
            self._ids.add(request.id)


async def _never_attempted(
    submission: service.Submission, request: Submitted
) -> service.Outcome:
    """Refused without being judged -- and recorded all the same.

    This is the one refusal that never reaches `adjudicate`, and for a while
    it was therefore the one that kept nothing. That was the worst possible
    place to lose work: replay is the path a queue comes home by, so a single
    refused create silently discarded every keystroke queued behind it.
    """
    return await service.declined(submission, request, Refusal.CREATE_REFUSED)


async def reconcile(
    submission: service.Submission, outbox: list[Submitted]
) -> Reconciliation:
    """An outbox applied in counter order.

    Nothing rewrites the tokens a client presented: it minted them, so it
    already knows what its own queued work produces and chained accordingly.
    """
    reconciliation = Reconciliation()
    stillborn = Stillborn()
    for request in outbox:
        outcome = (
            await _never_attempted(submission, request)
            if request in stillborn
            else await service.adjudicate(submission, request)
        )
        stillborn.note(request, outcome)
        reconciliation.record(request.transaction, outcome)
    return reconciliation


async def mint_token(
    backend: Backend, session: AsyncSession, submission: service.Submission
) -> str:
    """Bound to the position this snapshot was taken at, so the stream that
    claims it replays exactly the changes the snapshot does not show.

    Read out of the LOGS, in this transaction, rather than off the
    controller's counter. The counter is the next number to hand out and it
    moves before a submission commits, so a submission that rolls back leaves
    it above anything committed. That costs the stream nothing -- positions
    have to increase, not to be dense -- but a token is a promise about what
    has already happened, and one bound to a number no row carries would tell
    a stream to skip the row that eventually takes it.

    The rows this transaction has flushed are visible to this session, so this
    is exactly what the snapshot alongside it shows: no gap, no repeat.
    """
    token = secrets.token_hex(nbytes=16)
    session.add(
        backend.models.token(
            token=token,
            user_id=submission.user,
            workspace_id=submission.workspace,
            position=await backend.schema.stream.high_water(
                session, submission.workspace
            ),
            expires=now() + TOKEN_TTL,
        )
    )
    return token


async def claim_token(
    backend: Backend, session: AsyncSession, workspace_id: UUID, token: str
) -> int:
    """Single-use by construction: the claim and the lookup are one statement,
    so two racing connects produce exactly one winner."""
    tokens = backend.models.token
    connection = await session.connection()
    claimed = (
        await connection.execute(
            delete(tokens)
            .where(
                col(tokens.token) == token,
                col(tokens.workspace_id) == workspace_id,
                col(tokens.expires) > func.now(),
            )
            .returning(col(tokens.position))
        )
    ).first()
    await session.commit()
    if claimed is None:
        raise HTTPException(401, "invalid or spent token")
    return claimed[0]


# -- the two units of work every write is one of ------------------------------------


@asynccontextmanager
async def submitting(
    backend: Backend, controller: WorkspaceController, user_id: UUID
) -> AsyncGenerator[service.Submission]:
    """The workspace is not checked for existence here. The host's dependency
    already said this user may reach it; re-deciding that would be this
    package overreaching, and a workspace id it never issued fails on the
    foreign key -- which is the database telling the host what it knew."""
    async with backend.database.session() as session:
        yield service.Submission(
            schema=backend.schema,
            session=session,
            workspace=controller.workspace_id,
            user=user_id,
            blobs=backend.blobs,
            positions=controller.positions,
        )


async def initialize_within(
    backend: Backend,
    controller: WorkspaceController,
    user_id: UUID,
    body: InitializeRequest,
) -> tuple[InitializeResponse, list[Emitted]]:
    """ONE database transaction: adjudicate the outbox in order, settle names,
    snapshot, and mint the position-bound token together. Splitting it apart
    kills the no-flicker and no-gap guarantees silently."""
    async with submitting(backend, controller, user_id) as submission:
        reconciliation = await reconcile(submission, body.outbox)
        # Before the snapshot, so it shows the names that settled.
        reconciliation.events.extend(await service.settle(submission))
        response = await _snapshot_and_token(backend, submission, reconciliation)
        await submission.session.commit()
        return response, reconciliation.events


async def _snapshot_and_token(
    backend: Backend, submission: service.Submission, reconciliation: Reconciliation
) -> InitializeResponse:
    session = submission.session
    await session.flush()
    return InitializeResponse(
        token=await mint_token(backend, session, submission),
        entries=await service.snapshot(backend.schema, session, submission.workspace),
        applied=reconciliation.applied,
        rejected=reconciliation.rejected,
    )


async def apply_within(
    backend: Backend, controller: WorkspaceController, user_id: UUID, request: Submitted
) -> tuple[service.Outcome, list[Emitted]]:
    async with submitting(backend, controller, user_id) as submission:
        outcome = await service.adjudicate(submission, request)
        events = [*outcome.events, *await service.settle(submission)]
        await submission.session.commit()
        return outcome, events


async def clone_within(
    backend: Backend, controller: WorkspaceController, user_id: UUID, source: UUID
) -> tuple[Cloned, list[Emitted]]:
    """ONE database transaction, in the TARGET's controller, for the same
    reason Initialize is one: what is being appended is a tree, and a tree
    half-appended is a workspace holding folders whose contents never arrived.

    The source is only read, and reads do not go through its controller.
    Holding both would be two locks in an order nothing agrees on, and a
    workspace cloning itself would deadlock on the first one.
    """
    async with submitting(backend, controller, user_id) as submission:
        cloned, events = await cloning.copied_into(submission, source)
        await submission.session.commit()
        return cloned, events


async def place_within(
    backend: Backend,
    controller: WorkspaceController,
    user_id: UUID,
    wanted: Mapping[placing.Segments, str],
    prune: bool,
    overwrite: bool,
) -> tuple[Placed, list[Emitted]]:
    """ONE database transaction, like Initialize and like a clone: what is
    being appended is a tree, and a tree half-appended is a workspace holding
    folders whose contents never arrived."""
    async with submitting(backend, controller, user_id) as submission:
        placed, events = await placing.placed_into(
            submission, wanted, prune=prune, overwrite=overwrite
        )
        await submission.session.commit()
        return placed, events


WARMING_AT_ONCE = 8
"""How many of a clone's rooms are filled concurrently.

Filling one is three sequential calls to the collaboration server and about
two seconds, so a thousand-file clone done one at a time would take half an
hour -- and done all at once would open a thousand connections to a service
that has an opinion about that. Neither number is tuned; this one is small
enough to be polite and large enough that the wall clock is not the sum.
"""


async def warmed(backend: Backend, entries: Sequence[UUID]) -> None:
    """Settle each of these files' rooms, the way the tree does when one is
    made or written.

    THE PATH BULK WORK SHOULD USE. A room that nobody filled costs the first
    person to open that file 1.7-2.3 seconds, once, forever -- and a clone
    makes every one of its files somebody's first open. Doing it here means
    nobody is waiting for it (AUDIT.md, section 2). For a file that was
    WRITTEN rather than created the room may already exist and be holding the
    old text, and this is the same call that tells it otherwise.

    FAILURES ARE SWALLOWED, and that is the whole of what they cost. The work
    is already committed; a room this could not settle is settled on the next
    open instead. Turning a collaboration server's bad minute into a failed
    clone would be trading something durable for something that is only ever
    an optimisation.
    """
    gate = asyncio.Semaphore(WARMING_AT_ONCE)

    async def fill(entry: UUID) -> None:
        async with gate:
            _ = await backend.keeper.ensure(str(entry))

    _ = await asyncio.gather(
        *(fill(entry) for entry in entries), return_exceptions=True
    )


async def content_response(
    backend: Backend, session: AsyncSession, held: Any
) -> Response:
    """The same answer whether this write landed or not.

    The version a refused write reports is its TRANSACTION, not the surrogate
    key of the row keeping it: the transaction is the only name the client
    ever knew it by, and a refusal never became a token anyone can present.
    """
    models = backend.models
    if isinstance(held, models.refused_text):
        body = TextContentResponse(
            content=await refusals.text_of(session, models, backend.schema.text, held),
            version=held.transaction,
        )
        return JSONResponse(
            body.model_dump(mode="json"), headers={"ETag": str(held.transaction)}
        )
    if isinstance(held, models.refused_blob):
        return Response(
            content=await backend.blobs.read(held.hash),
            media_type=held.mime,
            headers={"ETag": str(held.transaction), "X-Content-Hash": held.hash},
        )
    if isinstance(held, models.text_content):
        body = TextContentResponse(
            content=await backend.schema.text.at(session, held.entry_id, held.position),
            version=held.id,
        )
        return JSONResponse(
            body.model_dump(mode="json"), headers={"ETag": str(held.id)}
        )
    return Response(
        content=await backend.blobs.read(held.hash),
        media_type=held.mime,
        headers={"ETag": str(held.id), "X-Content-Hash": held.hash},
    )


async def referenced_by(
    backend: Backend, session: AsyncSession, workspace_id: UUID, digest: str
) -> bool:
    """Whether any write in this workspace points at these bytes.

    The blob store is shared across the deployment, so this -- not the store
    -- is what scopes a read to a workspace. `hash` is indexed, and the join
    to entries is what makes the answer this workspace's rather than anyone's.
    """
    written, entry = backend.models.blob_content, backend.models.entry
    referencing = (
        select(written)
        .join(entry, col(entry.id) == col(written.entry_id))
        .where(col(entry.workspace_id) == workspace_id, col(written.hash) == digest)
    )
    if (await session.exec(referencing)).first() is not None:
        return True

    # A write that was REFUSED names these bytes too, and they are the only
    # copy of what somebody uploaded. Reachable through `content` by its
    # transaction already; this is the other door onto the same bytes, and the
    # two disagreeing is how one of them ends up serving a 404 for something
    # the other hands over.
    refused = backend.models.refused_blob
    named = select(refused).where(
        col(refused.workspace_id) == workspace_id, col(refused.hash) == digest
    )
    return (await session.exec(named)).first() is not None


def declared_size(request: Request) -> int | None:
    """A Store sends Content-Length. Without one, the body's size is unknown
    until it has been buffered -- which is the thing a limit exists to stop."""
    declared = request.headers.get("content-length")
    return None if declared is None else int(declared)


# -- the stream -----------------------------------------------------------------------


def sent(event_payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(event_payload)}\n\n"


HEARTBEAT = ": hb\n\n"


async def follow(
    backend: Backend, workspace_id: UUID, after: int, queue: asyncio.Queue[Emitted]
) -> AsyncIterator[str]:
    """Replay what the token's position missed, then follow live.

    Subscribing happens before the replay reads, so an event committed in
    between lands in both -- and the position cursor drops the duplicate.
    """
    cursor = after
    async with backend.database.session() as session:
        replay = await backend.schema.stream.since(session, workspace_id, after)
    for emitted in replay:
        cursor = emitted.position
        yield sent(emitted.event.payload())
    while True:
        try:
            emitted = await asyncio.wait_for(queue.get(), backend.heartbeat_seconds)
        except asyncio.TimeoutError:
            yield HEARTBEAT
            continue
        if emitted.position <= cursor:
            continue
        cursor = emitted.position
        yield sent(emitted.event.payload())


# -- the router, and everything behind it -----------------------------------------------
#
# Each route's work is a closure over the backend, and each of them is handed
# back beside the router. A host that mounts this and never looks at them has
# lost nothing; a host that is ALSO the consumer -- an assistant assembling the
# files a user can see, a job writing a file on somebody's behalf -- calls the
# function instead of making an HTTP request to itself, which is the same work
# without the serialisation, the socket, or a second copy of its own auth.
#
# THE ONE DIFFERENCE from calling over HTTP is who says which user. Over the
# wire that is `authorize`, run by FastAPI from the request; called directly it
# is an argument, because there is no request to read it from. That is exactly
# the decision an in-process caller has to make on purpose, and making it an
# argument is what stops it being made by default.


class CloneWorkspace(Protocol):
    """Copy one workspace's live tree into another.

    DELIBERATELY NOT A ROUTE. Every route here asks `authorize` one question --
    may this caller reach THIS workspace -- and a clone needs two answers about
    two workspaces, read from one and written to the other. A dependency shaped
    around a single path parameter cannot give both, and a route that took the
    other workspace in its body would be asking the caller to name a workspace
    nobody checked they may read. So the permission question stays where the
    workspaces come from: the consumer that already knows why it is cloning.
    """

    async def __call__(
        self, *, source: UUID, target: UUID, user: UUID, warm: bool = True
    ) -> Cloned:
        """Every file and folder the source can still see, appended to the
        target as ordinary creates, and a row per copy saying where it came
        from.

        `user` is who this is done on behalf of: every create it writes is
        attributed to them, and so is every clone record. NOTHING HERE CHECKS
        THEM -- see the class docstring.

        `warm` fills each copied file's collaboration room before returning,
        which is what makes the first open of a cloned file instant. Turn it
        off for a clone nobody is about to open, or to answer sooner and warm
        the rooms yourself.
        """
        ...


class PlaceFiles(Protocol):
    """Make a workspace hold these files, at these paths, with this text.

    THE WHOLE OF IT, unlike `clone`, which has no route at all. One workspace
    is named, so `authorize` answers for it perfectly well, and the additive
    half of this -- `overwrite=False`, no `prune` -- is `POST
    /workspaces/{id}/files` (see `add_files`), because a client logged in on
    behalf of a user adding files to that user's workspace is an ordinary
    thing to mean.

    WHAT THE ROUTE DOES NOT EXPOSE is the other two arguments, and they are
    the reason this stayed in-process for as long as it did. Every write a
    CLIENT makes says what it thought it was replacing; an overwrite here
    presents no token for text somebody may have open, and `prune` deletes
    every path the call did not name. Together they are "make it so", which is
    a thing a host may mean and a browser may not -- so they are reachable
    only by holding this, and never by asking for them in a body.
    """

    async def __call__(
        self,
        *,
        workspace: UUID,
        files: Mapping[str, str],
        user: UUID,
        prune: bool = False,
        overwrite: bool = True,
        warm: bool = True,
    ) -> Placed:
        """`files` maps a `/`-separated path to the text it should hold.
        Folders along the way are created as needed and reused when they are
        already there.

        DECLARATIVE, and therefore worth calling twice: a path already holding
        exactly that text is left completely alone -- no transaction, no
        position, no event -- so a second call with the same argument is free
        and silent.

        `prune` deletes every live entry these paths did not name, which is
        what turns "put these files here" into "make the workspace look like
        this". Off by default because it is the one thing here that destroys
        something.

        `overwrite=False` withholds the right to CHANGE text: a path already
        holding something different is refused `PATH_OCCUPIED` and left
        exactly as it was, while every other path still lands. It does not
        withhold the silent case -- a path already holding that exact text is
        still `UNCHANGED` -- so an additive call is as repeatable as any
        other. This is the shape the route uses.

        `user` is who this is done on behalf of, and nothing here checks them
        -- see the class docstring. Over the route it is `authorize` that
        says who; called directly it is this argument, which is the one
        difference between the two doors. `warm` settles each moved file's
        collaboration room before returning.

        Raises `place.Unusable`, before writing anything, for a call that
        cannot be satisfied at all: a path that is not a path, one path given
        twice, or one path asked to be both a file and the folder above
        another. What the WORKSPACE declines comes back in `Placed.refused`.
        """
        ...


Initialize = Callable[[UUID, InitializeRequest, UUID], Awaitable[InitializeResponse]]
Transact = Callable[[UUID, Submitted, UUID], Awaitable[Response]]
AddFiles = Callable[[UUID, PlacementRequest, UUID], Awaitable[Placed]]
Store = Callable[[str, Request, UUID], Awaitable[Response]]
FetchBlob = Callable[[UUID, str, UUID], Awaitable[Response]]
FetchContent = Callable[[UUID, UUID, UUID | None, UUID], Awaitable[Response]]
FetchHistory = Callable[[UUID, UUID, datetime | None, int, UUID], Awaitable[History]]
FetchExecutions = Callable[[UUID, UUID, int, UUID], Awaitable[Executions]]
FetchSnapshot = Callable[[UUID, UUID, UUID], Awaitable[SnapshotTaken]]
FetchDrafts = Callable[[UUID, UUID], Awaitable[StrandedDrafts]]
ClearDrafts = Callable[[UUID, Clearing, UUID], Awaitable[None]]
Reconstruct = Callable[
    [UUID, ReconstructionRequest, UUID], Awaitable[ReconstructionResponse]
]
Follow = Callable[[UUID, str], Awaitable[StreamingResponse]]
Ask = Callable[[UUID, Asking, UUID], Awaitable[Asked]]
Hear = Callable[[UUID, str, UUID], Awaitable[StreamingResponse]]
FetchTranscript = Callable[[UUID, datetime | None, int, UUID], Awaitable[Transcript]]
RecordDetection = Callable[[UUID, Detected, UUID], Awaitable[None]]
RecordAcceptance = Callable[[UUID, Accepted, UUID], Awaitable[None]]
RecordActivity = Callable[[UUID, Recorded, UUID], Awaitable[None]]
EnsureRoom = Callable[[UUID, UUID, UUID], Awaitable[RoomStanding]]
WarmRoom = Callable[[UUID, UUID, BackgroundTasks, UUID], Awaitable[None]]
RecordStored = Callable[[UUID, UUID, RoomStored, UUID], Awaitable[None]]
HandOver = Callable[[UUID, UUID, Request, UUID], Awaitable[Response]]
"""One alias per route, in the order the routes are declared.

POSITIONAL, every one of them, because that is all a `Callable` can express
and because the last argument is the interesting one: where a request would
have carried the user through `authorize`, an in-process caller passes it. The
routes spell that parameter `_` when the route itself does not read it -- the
dependency still runs -- so calling by keyword is not the way in.
"""


@final
@dataclass(frozen=True)
class Mounted:
    """What a host gets back: the router, and the work behind every route.

    `include_router(mounted.router)` is the whole of mounting it. Everything
    else here is for the host that is also a consumer -- see the note above.
    """

    router: APIRouter

    clone: CloneWorkspace
    """The one piece of work that is NOT a route: a clone's permission
    question spans two workspaces, and `authorize` answers about one."""

    place: PlaceFiles
    """A placement, with the two arguments the route withholds.

    `add_files` below is this same work with `overwrite=False` and no
    `prune`. Holding this is what lets a host mean "make it so" -- overwrite
    text nobody presented a token for, delete every path the call did not
    name -- which is exactly the reason it is not askable for over HTTP.
    """

    initialize: Initialize
    transact: Transact
    add: AddFiles
    store: Store
    fetch_blob: FetchBlob
    content: FetchContent
    history: FetchHistory
    executions: FetchExecutions
    snapshot: FetchSnapshot
    drafts: FetchDrafts
    clear_drafts: ClearDrafts
    reconstruction: Reconstruct
    stream: Follow
    ask: Ask
    hear: Hear
    conversation: FetchTranscript
    detected: RecordDetection
    accepted: RecordAcceptance
    activity: RecordActivity
    ensure_room: EnsureRoom
    warm_room: WarmRoom
    room_stored: RecordStored
    hand_over: HandOver


def create_router(
    *, backend: Backend, authorize: Authorize, prefix: str = "/wsfs"
) -> Mounted:
    """A router to include in a host's app, and the work behind it.

    The backend is built by the host (`Backend.over`) rather than in here, so
    the host keeps a handle on it -- for `shutdown`, for its own queries, for
    whatever else it owns. The host owns the database and the blob store too,
    so it disconnects them; the only thing this router puts down is its own
    controllers, which it does in a lifespan of its own.

    RETURNS `Mounted` rather than the router alone. The router is still the
    only thing a host has to do anything with; the rest is there so that a
    consumer in this process can do a thing directly instead of making an HTTP
    request to itself, and so that `clone` -- which cannot be a route -- has
    somewhere to be handed over.
    """
    refuse_to_split_the_brain()
    database = backend.database

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await backend.registry.shutdown()

    router = APIRouter(prefix=prefix, lifespan=lifespan)

    @asynccontextmanager
    async def serving(workspace_id: UUID) -> AsyncGenerator[WorkspaceController]:
        """The workspace's controller, held for the whole submission."""
        async with backend.registry.visiting(workspace_id) as controller:
            yield controller

    async def clone_workspace(
        *, source: UUID, target: UUID, user: UUID, warm: bool = True
    ) -> Cloned:
        """Not a route, and not registered on one. See `CloneWorkspace`."""
        async with serving(target) as controller:
            cloned = await controller.submit(
                lambda: clone_within(backend, controller, user, source)
            )
        if warm:
            # Outside the controller: the workspace's writes are done, and
            # holding its one writer for a couple of seconds per file would
            # stall everybody else in it for the sake of an optimisation.
            await warmed(backend, cloned.files)
        return cloned

    async def place_files(
        *,
        workspace: UUID,
        files: Mapping[str, str],
        user: UUID,
        prune: bool = False,
        overwrite: bool = True,
        warm: bool = True,
    ) -> Placed:
        """All of it, including what the route will not ask for. See
        `PlaceFiles`; `add_files` is this with the destructive half nailed
        shut."""
        wanted = placing.parsed(files)  # raises before the controller is taken
        async with serving(workspace) as controller:
            placed = await controller.submit(
                lambda: place_within(
                    backend, controller, user, wanted, prune, overwrite
                )
            )
        if warm:
            await warmed(backend, placed.files)
        return placed

    @router.post(
        "/workspaces/{workspace_id}/initialize", response_model_exclude_none=True
    )
    async def initialize(
        workspace_id: Annotated[UUID, APIPath()],
        body: Annotated[InitializeRequest, Body()],
        # Not Annotated[..., Depends(authorize)]: annotations here are strings,
        # and a closure variable is not in the globals they resolve against.
        user: UUID = Depends(authorize),
    ) -> InitializeResponse:
        async with serving(workspace_id) as controller:
            return await controller.submit(
                lambda: initialize_within(backend, controller, user, body)
            )

    @router.post("/workspaces/{workspace_id}/transactions")
    async def transact(
        workspace_id: Annotated[UUID, APIPath()],
        body: Annotated[Submitted, Body()],
        user: UUID = Depends(authorize),
    ) -> Response:
        async with serving(workspace_id) as controller:
            outcome = await controller.submit(
                lambda: apply_within(backend, controller, user, body)
            )
        return JSONResponse(
            outcome.response.model_dump(mode="json", exclude_none=True),
            status_code=409 if outcome.response.rejected else 200,
        )

    @router.post("/workspaces/{workspace_id}/files")
    async def add_files(
        workspace_id: Annotated[UUID, APIPath()],
        body: Annotated[PlacementRequest, Body()],
        user: UUID = Depends(authorize),
    ) -> Placed:
        """Add these files, at these paths, with this text.

        THE ADDITIVE HALF of `place`, and the only half with a URL. A client
        logged in on behalf of a user putting files into that user's workspace
        is an ordinary thing to mean, and having to walk the tree, mint an id
        per folder and chain CAS tokens by hand to say it is a tax on saying
        something harmless. What it may NOT mean is the rest of `place`:
        `overwrite=False` is passed here and not read from the body, and
        `prune` has no field at all -- so nothing arriving over this route can
        change text it did not write or delete anything whatsoever.

        A path already holding something else is refused, per path, rather
        than written over, and everything that had nowhere to conflict still
        lands. That is the same shape every other refusal in this package has
        and the reason this answers 200 with a list rather than 409 with
        nothing: one occupied path is a fact about the workspace, not a
        malformed call.

        REPEATABLE, like the function behind it. A path already holding
        exactly this text is `unchanged` -- no transaction, no event, no
        flicker for anybody with the file open -- so a client that cannot tell
        whether its last attempt landed can simply send it again.

        400, and only 400, for `place.Unusable`: a path that is not a path,
        one path spelled two ways, or one path asked to be both a file and the
        folder above another. That is the CALL being wrong, it is caught
        before anything is written, and a workspace half-described by it would
        be a state nobody asked for.
        """
        try:
            placed = await place_files(
                workspace=workspace_id,
                files=body.files,
                # From the request, never from the body. Over the wire this is
                # the whole of who is acting; the argument exists for the
                # in-process caller that has no request to read it from.
                user=user,
                prune=False,
                overwrite=False,
            )
        except placing.Unusable as unusable:
            raise HTTPException(400, str(unusable)) from unusable
        return placed

    @router.put("/workspaces/{workspace_id}/blobs/{digest}")
    async def store(
        digest: str,
        request: Request,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Under a workspace because that is the only question a host's
        `authorize` can answer -- which is also why the id appears in the path
        and not in this signature: the host's dependency is what reads it. The
        bytes themselves are stored once for the deployment and named by their
        hash -- two workspaces holding the same file hold one copy -- but
        somebody who may reach no workspace at all may not fill the
        deployment's disk either."""
        if await backend.blobs.holds(digest):
            return JSONResponse({"rejected": False})  # idempotent by construction
        size = declared_size(request)
        if size is None or size > backend.max_blob_bytes:
            return JSONResponse({"rejected": True, "reason": "too large"}, 413)
        if not await backend.blobs.store(digest, await request.body()):
            return JSONResponse({"rejected": True, "reason": "hash mismatch"}, 409)
        return JSONResponse({"rejected": False})

    @router.get("/workspaces/{workspace_id}/blobs/{digest}")
    async def fetch_blob(
        workspace_id: Annotated[UUID, APIPath()],
        digest: str,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Served only to a workspace that WRITES these bytes somewhere.

        A hash is not a secret: it travels in `X-Content-Hash`, in every
        `BinaryBody`, and through any client that ever held the file. So
        knowing one buys nothing here -- the caller has to be someone the host
        lets into a workspace whose own content log names it.
        """
        async with database.session() as session:
            referenced = await referenced_by(backend, session, workspace_id, digest)
        if not (referenced and await backend.blobs.holds(digest)):
            raise HTTPException(404, "no such blob")
        return Response(
            await backend.blobs.read(digest), media_type="application/octet-stream"
        )

    @router.get("/workspaces/{workspace_id}/entries/{entry_id}/content")
    async def content(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        content: UUID | None = None,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Omitting `content` asks for the entry's newest."""
        async with database.session() as session:
            return await content_response(
                backend,
                session,
                await resolve_content(
                    backend.schema, session, workspace_id, entry_id, content
                ),
            )

    @router.get("/workspaces/{workspace_id}/entries/{entry_id}/history")
    async def history(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        before: datetime | None = None,
        limit: int = 10,
        user: UUID = Depends(authorize),
    ) -> History:
        """What this file has said, newest first.

        Scoped to the CALLER for everything except what the workspace
        accepted: a draft is work that reached nobody, so the author is the
        only person who has ever seen it, and listing somebody else's would
        publish typing they never shared.

        Paged by `before` rather than by an offset, because rows arrive while
        somebody is reading and an offset would show one twice or skip one.
        """
        async with database.session() as session:
            versions, more = await history_of.of_entry(
                session,
                backend.models,
                workspace_id,
                entry_id,
                user,
                before,
                max(1, min(limit, 100)),
            )
            return History(versions=versions, more=more)

    @router.get("/workspaces/{workspace_id}/entries/{entry_id}/executions")
    async def executions(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        limit: int = 20,
        _: UUID = Depends(authorize),
    ) -> Executions:
        """What running this file has produced, newest first."""
        async with database.session() as session:
            rows = await records.executions_of(
                session,
                backend.models,
                workspace_id,
                entry_id,
                max(1, min(limit, 200)),
            )
            return Executions(
                executions=[
                    Executed(
                        transaction=row.id,
                        snapshot=row.snapshot,
                        entry=row.entry_id,
                        at=Occurrence(
                            minted=minted_at(row.id),
                            offset=row.utc_offset,
                            accepted=row.timestamp,
                        ),
                        outputs=row.outputs,
                        ok=row.ok,
                    )
                    for row in rows
                ]
            )

    @router.get("/workspaces/{workspace_id}/snapshots/{snapshot_id}")
    async def snapshot_taken(
        workspace_id: Annotated[UUID, APIPath()],
        snapshot_id: Annotated[UUID, APIPath()],
        _: UUID = Depends(authorize),
    ) -> SnapshotTaken:
        """Which entries a snapshot named, and at which versions."""
        async with database.session() as session:
            rows = await records.entries_in(
                session, backend.models, workspace_id, snapshot_id
            )
            return SnapshotTaken(
                snapshot=snapshot_id,
                entries=[
                    SnapshotEntry(
                        entry=row.entry_id,
                        name_version=row.name_version,
                        parent_version=row.parent_version,
                        deleted_version=row.deleted_version,
                        content_version=row.content_version,
                    )
                    for row in rows
                ],
            )

    @router.get("/workspaces/{workspace_id}/drafts")
    async def stranded_drafts(
        workspace_id: Annotated[UUID, APIPath()],
        _: UUID = Depends(authorize),
    ) -> StrandedDrafts:
        """Work that is still only where it was typed.

        Uncleared drafts, which is the one question a client cannot answer for
        itself: the case worth reporting is the machine that never came back,
        and its own record of what it was holding went with it.
        """
        async with database.session() as session:
            return StrandedDrafts(
                drafts=await refusals.stranded(session, backend.models, workspace_id)
            )

    @router.post("/workspaces/{workspace_id}/drafts/cleared", status_code=204)
    async def clear_drafts(
        workspace_id: Annotated[UUID, APIPath()],
        body: Clearing,
        _: UUID = Depends(authorize),
    ) -> None:
        """These drafts' work has since reached everybody else.

        Cleared, not deleted. The row is still what that client had, and a
        snapshot may still name it.
        """
        async with database.session() as session:
            await refusals.clear(
                session, backend.models, workspace_id, body.transactions
            )
            await session.commit()

    @router.post("/workspaces/{workspace_id}/reconstruction")
    async def reconstruction(
        workspace_id: Annotated[UUID, APIPath()],
        body: ReconstructionRequest,
        _: UUID = Depends(authorize),
    ) -> ReconstructionResponse:
        """What a client was looking at, from the transactions it wrote down.

        A POST because the question is a list, and a long one -- a snapshot of
        a whole workspace names four tokens per entry. Nothing is mutated.

        The work is `reconstruct.reconstructed`, which anything inside this
        process can call directly. An assistant assembling the files a user
        could see when they asked a question wants the same answer this
        returns, and should not have to make an HTTP request to itself for it.
        """
        async with database.session() as session:
            return ReconstructionResponse(
                entries=await reconstruct.reconstructed(
                    session,
                    backend.models,
                    backend.schema.text,
                    workspace_id,
                    body.entries,
                )
            )

    @router.get(
        "/workspaces/{workspace_id}/stream",
        response_class=StreamingResponse,
        responses={
            200: {
                "model": StreamEvent,
                "content": {"text/event-stream": {}},
                "description": (
                    "One `data:` line per event, in position order, and a"
                    " `: hb` comment every heartbeat. Declared here because"
                    " this payload is what a client's confirmed map is"
                    " mutated by -- an undeclared one could not be generated."
                ),
            }
        },
    )
    async def events(workspace_id: UUID, token: str) -> StreamingResponse:
        """The token is the credential here -- EventSource cannot carry a
        header, which is why it is single-use and position-bound."""
        async with database.session() as session:
            after = await claim_token(backend, session, workspace_id, token)
        queue: asyncio.Queue[Emitted] = asyncio.Queue()

        async def subscribed() -> AsyncIterator[str]:
            _ = await backend.registry.acquire_stream(workspace_id, queue)
            try:
                async for chunk in follow(backend, workspace_id, after, queue):
                    yield chunk
            finally:
                await backend.registry.release_stream(workspace_id, queue)

        return StreamingResponse(
            subscribed(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # -- the tutor ---------------------------------------------------------------------

    @router.post("/workspaces/{workspace_id}/chat")
    async def ask(
        workspace_id: Annotated[UUID, APIPath()],
        request: Asking,
        user: UUID = Depends(authorize),
    ) -> Asked:
        """Put a question to the tutor, and say where to hear the answer.

        TWO CALLS, NOT ONE. Answering takes seconds and a request should not,
        so this records the question, starts the work and returns -- and the
        stream below attaches to work that is already under way. A client that
        never attaches changes nothing: the answer is written down when it
        finishes, because a person who asks and closes the tab has still
        asked.

        ASKING TWICE IS ANSWERED ONCE. The message id is the client's, so a
        retried request finds its own question already here. It still gets a
        token, because the reason to retry is usually that the first answer
        never arrived.
        """
        async with database.session() as session:
            said = await tutoring.prompt(
                session,
                backend.models,
                backend.schema.text,
                workspace_id,
                user,
                request,
                until=now(),
            )
            if not await tutoring.already_asked(session, backend.models, request.message):
                for row in tutoring.rows_for(
                    backend.models, workspace_id, user, request
                ):
                    session.add(row)
                await session.commit()

        async def record(text: str, failure: str | None, model: str) -> None:
            """Written in a session of its own.

            The request's is long closed by the time an answer finishes -- that
            is the whole shape of this -- so the generation opens its own.
            """
            async with database.session() as writing:
                writing.add(
                    backend.models.answered(
                        message_id=request.message,
                        workspace_id=workspace_id,
                        user_id=user,
                        text=text,
                        model=model,
                        failure=failure,
                    )
                )
                await writing.commit()

        return Asked(
            message=request.message,
            token=backend.answering.start(said, record),
        )

    @router.get(
        "/workspaces/{workspace_id}/chat/stream",
        response_class=StreamingResponse,
        responses={
            200: {
                "model": Answering,
                "content": {"text/event-stream": {}},
                "description": (
                    "One `data:` line per delta, then one saying it ended."
                    " Declared so a client can be generated against it."
                ),
            }
        },
    )
    async def hear(
        workspace_id: Annotated[UUID, APIPath()],
        token: str,
        _: UUID = Depends(authorize),
    ) -> StreamingResponse:
        """The answer, as it is written.

        The token names a generation running in this process rather than a
        durable fact, so it is not spent by being read: a page that reloaded
        mid-answer picks the same one up again. What retires it is the answer
        being old, not somebody having heard it.
        """
        generation = backend.answering.claim(token)
        if generation is None:
            raise HTTPException(404, "nothing is being answered under that token")

        async def written() -> AsyncIterator[str]:
            async for delta in generation.follow():
                yield sent(Answering(type="delta", delta=delta).model_dump(mode="json"))
            yield sent(
                Answering(
                    type="ended",
                    text=generation.text,
                    failure=generation.failure,
                ).model_dump(mode="json")
            )

        return StreamingResponse(
            written(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/workspaces/{workspace_id}/chat")
    async def conversation(
        workspace_id: Annotated[UUID, APIPath()],
        before: datetime | None = None,
        limit: int = 10,
        user: UUID = Depends(authorize),
    ) -> Transcript:
        """This person's conversation here, newest first.

        Scoped to the caller as well as the workspace: a workspace can have
        more than one person in it, and what somebody asked a tutor is theirs.
        """
        async with database.session() as session:
            return await tutoring.transcript(
                session,
                backend.models,
                workspace_id,
                user,
                before,
                max(1, min(limit, 100)),
            )

    @router.post("/workspaces/{workspace_id}/progress")
    async def progress(
        workspace_id: Annotated[UUID, APIPath()],
        request: Judging,
        _: UUID = Depends(authorize),
    ) -> Judged:
        """Whether a student has got anywhere since a few minutes ago.

        NOT A QUESTION, and not part of anybody's conversation: no transcript
        goes in and no turn comes out. It is one measurement, asked on a timer
        by the client that is watching somebody work -- which is why it does
        not stream, does not take a message id, and is not recorded. What is
        recorded is the episode, and only if the answer is no.

        Answered synchronously because the caller has nobody waiting on it.
        """
        progressing, why = await tutoring.judged(
            backend.answering.tutor,
            request.goal,
            request.before,
            request.after,
        )
        return Judged(progressing=progressing, why=why)

    # -- the study ---------------------------------------------------------------------

    #
    # Where the nudge protocol writes down what it saw. Three routes, all
    # write-only, all answering 204 whether or not there was anything to
    # write -- see `study.py` for why this is the one part of this package
    # allowed to lose a row.
    #
    # UNDER A WORKSPACE like everything else, so `authorize` answers the one
    # question it answers: may this caller reach this workspace. The student
    # is whoever that says, never whoever the body claims.

    @router.post("/workspaces/{workspace_id}/study/episodes", status_code=204)
    async def stuck_episode(
        workspace_id: Annotated[UUID, APIPath()],
        told: Detected,
        user: UUID = Depends(authorize),
    ) -> None:
        """A student was detected as stuck, and what the protocol did about it."""
        async with database.session() as session:
            await studying.detected(session, backend.models, workspace_id, user, told)

    @router.post("/workspaces/{workspace_id}/study/offers", status_code=204)
    async def stuck_offer(
        workspace_id: Annotated[UUID, APIPath()],
        told: Accepted,
        user: UUID = Depends(authorize),
    ) -> None:
        """A student took a prompt that was offered to them."""
        async with database.session() as session:
            await studying.accepted(session, backend.models, workspace_id, user, told)

    @router.post("/workspaces/{workspace_id}/study/activity", status_code=204)
    async def stuck_activity(
        workspace_id: Annotated[UUID, APIPath()],
        told: Recorded,
        user: UUID = Depends(authorize),
    ) -> None:
        """A batch of what a student did inside a post-episode window."""
        async with database.session() as session:
            await studying.recorded(session, backend.models, workspace_id, user, told)

    # -- rooms -------------------------------------------------------------------------

    #
    # One entry's shared document, kept in step with its file by the only party
    # with a lock to settle it. A client cannot: a document that has not synced
    # looks exactly like an empty one, so two arrivals both believe the room is
    # theirs to fill, and a CRDT merges two inserts rather than noticing they
    # say the same thing.
    #
    # UNDER A WORKSPACE, for the same reason the blob routes are. `authorize`
    # answers exactly one question -- may this caller reach this workspace --
    # and an entry id in a path is not that question. Being let into one
    # workspace does not make an entry in another one yours, so each of these
    # asks separately. `updates` is the route that makes this matter: it puts
    # bytes a caller supplies into a document other people are reading.

    async def held(workspace_id: UUID, entry_id: UUID) -> None:
        """That this workspace is the one this entry belongs to.

        The same two lines `resolve_content` opens with, and for the same
        reason: an entry belongs to exactly one workspace, so nobody has to be
        told which -- but it does have to be checked.
        """
        async with database.session() as session:
            entry = await session.get(backend.models.entry, entry_id)
        if entry is None or entry.workspace_id != workspace_id:
            raise HTTPException(404, "no such entry in this workspace")

    @router.post("/workspaces/{workspace_id}/rooms/{entry_id}")
    async def ensure_room(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        _: UUID = Depends(authorize),
    ) -> RoomStanding:
        """Make this entry's room exist and say what the file says.

        Idempotent, and the only way a room is ever filled. Free when there is
        nothing to do, which is the common case by a wide margin: the common
        reason to ask is that somebody just saved and every other client with
        the file open heard about it.

        A null base is not a failure. It is what a file that is not text a
        room can hold answers -- bytes written over it, or a deletion -- and
        the caller's own read is the first moment anybody could know that.
        """
        await held(workspace_id, entry_id)
        standing = await backend.keeper.ensure(str(entry_id))
        return RoomStanding(base=None if standing is None else UUID(standing))

    @router.post("/workspaces/{workspace_id}/rooms/{entry_id}/warm", status_code=202)
    async def warm_room(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        later: BackgroundTasks,
        _: UUID = Depends(authorize),
    ) -> None:
        """Fill this room now, so that opening the file later is instant.

        Creating a room, asking what it holds and filling it is three calls to
        the collaboration server and takes a second or two. Somebody opening a
        file waits for all of it, because an editor bound to a room that has
        not been filled shows an empty document and then saves that over the
        real file.

        Nobody is waiting when a file is CREATED, so that is where this
        belongs -- whether a person made it or a workspace was cloned for one.
        Answered before the work starts, because the answer is not the point.
        """
        await held(workspace_id, entry_id)
        later.add_task(backend.keeper.ensure, str(entry_id))

    @router.post("/workspaces/{workspace_id}/rooms/{entry_id}/stored", status_code=204)
    async def room_stored(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        body: RoomStored,
        _: UUID = Depends(authorize),
    ) -> None:
        """A member of this room wrote the file.

        The cheap half of the whole design: this host is told where the file
        now stands instead of every client that hears about the write asking
        the collaboration server what the room contains. One POST here, and
        everybody else's settle finds nothing to do.
        """
        await held(workspace_id, entry_id)
        await backend.keeper.stored(str(entry_id), str(body.version))

    @router.post("/workspaces/{workspace_id}/rooms/{entry_id}/updates", status_code=204)
    async def hand_over(
        workspace_id: Annotated[UUID, APIPath()],
        entry_id: Annotated[UUID, APIPath()],
        request: Request,
        _: UUID = Depends(authorize),
    ) -> Response:
        """Put a client's own document update into the room for it.

        The one thing a client cannot do for itself when it can reach this
        host and not the collaboration server. Its work is already kept as a
        draft and cannot be lost -- but nobody else would see it until that
        connection came back, which can be a long time and is not a good
        enough reason.

        FORWARDED, NOT INTERPRETED. The update carries its own identities, so
        it merges exactly once however many routes it arrives by, including
        this client's own connection when that returns.

        Sized like a blob, and for the same reason: this is the one route here
        whose body a caller chooses the length of.
        """
        await held(workspace_id, entry_id)
        size = declared_size(request)
        if size is None or size > backend.max_blob_bytes:
            return JSONResponse({"rejected": True, "reason": "too large"}, 413)
        await backend.keeper.hand_over(str(entry_id), await request.body())
        return Response(status_code=204)

    return Mounted(
        router=router,
        clone=clone_workspace,
        place=place_files,
        initialize=initialize,
        transact=transact,
        add=add_files,
        store=store,
        fetch_blob=fetch_blob,
        content=content,
        history=history,
        executions=executions,
        snapshot=snapshot_taken,
        drafts=stranded_drafts,
        clear_drafts=clear_drafts,
        reconstruction=reconstruction,
        stream=events,
        ask=ask,
        hear=hear,
        conversation=conversation,
        detected=stuck_episode,
        accepted=stuck_offer,
        activity=stuck_activity,
        ensure_room=ensure_room,
        warm_room=warm_room,
        room_stored=room_stored,
        hand_over=hand_over,
    )
