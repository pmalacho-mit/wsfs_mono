"""The wire shapes, and the only place they are declared.

A second copy of a contract does not stay a copy. There was one, written as
TypeScript beside the architecture notes, and by the time anybody checked it
disagreed with this file about what a draft was. The client's types are
GENERATED from this one (`release/frontend/generate.py`), so the two cannot
drift without the build saying so.

Identity is client-minted throughout. A transaction id is chosen by the client
before it sends anything, and after the server applies it that same id is the
CAS token for the property it changed -- so a client knows, at mint time and
without a round trip, what token its own work will produce. That is what lets
an outbox chain: each queued item presents the id of the item before it.

Mint with a platform CSPRNG (`crypto.randomUUID()`), never `Math.random()`;
UUIDv7 is preferred for index locality on append-only tables. Mint once and
reuse the same id on every retry -- that is what makes a retry free.
"""

from __future__ import annotations

import enum
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal, final
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field, model_validator
from pydantic_core import to_jsonable_python

from .models import Type


class Operation(str, enum.Enum):
    CREATE = "create"
    DELETE = "delete"
    RENAME = "rename"
    REPARENT = "reparent"
    MOVE = "move"
    WRITE = "write"
    SNAPSHOT = "snapshot"
    EXECUTE = "execute"


class Kind(str, enum.Enum):
    TEXT = "text"
    BINARY = "binary"


class Event(str, enum.Enum):
    CREATE = "create"
    NAME = "name"
    PARENT = "parent"
    MOVE = "move"
    DELETE = "delete"
    WRITE = "write"


def to_nfc(name: str) -> str:
    """Unicode normalisation belongs at the door, and only here.

    A macOS client's NFD `café` and a Linux client's NFC `café` must
    not become two siblings a user cannot tell apart, and the controller is the
    only participant that sees both.
    """
    return unicodedata.normalize("NFC", name)


EntryName = Annotated[str, AfterValidator(to_nfc)]


# -- requests ---------------------------------------------------------------
#
# DEPARTURE: every request carries `op`. The contract's outbox union is not
# structurally discriminable, so the discriminator is explicit rather than
# guessed at.


FURTHEST_FROM_UTC = 24 * 60 - 1
"""Minutes. Real zones reach UTC-12:00 and UTC+14:00; this only refuses the
values that cannot be a clock at all."""

Offset = Annotated[int, Field(ge=-FURTHEST_FROM_UTC, le=FURTHEST_FROM_UTC)]
"""Minutes EAST of UTC, as `-new Date().getTimezoneOffset()` reports them:
Berlin in summer is +120, Los Angeles is -420."""


class Transacted(BaseModel):
    transaction: UUID
    """Client-minted. Becomes the primary key of the row this applies, and the
    CAS token the next mutation of that property must present.

    A v7 also says WHEN the client minted it, which is when the user acted --
    so the client-side time of every transaction is already here, and
    `minted.minted_at` reads it back out. See that module for what it is worth
    and what it is not.
    """

    id: UUID
    """The entry. Client-minted too, so a create needs no round trip."""

    offset: Offset | None = None
    """The client's offset from UTC when it minted this, in minutes.

    ON THE TRANSACTION, not on the connection, and that is the whole point. An
    outbox composed over a week offline is replayed in ONE Initialize, and the
    client that replays it may be in a different zone from the client that
    filled it -- somebody works in Los Angeles on Monday and lands in London on
    Tuesday. A per-connection offset would stamp Tuesday's zone onto Monday's
    work; a per-transaction one keeps each item's own.

    Null means the client said nothing, which is all a server can conclude: the
    id's instant is still known, so the transaction can be shown in the
    READER's zone, just not in the one it was made in.
    """


class TextBody(BaseModel):
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str


class BinaryBody(BaseModel):
    type: Literal[Kind.BINARY] = Kind.BINARY
    hash: str
    size: int
    mime: str


Body = Annotated[TextBody | BinaryBody, Field(discriminator="type")]


class Create(Transacted):
    op: Literal[Operation.CREATE] = Operation.CREATE
    type: Type
    name: EntryName
    """What the entry is created as. If a sibling already holds it, the create
    still lands under this name and the controller immediately renames it --
    so the settled name arrives as an ordinary `name` event rather than as a
    surprise inside the create."""
    parent: UUID | None = None
    content: Body | None
    """A file is born with its content; a folder is born with none.

    Required either way, so "empty file" is something a client says
    (`{"type": "text", "content": ""}`) rather than something it omits. An
    entry therefore never exists in a contentless state, which is what lets
    every write present a content token that is really there.
    """

    @model_validator(mode="after")
    def content_belongs_to_files(self) -> "Create":
        if (self.content is None) is (self.type is Type.FILE):
            raise ValueError("a file is created with content, a folder without")
        return self


class Rename(Transacted):
    op: Literal[Operation.RENAME] = Operation.RENAME
    name: EntryName
    name_version: UUID


class Reparent(Transacted):
    op: Literal[Operation.REPARENT] = Operation.REPARENT
    parent: UUID | None = None
    parent_version: UUID


class Seen(BaseModel):
    """Every token of the entry a delete was looking at.

    Delete is the destructive operation, and the question worth asking is not
    "has the deleted flag moved" -- it almost never has -- but "is this still
    the thing I was told to destroy".
    """

    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None
    """Required, and null for a folder, which holds none."""


class Delete(Transacted):
    op: Literal[Operation.DELETE] = Operation.DELETE
    seen: Seen


class Move(Transacted):
    """A rename and a reparent as one transaction.

    A filesystem `mv` changes where an entry lives and what it is called at
    once, and doing that as two transactions can half-succeed: the rename
    lands, the reparent is refused, and the entry ends up somewhere nobody
    asked for. This presents both tokens and takes both positions or neither.
    """

    op: Literal[Operation.MOVE] = Operation.MOVE
    name: EntryName
    name_version: UUID
    parent: UUID | None = None
    parent_version: UUID


class Write(Transacted):
    op: Literal[Operation.WRITE] = Operation.WRITE
    content_version: UUID
    """Never null: a file is born with content, so there is always a token to
    present. A folder has none, and a write to one is refused for being a
    folder before its token is ever considered."""

    content: Body
    """Carried exactly as a create carries it -- one spelling of content, not
    two. Nesting it also keeps this union flat, which is what lets the schema
    express `op` as a discriminator and a client generate itself from it."""

    draft: bool = False
    """Keep this, and do not make it the file's content.

    Asked by a client that knows its text has reached nobody else -- it is
    holding changes the collaboration server has not confirmed, so the others
    cannot be shown what it is about to store. Adopting it would either lose
    the text, because the next store from somebody else would not contain it,
    or have the text carried into their documents, where this client's own
    copy would arrive and say it twice.

    The token this presents is NOT consumed and nothing rebases under it, so
    the write that eventually shares the work presents the same one.
    """

    predecessor: UUID | None = None
    """This client's previous write to this entry, if it had one and it lost.

    A HINT ABOUT STORAGE, and nothing else. It cannot make a write land that
    would otherwise be refused, it is not consulted before the answer is
    given, and a value naming nothing the server holds is ignored rather than
    refused. Leaving it out costs only space.

    What it buys: a client whose writes are losing in a row drifts further
    from the accepted head with each one, so recording each refusal as a diff
    against that head stores the whole divergence again every time. Against
    the previous refusal it stores what was typed since. See `refusals`.
    """


class Seen_(BaseModel):
    """One entry as a snapshot found it: the four tokens that ARE the entry."""

    id: UUID
    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None = None


class Snapshot(Transacted):
    """A claim that the workspace looked like this.

    NOT A MUTATION. It changes nothing about any entry, so it presents no
    token, cannot conflict, and is not in the event stream. What it can be
    refused for is naming a version that was never issued -- a claim about a
    state that never existed is not worth keeping.

    `id` is inherited and unused: a snapshot is about the workspace rather
    than about one entry. It carries the transaction's own id so that dedup,
    the outbox and `utc_offset` all work exactly as they do for everything
    else.
    """

    op: Literal[Operation.SNAPSHOT] = Operation.SNAPSHOT
    entries: list[Seen_]


class Execute(Transacted):
    """One run of one file, against a snapshot, and what came out.

    Refused when the snapshot is unknown, because output whose subject cannot
    be named is not evidence of anything.
    """

    op: Literal[Operation.EXECUTE] = Operation.EXECUTE
    snapshot: UUID
    outputs: list[Any] = Field(default_factory=list)
    ok: bool = True


Submitted = Annotated[
    Create | Delete | Rename | Reparent | Move | Write | Snapshot | Execute,
    Field(discriminator="op"),
]
"""Everything a client can submit -- and everything it can queue. Creates are
no longer online-only, because the client already knows the id."""


# -- responses ---------------------------------------------------------------


class Acknowledged(BaseModel):
    rejected: Literal[False] = False

    draft: bool = False
    """Recorded, and deliberately not made the file's content.

    Set only in answer to a request that asked for it. It is not a refusal --
    nothing was declined and nothing was lost -- and it is not an ordinary
    acknowledgement either, because NO STREAM EVENT WILL EVER FOLLOW IT. A
    client holding this in its outbox must let it go on this answer, the way
    it does for a rejection.
    """


class Rejected(BaseModel):
    rejected: Literal[True] = True
    reason: str
    version: UUID | None = None
    """The property's current token, when the refusal was a lost race: what a
    client rebases onto before retrying."""


Response = Acknowledged | Rejected


@final
class Refusal:
    """The closed set of typed failures a client may have to route on."""

    PARENT_DELETED = "parent was deleted"
    ENTRY_DELETED = "entry was deleted"
    DESTINATION_DELETED = "the destination was deleted"
    NAME_TAKEN = "entry with name already exists within destination"
    ALREADY_RENAMED = "entry was already renamed"
    ALREADY_MOVED = "entry had already been moved"
    ALREADY_WRITTEN = "content was already updated"

    NOT_SHARED = "the client had not shared this"
    """Why a draft is kept rather than applied.

    A reason like the others so that one table holds everything submitted and
    not adopted, and one query answers "what did this client have". It is not
    like the others in what it means: every reason above is the system saying
    no, and this one is the client saying not yet.
    """

    # Failures the contract does not enumerate, each naming something it could
    # otherwise only answer with a lie.
    PARENT_UNKNOWN = "no such parent"
    DESTINATION_UNKNOWN = "no such destination"
    """A folder that never existed is not a folder that was deleted.

    Under server-minted ids the first was impossible, so the contract has no
    word for it. A client that mints its own can name a folder nobody ever
    created -- which is exactly what every create queued behind a REFUSED
    create does -- and answering that with "parent was deleted" would be the
    server describing a deletion that never happened.
    """

    PARENT_NOT_A_FOLDER = "that parent is not a folder"
    DESTINATION_NOT_A_FOLDER = "that destination is not a folder"
    DESTINATION_INSIDE_ENTRY = "the destination is inside the entry"
    BYTES_NEVER_STORED = "content bytes were never stored"
    ENTRY_UNKNOWN = "no such entry"
    ID_TAKEN = "that id is already in use"
    NOT_A_FILE = "content cannot be written to a folder"
    NAME_INVALID = "that name is not permitted"
    TOO_DEEP = "that destination is nested too deeply"
    FOLDER_FULL = "that folder already holds too many entries"
    CREATE_REFUSED = "the create this depends on was refused"

    PATH_OCCUPIED = "something already holds that path"
    """A placement that was told to add and found the path taken.

    Not a conflict: nothing was superseded and there is nothing to rebase
    onto. It is a caller that said "put this here" being told the workspace
    already has an answer for that path -- which is the whole difference
    between `place.placed_into(overwrite=False)` and an overwrite, and is
    reported per path so the rest of the placement still lands.

    A path already holding EXACTLY the text asked for never reaches this: it
    comes back `UNCHANGED`, so a call repeated verbatim is still silent.
    """

    UNKNOWN_VERSION = "the version presented was never issued"
    """A different CLASS of failure from the rest. A token is current (accept),
    superseded (an ordinary conflict -- rebase and retry), or was never issued
    at all, which means the client's state is unsound and its only sound move
    is to discard it and re-Initialize. Answering the third as an ordinary
    conflict sends a client into a retry loop it cannot win."""

    @staticmethod
    def modified(*, name: bool, content: bool) -> str:
        what = "content and name" if name and content else "name" if name else "content"
        return f"later versions modified the {what} of the entry"


# -- entries and events -------------------------------------------------------


class Occurrence(BaseModel):
    """When one transaction happened, in both clocks that saw it.

    Two clocks because they answer different questions and disagree for honest
    reasons. `minted` is the client's, and it is when the USER acted -- which,
    after a week offline, is the only one that means anything to them. `accepted`
    is this server's, and it is when the change entered the workspace and became
    something other clients could see. An offline session makes the gap between
    them days wide, and neither number is the other's approximation.
    """

    minted: datetime | None = None
    """UTC, read out of the transaction's UUIDv7 -- see `minted.minted_at`. Null
    when the id is not a v7, which is a client saying nothing about when it
    acted. Client-reported either way, so it is only as good as their clock."""

    offset: Offset | None = None
    """The client's minutes east of UTC as it acted, so `minted` can be shown on
    the clock they were actually looking at. Null when they did not say."""

    accepted: datetime | None
    """UTC, from this server's clock, at the moment the transaction was applied.
    The trustworthy half of the pair, and the one to reconcile against when a
    client's clock is plainly wrong.

    Nullable but NOT defaulted, and the distinction is the whole of it: the
    client's optimistic overlay needs to be able to say null, so the wire type
    has to admit it -- but nothing on this side may reach that value by
    forgetting to pass one, so there is no default to fall through to.

    Null in exactly one place, and never from the server: a client's own
    optimistic overlay, describing work it has queued and nobody has accepted
    yet. A row in the database was accepted by definition."""


class Metadata(BaseModel):
    """Pure namespace, plus the four tokens the next mutation must present.

    No content descriptor ever appears here: `content_version` names the write
    to fetch, not what it holds.
    """

    id: UUID
    type: Type
    name: str
    parent: UUID | None = None
    deleted: bool | None = None
    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None = None
    modified: Occurrence
    """When the newest of the four rows above landed -- the entry's mtime.

    Only the newest, and deliberately: every token here IS a transaction id, so
    a client that wants the client-side time of any ONE property reads it out of
    that token itself, with nothing sent. What it cannot derive is the offset
    the client held and the moment this server accepted the work, so that is
    what this carries.
    """


class Versions(BaseModel):
    """One entry, at the transactions a client was looking at.

    Every field but `id` is optional so that a caller can ask about as little
    as it knows. A client replicating a whole filesystem sends all four; one
    asking only what a file held sends `content_version` alone.
    """

    id: UUID
    name_version: UUID | None = None
    parent_version: UUID | None = None
    deleted_version: UUID | None = None
    content_version: UUID | None = None


class RoomStanding(BaseModel):
    """Where a room's text stands, as this host remembers it."""

    base: UUID | None
    """The stored write the room's text descends from, or null when nobody has
    filled it yet -- which is also the answer for a file that is not text a
    room can hold."""


class RoomStored(BaseModel):
    """A member of this room wrote the file.

    Told rather than discovered: the room already holds the text, so the only
    thing that changed is where this host believes it stands. Knowing that is
    what makes every other client's settle cost nothing.
    """

    version: UUID


class ReconstructionRequest(BaseModel):
    entries: list[Versions]


class Clearing(BaseModel):
    """Drafts whose work has since reached everybody else."""

    transactions: list[UUID]


class Standing(str, enum.Enum):
    """Where one version of a file stands.

    Three, not two, because a draft is neither of the others: not what the
    workspace holds, and not the system declining -- it is a client saying it
    could not share this yet. Telling a user their own caution was a refusal
    would report it as a failure.
    """

    APPLIED = "applied"
    DRAFT = "draft"
    REFUSED = "refused"


class Version(BaseModel):
    """One thing this file has said, and where that stands."""

    transaction: UUID
    at: Occurrence
    standing: Standing
    kind: Kind

    size: int | None = None
    """Characters for text, bytes for a blob, null when neither is known.

    A refused write is stored as a delta against what came before it, so its
    stored length is the size of an edit script rather than of the file. Null
    says so instead of reporting a number that means something else.
    """

    why: str | None = None
    """The refusal's reason, for a version the system declined. Null for a
    draft, whose reason is always the same one and is already its standing."""


class History(BaseModel):
    versions: list[Version]

    more: bool
    """Whether asking again with an earlier `before` would find any.

    Answered by fetching one more row than was asked for, so saying it costs
    a row rather than a count over the whole history.
    """


class Executed(BaseModel):
    """One recorded run, as it is read back."""

    transaction: UUID
    snapshot: UUID
    entry: UUID
    at: Occurrence
    outputs: list[Any]
    ok: bool


class Executions(BaseModel):
    executions: list[Executed]


class SnapshotEntry(BaseModel):
    entry: UUID
    name_version: UUID
    parent_version: UUID
    deleted_version: UUID
    content_version: UUID | None = None


class SnapshotTaken(BaseModel):
    snapshot: UUID
    entries: list[SnapshotEntry]


class Stranded(BaseModel):
    """A draft whose work is still only where it was typed."""

    transaction: UUID
    entry: UUID
    user_id: UUID
    at: datetime


class StrandedDrafts(BaseModel):
    """What one client had and nobody else ever got.

    The question drafts exist to answer. A machine that never comes back
    cannot report its own, which is why the flag is the server's.
    """

    drafts: list[Stranded]


class Reconstructed(BaseModel):
    """What those transactions said -- whichever way each of them went.

    Nothing here says whether a transaction was accepted. That is deliberate:
    the question this answers is what the USER WAS SEEING, and a client shows
    its own queued work before the server has ruled on it. A transaction later
    refused still described the screen at the moment it was taken.
    """

    id: UUID
    name: str | None = None
    parent: UUID | None = None
    deleted: bool | None = None
    content: Body | None = None

    unresolved: list[str] = []
    """Which of the tokens asked about this server has never seen.

    Empty is the answer a caller wants. Anything in it names work that never
    arrived -- still in some client's outbox, or lost with the tab that held
    it -- and a caller replicating a filesystem has to treat that as a hole
    rather than as an entry that had no name.
    """


class ReconstructionResponse(BaseModel):
    entries: list[Reconstructed]


class Moved(BaseModel):
    """Where an entry went, and what it is called now."""

    name: str
    parent: UUID | None = None


CARRIES_A_VALUE = {
    Event.CREATE,
    Event.NAME,
    Event.PARENT,
    Event.MOVE,
    Event.DELETE,
}


class StreamEvent(BaseModel):
    """DEPARTURE: a create's metadata rides in `value`, as every other event's
    payload does. The contract spreads it over the event, where its `type`
    ("file"/"folder") is shadowed by the event's own `type` ("create") and the
    client can no longer tell a file from a folder.

    `transaction` does the job the old `version` field did as well: it is the
    id of the transaction this event announces, which IS the new token for the
    property it changed. On an event for property P, set the value and set P's
    token to `transaction`.
    """

    type: Event
    id: UUID
    transaction: UUID
    value: Metadata | Moved | str | UUID | bool | None = None
    user: UUID | None = None
    at: Occurrence
    """When the transaction this announces happened. A create's `value` carries
    the same pair as the entry's `modified`, because at a birth they are the
    same transaction."""

    def payload(self) -> dict[str, Any]:
        wire = self.model_dump(mode="json", exclude_none=True, exclude={"value"})
        if self.type in CARRIES_A_VALUE:
            # An explicit null: a parent event's value is None at the root.
            wire["value"] = to_jsonable_python(self.value, exclude_none=True)
        return wire


# -- initialize ----------------------------------------------------------------


class Rejection(BaseModel):
    transaction: UUID
    reason: str
    version: UUID | None = None


MOST_TRANSACTIONS_PER_INITIALIZE = 10_000
"""An outbox composed offline can be long; it cannot be unbounded."""


class InitializeRequest(BaseModel):
    outbox: list[Submitted] = Field(
        default_factory=list, max_length=MOST_TRANSACTIONS_PER_INITIALIZE
    )
    """In counter order. Replay depends on it."""


class InitializeResponse(BaseModel):
    """DEPARTURE: `applied` is transaction ids. The contract echoes back the
    full requests, which the client already holds and evicts by id."""

    token: str
    entries: list[Metadata]
    applied: list[UUID]
    rejected: list[Rejection]


class TextContentResponse(BaseModel):
    type: Literal[Kind.TEXT] = Kind.TEXT
    content: str
    version: UUID
    """The content token this text was fetched at."""


# -- placement -----------------------------------------------------------------


MOST_FILES_PER_PLACEMENT = 1_000
"""How many paths one placement may name.

A generated project is tens of files and an assistant saving its work is
fewer. The cap is not a guess at what anybody needs -- it is here because this
is the one write whose size the caller chooses freely, and an uncapped
mapping is a whole workspace's worth of text in a single body.
"""


class PlacementRequest(BaseModel):
    """Paths, and the text each should hold.

    NO `prune`, and no way to ask for one. Deleting everything a body did not
    name is a thing a host may mean and a client may not, so it stays where
    the host is -- an argument to the in-process `Mounted.place`, never a
    field on the wire. See `PlaceFiles`.
    """

    files: dict[str, str] = Field(
        default_factory=dict, max_length=MOST_FILES_PER_PLACEMENT
    )
    """A `/`-separated path to the text it should hold. Folders along the way
    are created as needed and reused when they are already there."""


# -- the tutor ------------------------------------------------------------------------


class Attaching(BaseModel):
    """One file put in front of the tutor, and which of its runs came too."""

    entry: UUID
    executions: list[UUID] = Field(default_factory=list, max_length=50)
    """Named individually rather than "the last few", because what matters is
    what the person was looking at, and only they know that."""


class Asking(BaseModel):
    """A question, and everything needed to answer it in context."""

    message: UUID
    """Minted by the client, so asking twice is answered rather than asked
    twice -- the same reason every other id here is."""

    text: str = Field(min_length=1, max_length=32_000)

    snapshot: UUID | None = None
    """The workspace as it stood when this was asked.

    Nullable because a snapshot is a transaction like any other and can be
    refused, or never sent at all. See `ChatAskedRow.snapshot`.
    """

    attached: list[Attaching] = Field(default_factory=list, max_length=50)
    offset: int | None = None

    system: str | None = Field(default=None, min_length=1, max_length=32_000)
    """Standing instructions for this question, ahead of the conversation.

    OPTIONAL AND PER-QUESTION. The tutor has a system prompt of its own and
    this does not replace it -- it is said after it and before anything that
    was ever asked, which is where a caller with something extra to say about
    THIS workspace belongs: what is being taught, what not to give away, who
    the person is.

    NOT WRITTEN DOWN, deliberately. What a transcript holds is what was said
    to and by the tutor, and instructions nobody uttered are neither. A caller
    that wants the same standing instructions on the next question sends them
    again, exactly as it sends the files again -- see `_shown` in `tutor.py`
    for the same rule and the same reason: the copy carried forward is the one
    that is out of date.
    """


class Asked(BaseModel):
    """Where to listen for the answer.

    The message id comes back too, though the client minted it: a client that
    asked twice is told which question this is the answer to, rather than
    having to assume.
    """

    message: UUID
    token: str


class Attached(BaseModel):
    entry: UUID
    executions: list[Executed] = Field(default_factory=list)


class Turn(BaseModel):
    """One exchange, as the panel reads it back."""

    message: UUID
    at: Occurrence
    text: str
    snapshot: UUID | None = None
    attached: list[Attached] = Field(default_factory=list)
    answer: str | None = None
    """What the tutor said, or null if it never finished saying it."""
    failure: str | None = None
    model: str | None = None


class Transcript(BaseModel):
    turns: list[Turn]
    """Newest first, like every other paged read here."""

    more: bool
    """Whether there is anything older. See `History.more`."""


class Answering(BaseModel):
    """One line of the answer stream.

    TWO KINDS, and the second is not a courtesy. A delta is a piece; `ended`
    carries the whole text and whatever went wrong, so a client that joined
    late, missed a frame, or wants to check what it assembled has the answer
    itself rather than only the pieces of it.
    """

    type: Literal["delta", "ended"]
    delta: str = ""
    text: str = ""
    failure: str | None = None


class Judging(BaseModel):
    """Two versions of one program, and what it was meant to do."""

    goal: str = Field(min_length=1, max_length=8_000)
    before: str = Field(default="", max_length=200_000)
    after: str = Field(default="", max_length=200_000)


class Judged(BaseModel):
    progressing: bool
    why: str = ""


# -- the study ------------------------------------------------------------------------
#
# What a stuck episode was, and what happened around it. None of this is a
# transaction: nothing here changes an entry, takes a position or presents a
# token, so like snapshots, executions and the tutor it lives in tables of its
# own and outside the delta chain.
#
# AND UNLIKE ANY OF THOSE, IT IS ALLOWED TO BE LOST. The filesystem has an
# outbox because losing a write loses somebody's program; losing a telemetry
# row loses one data point in one student's term. A client posts these and
# moves on. What that buys is that the recording can never make the editor
# slower, block a keystroke, or fill a browser's storage -- and the ids being
# client-minted means a client that DOES retry is not counted twice.


class Rule(str, enum.Enum):
    """Why a student looked stuck. One of the three rules, and no others."""

    SAME_ERROR_TWICE = "the same error twice"
    IDLE = "idle"
    NO_PROGRESS = "no progress"


class Became(str, enum.Enum):
    """What the protocol did with one detection.

    FOUR VALUES, NOT TWO. `offered` and `silent` are the randomized arms and
    the ones an analysis compares; the other two are detections that were
    never eligible, because a cooldown or a post-episode window was running.
    Recording them is what makes "this student was stuck four times and heard
    about it once" different from "this student was stuck once".
    """

    OFFERED = "offered"
    SILENT = "silent"
    HELD_BACK_BY_COOLDOWN = "held back by the cooldown"
    HELD_BACK_BY_WINDOW = "held back by a post-episode window"


class Span(BaseModel):
    """A stretch of time whose end was known when it began.

    Both ends are the CLIENT's, and both are sent, because the protocol
    precalculates them: a cooldown is twenty minutes from the moment a prompt
    was shown, and the setting that says twenty could be different next term.
    Recomputing `until` here from today's configuration would describe the
    server's present rather than the student's past.
    """

    began: datetime
    ends: datetime


class Detected(BaseModel):
    """One stuck episode, and the periods it opened.

    ONE POST, UP TO THREE ROWS. The cooldown and the window are separate facts
    with separate lives -- they are read back on their own and they belong to
    different questions -- but they are not separate EVENTS: both are decided
    in the same instant as the episode, by the same coin. Sending them apart
    would mean a client that managed one request and not the next left an
    episode claiming a window that no row records.
    """

    episode: UUID
    """Minted by the client at the moment of detection, so a retry is free and
    so everything else about this episode can name it."""

    at: datetime
    """When the student was detected, by the clock they were reading."""

    offset: int | None = None
    """Their minutes east of UTC -- see `Occurrence.offset`."""

    rule: Rule
    became: Became

    detail: str = Field(default="", max_length=2_000)
    """What the rule saw, in words. Not load-bearing; readable."""

    course_event: str | None = Field(default=None, max_length=200)
    """Which sitting of which course this was, as the host names it.

    A STRING, and nullable, because this package has no idea what a course is
    -- it knows users and workspaces. The host puts its own name for the
    occasion here, and an analysis groups by it.
    """

    entry: UUID | None = None
    """The file the student was looking at when they were detected."""

    path: str | None = Field(default=None, max_length=1_000)
    """Where that file was, as they saw it. Sent alongside the id because a
    file gets renamed and a study reads back what was on screen."""

    code: str | None = Field(default=None, max_length=400_000)
    """The program at episode onset -- the snapshot the protocol asks for.

    Held here rather than named as a version, deliberately: what was on screen
    is not always what was stored, and this is evidence about the student
    rather than about the filesystem.
    """

    cooldown: Span | None = None
    """Set only when this episode showed a prompt."""

    window: Span | None = None
    """Set for both arms, which is what makes them comparable."""


class Accepted(BaseModel):
    """A student took the offer."""

    offer: UUID
    """The acceptance, minted by the client -- one per click."""

    episode: UUID
    at: datetime
    offset: int | None = None
    course_event: str | None = Field(default=None, max_length=200)
    entry: UUID | None = None


class Moment(BaseModel):
    """One thing a student did inside a post-episode window.

    DELIBERATELY OPEN. The shape belongs to whatever produced it -- an editor
    edit, a panel becoming visible, a keystroke in the chat box -- and a server
    that parsed them would have to be redeployed every time the client learned
    to notice one more thing. The same argument as `ExecutionRow.outputs`.

    Two fields are not open, because the whole point of the window is when
    things happened relative to each other: `at`, and what kind of thing it
    was.
    """

    model_config = {"extra": "allow"}

    at: datetime
    kind: str = Field(max_length=100)


class Recorded(BaseModel):
    """A batch of moments, flushed from one open window.

    A BATCH RATHER THAN AN EVENT, because a keystroke is not worth a request.
    Each moment carries its own timestamp, so when it was recorded stays a
    fact about the student even though when it arrived is a fact about the
    network.
    """

    episode: UUID
    moments: list[Moment] = Field(default_factory=list, max_length=20_000)
    """As many as one window is allowed to record in total, so a client that
    buffered through a slow network sends what it has rather than being
    refused and losing all of it."""
