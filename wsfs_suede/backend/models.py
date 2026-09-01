"""SQLModel tables of record, built against a host schema.

An entry is pure identity. Its name, its parent, its deletion and its content
each live in their own append-only table, and each row records the workspace
position it landed at. Current state is therefore not a row anyone overwrites
-- it is the newest row per property -- so history costs nothing extra and the
log cannot drift from the truth.

Identity is minted by the client, and one identifier does three jobs: the id
of a transaction is the primary key of the row it applies, the dedup key that
makes a retry free, and the CAS token the next mutation of that property must
present. A client can therefore predict the token its own work will produce,
which is what lets it compose a whole session's work offline.

Only transactions that were applied are recorded. A refused one changed
nothing, so there is nothing to store: presenting it again re-runs the same
adjudication and produces the same reason (see `service.refusal`).

These rows are also the event stream: one applied transaction takes exactly
one position, and which table its rows are in IS which event it was. There is
nothing else to write, and so nothing that can disagree.

NOTHING HERE IS A MODULE-LEVEL TABLE. A foreign key names its target table in
the field itself, so a table pointing at somebody else's users cannot exist
until somebody says which table that is -- which is why `build_models` creates
the classes rather than a mixin decorating them. What this package owns is the
shape; the host owns identity, and hands over two table names.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
import enum
import warnings
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, cast, final

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, TIMESTAMP
from sqlalchemy.sql.schema import SchemaItem
from sqlalchemy.types import TypeEngine
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from ...wsfs_suede__sqlmodel_utils_suede.associations import (
    ID,
    WithID,
    WithTime,
    ForeignKeyField,
    WithTableName,
    get_tablename,
)
from ...wsfs_suede__sqlmodel_utils_suede.columns import EnumField
from ...wsfs_suede__sqlmodel_utils_suede.tablenames import tablename

from .diff import Delta

DEFAULT_PREFIX = "wsfs"


class Minted(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    """A row whose id whoever originated the transaction chose.

    Almost always the client, so that it can predict its own tokens; the
    controller mints one for the work it issues itself.

    Deliberately no default. An id nobody chose on purpose is one no client
    will recognise, so a call site that forgets to pass one has to fail at
    construction rather than quietly diverge.
    """

    id: ID = Field(primary_key=True, index=True, nullable=False)


UNSTAMPED = 0


class Positioned(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    position: int = Field(default=UNSTAMPED, index=True, nullable=False)
    """Where this landed in its workspace's one ordered stream.

    Stamped by the choke point and nowhere else. The default is the unstamped
    value precisely so that a row which bypassed it cannot reach the database:
    positions start at one.
    """


class Type(str, enum.Enum):
    FILE = "file"
    FOLDER = "folder"


# -- the shapes ----------------------------------------------------------------
#
# Every field is declared here, where it can be read and typed. What `build`
# adds is only what cannot be known until a host speaks up: which table an id
# refers to, and what these tables are called.


class EntryRow(Minted, IsAbstractClass):
    """One tree node's identity. Everything mutable about it is versioned."""

    workspace_id: ID
    type: Type


class ActedRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    Minted, WithTime, IsAbstractClass
):
    """One thing a client did, keyed by the id it minted for it.

    Everything a transaction carries EXCEPT its place in the stream, because
    that is the one part not every transaction has. A change to an entry takes
    a position; recording a claim about the workspace does not, and must not
    -- see `Positioned`, and `ExecutionRow` below.

    Split out so the two do not each declare `entry_id`, `user_id` and
    `utc_offset` and drift.
    """

    entry_id: ID
    user_id: ID

    utc_offset: int | None = Field(default=None, nullable=True)
    """The client's minutes east of UTC when it minted `id`, or null if it did
    not say.

    Not a timezone name. A name would survive a rule change -- Samoa crossing
    the date line, a country abolishing DST -- and would be the better thing to
    store for a time still to come. This is a past one, and for a past instant
    the offset IS the answer: it is what the clock said, whatever any database
    of rules later decides it should have said.
    """


class TransactionRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    ActedRow, Positioned, IsAbstractClass
):
    """One applied change to one property of one entry.

    Finding a client's transaction id here is the whole of dedup: the change
    it names already happened, so presenting it again is answered rather than
    applied a second time. It is also the property's current CAS token.

    TWO CLOCKS, ONE NEW COLUMN. `timestamp`, from `WithTime`, is this server's
    -- stamped as the row is applied, and the only time here anybody has a
    reason to believe. The client's is already in `id`: a UUIDv7 carries the
    millisecond it was minted, which is the moment the user acted, and
    `minted.minted_at` reads it back out. Storing that in a column beside the
    primary key would be storing the key's own contents twice, where the two
    can drift. What is genuinely NOT derivable is which clock the client was
    reading, and that is the one thing added below.
    """


class NamePayload(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    """What a change to a name says.

    Split from the log row because a REFUSED rename says exactly the same
    thing -- the name the user wanted -- and the two must not be able to
    describe it differently. The same goes for the three payloads below.
    """

    name: str = Field(nullable=False)


class ParentPayload(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    parent_entry_id: ID | None
    """Absent means the workspace root."""


class NameRow(TransactionRow, NamePayload, IsAbstractClass):
    pass


class ParentRow(TransactionRow, ParentPayload, IsAbstractClass):
    pass


class DeletionPayload(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    deleted: bool = Field(default=False, nullable=False)
    """Stated, not implied by the row's existence.

    A create appends `False` here, which is what gives a newborn entry a
    deletion token to present -- the same shape as its other three, so nothing
    special-cases "not deleted yet". The field being a flag rather than the
    row being a tombstone also means restoring an entry would be an ordinary
    append of `False`, judged like any other transaction. NOTHING IN THE
    CONTRACT DOES THAT TODAY: `delete` is the only operation that writes here
    and it only ever writes `True`. The field anticipates restore; it does not
    implement it.
    """


class DeletionRow(TransactionRow, DeletionPayload, IsAbstractClass):
    pass


class ContentPayload(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    size: int = Field(default=0, nullable=False)
    mime: str = Field(default="text/plain", nullable=False)


class TextPayload(ContentPayload, IsAbstractClass):
    delta: Delta = Field(sa_type=JSONB, nullable=False)
    """How this write's text differs from the text it was written against."""


class BlobPayload(ContentPayload, IsAbstractClass):
    hash: str = Field(index=True, nullable=False)


class ContentRow(TransactionRow, ContentPayload, IsAbstractClass):
    pass


class TextContentRow(ContentRow, TextPayload, IsAbstractClass):
    pass


class BlobContentRow(ContentRow, BlobPayload, IsAbstractClass):
    pass


class RefusedRow(WithID, WithTime, IsAbstractClass):
    """One transaction the server declined, kept whole.

    The log rows above are what HAPPENED. These are what was ASKED, and they
    exist because a refusal that leaves no trace makes the server a record of
    outcomes rather than of a session: a user's work that lost a
    compare-and-swap would be unrecoverable, and nobody could say afterwards
    what they had been looking at when they asked.

    NOT `Minted`, and not keyed by the transaction. A transaction id is spent
    once on one APPLIED change, but a client whose connection drops re-sends
    the same request, and a request refused twice was genuinely sent twice --
    so the id is an indexed column and repeats are rows. `WithID` mints the
    surrogate.

    NOT `Positioned` either, which is the point. Positions are the event
    stream and the delta chain, and nothing here is in either: a reader
    folding an entry's history, a subscriber replaying it, and dedup deciding
    whether an id is spent must all be unable to see these rows -- which they
    are, by being in different tables, rather than by remembering to filter.

    NO FOREIGN KEY on `entry_id`. A refused CREATE names an entry that was
    never created, and a constraint would make the one case most worth
    recording the one case that cannot be.
    """

    transaction: ID = Field(index=True, nullable=False)
    user_id: ID
    workspace_id: ID
    """Which workspace this was asked of.

    Carried here rather than reached through the entry, because the refusal
    that most needs recording is a CREATE -- and a create that was refused
    left no entry to reach anything through. Without this column a reader
    could not tell whose refusal it was holding, so the only safe answer would
    be to refuse to serve it, which is the whole feature gone.
    """
    entry_id: ID = Field(index=True, nullable=False)
    op: str = Field(nullable=False)
    reason: str = Field(index=True, nullable=False)

    presented: ID | None = Field(default=None, nullable=True)
    """The token this request claimed for the property this row is about.

    One token, not the whole `Seen` a delete presents: this row is about one
    property, and the token that matters to it is its own. It is also what
    makes a refused write readable again -- it names the text the delta below
    was taken against.
    """

    utc_offset: int | None = Field(default=None, nullable=True)
    """The client's minutes east of UTC, as on `TransactionRow`."""

    cleared: bool = Field(default=False, nullable=False, index=True)
    """Whether the work in this row has since reached everybody else.

    Only ever set on a DRAFT, and it is what separates two rows that are
    identical in storage and opposite in meaning. A draft was made because one
    client's text had reached nobody; it is cleared when that text has since
    gone out. Uncleared and old means the work exists here and nowhere else.

    OWNED BY THE SERVER, not by the client that made the draft. The case worth
    reporting is the one where that machine never comes back, and a flag kept
    only on the machine dies with it.
    """


class RefusedNameRow(RefusedRow, NamePayload, IsAbstractClass):
    pass


class RefusedParentRow(RefusedRow, ParentPayload, IsAbstractClass):
    pass


class RefusedDeletionRow(RefusedRow, DeletionPayload, IsAbstractClass):
    pass


class RefusedTextRow(RefusedRow, TextPayload, IsAbstractClass):
    basis: ID | None = Field(default=None, nullable=True)
    """Another refusal this delta was taken against, when there was one.

    A client whose writes are losing in a row diverges further from the
    accepted head with every one, so diffing each against that head stores the
    whole divergence again and again. Diffing against the PREVIOUS REFUSAL
    stores only what the user typed since. The client says which one that was;
    see `refusals.basis`.

    Purely how this row is stored. It has no bearing on what was accepted, and
    could not: by the time this row exists the answer has already been given.
    """


class RefusedBlobRow(RefusedRow, BlobPayload, IsAbstractClass):
    pass


class UnknownEntryRow(RefusedRow, IsAbstractClass):
    """A transaction naming an entry this workspace does not have.

    Its own table because there is no entry to attribute it to and no property
    it can be said to be about -- and because a workspace collecting these is
    saying something is wrong, which is easier to notice when they are not
    mixed in with ordinary lost races.
    """


class TakenIdRow(RefusedRow, IsAbstractClass):
    """A transaction id already spent on something else.

    Kept apart for the same reason: this is a client minting badly, not a user
    losing a race, and the two are worth counting separately.
    """


class RefusedTextCacheRow(WithID, IsAbstractClass):
    """Derived, never authoritative: one client's newest refused text.

    The anchor `basis` folds against, so the common case -- a run of refusals,
    each diffed against the one before -- costs one delta rather than a walk
    back down the chain. One row per entry per user: keyed by the client too,
    because two clients contesting one file would otherwise evict each other
    exactly when their chains are longest. Deleting the whole table only costs
    time.
    """

    entry_id: ID
    user_id: ID
    refusal_id: ID
    content: str = Field(nullable=False)


class TextCacheRow(WithID, IsAbstractClass):
    """Derived, never authoritative: one entry's text as of one write.

    Reconstruction folds deltas, which is linear in an entry's history. This
    row anchors the fold at the newest write so the common read is free and
    older ones are recovered by inverting a few deltas backwards. Deleting the
    whole table only costs time.
    """

    entry_id: ID
    content_id: ID
    content: str = Field(nullable=False)


class RoomRow(WithID, IsAbstractClass):
    """One entry's shared room, as this host knows it.

    A row EXISTING means the room has been created in liveblocks.
    (Implicit assumption is that nothing will delete the rooms from liveblocks)
    """

    entry_id: ID
    base: ID | None
    """The stored write the room's text descends from, or null when nobody has
    filled it yet. Null is what `rooms.unseeded` reads, and a room judged
    unseeded is seeded again -- so this being wrongly null doubles a file's
    contents. That is why the foreign key below refuses a delete rather than
    nulling it."""


class ClonedRow(WithID, WithTime, IsAbstractClass):
    """One entry copied out of another workspace, and where it came from.

    A clone COPIES rather than shares: the target gets its own entries, its
    own logs and its own positions, because two workspaces sharing a log
    would be one workspace with two names -- a write in either would appear
    in both, which is the opposite of what somebody cloning a workspace
    wants. What is genuinely lost by copying is the provenance, and that is
    the whole of what this table keeps.

    ONE ROW PER ENTRY, not one per clone. "Where did this file come from" is
    the question worth answering, and it is asked of a file; a row holding a
    list would make it a scan. The clone as a whole is recoverable from these
    -- same source, same target, same timestamp -- and is not itself a thing
    anything here needs to name.

    NOT `Minted`, and not in the event stream. Cloning appends ordinary
    creates through the ordinary choke point, so the target's stream already
    says everything that happened to it; this row is a note ALONGSIDE that
    work, and a subscriber folding an entry's history must not see it.
    """

    source_workspace_id: ID
    target_workspace_id: ID
    """Both named directly. A source entry can be reached through its own
    entry row, but the workspace it was read from is what a caller asks
    about -- "what came out of that workspace" is a question about the
    workspace, and a join to answer it would be a join every time."""

    source_entry_id: ID
    target_entry_id: ID
    user_id: ID
    """Whoever the clone was performed on behalf of. Every create this wrote
    into the target is attributed to them, and so is this."""

    source_content_version: ID | None = Field(default=None, index=True, nullable=True)
    """The write the copy was taken at, or null for a folder.

    WHAT THIS ROW IS FOR, beyond saying which file: a clone is a copy of a
    MOMENT, and the source keeps moving afterwards. Without this a caller can
    say the two files are related and nothing about how far apart they have
    since drifted.

    NO FOREIGN KEY, and it is the one column here without one: content lives
    in two logs -- text and blob -- and a column cannot point at whichever of
    them holds this write. The alternative is two nullable columns of which
    exactly one is ever set, which is a constraint nothing would enforce
    either.
    """


class SnapshotRow(WithID, WithTime, IsAbstractClass):
    """One entry, at the versions a snapshot found it at.

    MANY ROWS PER SNAPSHOT, one per entry, rather than one row holding a list.
    The question worth asking of these is "which snapshots named this
    version", and that is an index on a column -- inside a JSON blob it is a
    scan of every snapshot ever taken.

    THE FOUR TOKENS, not just the content one. Together they ARE the entry:
    what it is called, where it lives, whether it is gone, and what it holds.
    A snapshot that recorded only content could not say the file was called
    something else at the time, which is exactly the sort of thing somebody
    reading an old execution needs to know.

    NOT `Positioned`, and not one of the logs. Taking a snapshot changes
    nothing about any entry, so it is not in the event stream and not in the
    delta chain -- a subscriber replaying the workspace must not see these,
    and it cannot, by their being in a different table.
    """

    snapshot: ID = Field(index=True, nullable=False)
    """The transaction that took it. Repeats across this snapshot's rows."""

    entry_id: ID
    user_id: ID
    workspace_id: ID

    name_version: ID
    parent_version: ID
    deleted_version: ID
    content_version: ID | None = Field(default=None, nullable=True)
    """Null for a folder, which has no content and never had."""


class ExecutionRow(ActedRow, IsAbstractClass):
    """One run of one file, and what came out of it.

    KEYED BY THE TRANSACTION that recorded it, like every other client-minted
    thing here, so replaying an outbox cannot record the same run twice.

    `ActedRow` RATHER THAN `TransactionRow`, and the difference is exactly
    `Positioned`. A position is a place in the workspace's one ordered stream
    of CHANGES, stamped at the choke point and seeded from the highest one in
    the logs. Running a file changes nothing, so taking a position would put a
    number in that sequence that the stream never emits and the controller's
    counter never sees -- a gap at best, and a collision once the counter is
    reseeded from logs this row is not in.

    Everything else a transaction carries, it carries: its own id, who, when,
    and which clock they were reading.

    AGAINST A SNAPSHOT, which is the whole reason snapshots became a thing the
    server knows about. Output is only evidence if you can say what it was
    evidence ABOUT, and "this file at this version, in a workspace that looked
    like this" is that. Without it an execution is a paragraph of text with no
    claim attached.
    """

    snapshot: ID = Field(index=True, nullable=False)

    workspace_id: ID
    """Named directly, unlike the logs, which reach it through their entry.

    These are read per workspace -- everything this person ran here -- and a
    join to answer that would be a join every time.
    """

    outputs: list[Any] = Field(default_factory=list, sa_type=JSONB, nullable=False)
    """What the kernel produced, as it produced it.

    Opaque on purpose: the shape belongs to whatever ran the code, and a
    server that parsed it would have to be changed every time a kernel learned
    a new kind of output.
    """

    ok: bool = Field(default=True, nullable=False)
    """Whether it ended without raising.

    A column rather than something to be read out of `outputs`, because "show
    me the runs that failed" is a question worth answering with an index
    instead of a scan through JSON.
    """


# -- the tutor ------------------------------------------------------------------------
#
# A conversation is not a transaction. Nothing here changes an entry, takes a
# position, or presents a token, so none of it is in the event stream or the
# delta chain -- the same reasoning that put snapshots and executions in tables
# of their own, for the same reason.
#
# What it IS is a record of what somebody asked and what they were shown, which
# is worth as much as the ability to read it back later. So it is stored the way
# everything else here is stored: rows, not blobs, and no fact recorded twice.


class ChatAskedRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    Minted, WithTime, IsAbstractClass
):
    """One question put to the tutor.

    MINTED BY THE CLIENT, like every other id it originates. Asking is a round
    trip, a round trip can be lost, and a client that re-sends a question it
    already asked must be answered rather than asked twice -- which is exactly
    what a primary key it chose gives, at no cost.

    THE SNAPSHOT IS NULLABLE, and that is not sloppiness. A snapshot is itself a
    transaction the client sent moments earlier; it can be refused, for naming a
    version this server never issued, and a client that cannot reach the server
    at all has none to name. A tutor that answers from the question alone is
    worse than one that can see the workspace and much better than an error, so
    the column records that this question came with nothing to look at.
    """

    workspace_id: ID
    user_id: ID

    snapshot: ID | None = Field(default=None, nullable=True, index=True)
    """What the workspace looked like when this was asked, if anything did."""

    text: str = Field(nullable=False)

    utc_offset: int | None = Field(default=None, nullable=True)
    """The clock the person was reading -- see `ActedRow.utc_offset`."""


class ChatAttachmentRow(WithID, IsAbstractClass):
    """One thing that went along with a question.

    A ROW PER THING, not a list on the question. The same argument as
    `SnapshotRow`: "which questions was this file attached to" and "was this run
    ever shown to the tutor" are the questions worth asking of these, and each is
    an index on a column -- inside a JSON blob each is a scan of every question
    anybody ever asked.

    A NULL `execution_id` MEANS THE FILE WAS ATTACHED WITH NOTHING RUN. A file
    attached alongside three runs is three rows, all naming the same entry, and
    the file having been attached is true of any of them. That is why the entry
    is named here as well as being reachable through the execution: the file is
    the thing attached, and the run is the extra.
    """

    message_id: ID
    entry_id: ID
    execution_id: ID | None = Field(default=None, nullable=True, index=True)


class ChatAnsweredRow(WithID, WithTime, IsAbstractClass):
    """What the tutor said back.

    ONE PER QUESTION, and written when the generation ENDS rather than when a
    client is listening. A person who asks and closes the tab has still asked,
    and the answer they paid for is theirs when they come back.

    A FAILURE IS ALSO AN ANSWER, recorded rather than dropped: a transcript that
    silently skips the turn where the model fell over reads as though the
    question was never asked.
    """

    message_id: ID
    workspace_id: ID
    user_id: ID

    text: str = Field(default="", nullable=False)
    """What was produced -- including a partial, when something went wrong
    halfway. Half an answer is still what the person was shown."""

    model: str = Field(default="", nullable=False)
    """Which model said it, because the transcript outlives the choice."""

    failure: str | None = Field(default=None, nullable=True)
    """Null when it finished. Otherwise why it did not."""


# -- the study ------------------------------------------------------------------------
#
# Stuck episodes, and everything that happened around one. Like the tutor's
# tables, none of this is a transaction -- nothing changes an entry, takes a
# position or presents a token -- so it is out of the event stream and out of
# the delta chain.
#
# WRITTEN WITH LESS CEREMONY THAN ANYTHING ELSE HERE, on purpose. A client
# posts these and does not wait; a post that fails is a row that never exists.
# That is the right trade for telemetry and the wrong one for a filesystem,
# which is why these are not in the outbox with the writes. The ids are still
# client-minted, so the retries a client DOES make cannot double-count.
#
# EVERY ROW NAMES ITS EPISODE. The episode id is minted by the client at the
# moment of detection and repeats on the offer, the cooldown, the window and
# every batch of activity, which is what makes five tables one story.


class StuckRule(str, enum.Enum):
    SAME_ERROR_TWICE = "the same error twice"
    IDLE = "idle"
    NO_PROGRESS = "no progress"


class StuckOutcome(str, enum.Enum):
    """What the protocol did with a detection -- see `contract.Became`."""

    OFFERED = "offered"
    SILENT = "silent"
    HELD_BACK_BY_COOLDOWN = "held back by the cooldown"
    HELD_BACK_BY_WINDOW = "held back by a post-episode window"


class StuckEpisodeRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    Minted, WithTime, IsAbstractClass
):
    """One stuck episode, however it was treated.

    THE HELD-BACK ONES TOO. A detection that arrived during a cooldown is a
    fact about a student being stuck, and an analysis that only sees the
    prompts cannot tell it from a student who was never stuck at all.

    `timestamp` is this server's clock, from `WithTime`; `at` is the student's
    -- the same two-clock split every other record here makes, and it matters
    more than usual because everything downstream is measured in minutes from
    the episode.
    """

    workspace_id: ID
    user_id: ID

    at: datetime = Field(
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
        index=True,
    )
    """When the student was detected, by their clock."""

    utc_offset: int | None = Field(default=None, nullable=True)
    """Which clock that was -- see `ActedRow.utc_offset`."""

    rule: StuckRule
    outcome: StuckOutcome

    detail: str = Field(default="", nullable=False)
    """What the rule saw, in words. Readable, not load-bearing."""

    course_event: str | None = Field(default=None, nullable=True, index=True)
    """The host's name for this sitting of this course.

    A STRING, because this package knows about users and workspaces and has
    never heard of a course. Indexed because grouping by it is most of what a
    study does with these.
    """

    entry_id: ID | None = Field(default=None, nullable=True)
    """The file on screen at onset, if one was."""

    path: str | None = Field(default=None, nullable=True)
    """Where that file was, as the student saw it -- files get renamed."""

    code: str | None = Field(default=None, nullable=True)
    """The program at onset.

    Stored, not referenced. What was on screen is not always what was stored,
    and this is evidence about the student rather than about the filesystem.
    """


class StuckOfferRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    Minted, WithTime, IsAbstractClass
):
    """A prompt somebody took.

    ONLY ACCEPTANCES. That a prompt was SHOWN is already known -- it is the
    episode whose outcome is `offered` -- so a row here is the student's
    answer and its absence is the other answer.
    """

    episode_id: ID
    workspace_id: ID
    user_id: ID

    at: datetime = Field(
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
        index=True,
    )
    utc_offset: int | None = Field(default=None, nullable=True)
    course_event: str | None = Field(default=None, nullable=True, index=True)
    entry_id: ID | None = Field(default=None, nullable=True)


class SpanRow(WithID, WithTime, IsAbstractClass):
    """A stretch of time an episode opened, both ends recorded.

    `ends` IS STORED RATHER THAN COMPUTED, and that is the whole reason this
    is a row at all. A cooldown is twenty minutes because a setting says so
    today; reading these back next year and applying next year's setting would
    describe the server's present instead of the student's past.
    """

    episode_id: ID
    workspace_id: ID
    user_id: ID
    course_event: str | None = Field(default=None, nullable=True, index=True)

    began: datetime = Field(
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
        index=True,
    )
    ends: datetime = Field(
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
    )


class StuckCooldownRow(SpanRow, IsAbstractClass):
    """Started the moment a prompt was shown, accepted or not."""


class StuckWindowRow(SpanRow, IsAbstractClass):
    """Opened by every eligible episode, offered and silent alike.

    Which is what makes the two arms comparable: the same fixed stretch of
    undisturbed behaviour follows both.
    """


class StuckActivityRow(WithID, WithTime, IsAbstractClass):
    """One flush of what a student did inside a post-episode window.

    A BATCH PER ROW, not an event per row. Ten minutes of keystrokes is
    thousands of events and one question -- "what did this student do in this
    window" -- so the unit that is read is the unit that is written.

    JSONB AND OPAQUE, for the reason `ExecutionRow.outputs` gives: the shape
    belongs to the client that noticed the thing, and a server that parsed
    them would need redeploying every time the client learned to notice one
    more. Each moment carries its own timestamp, so the order inside a batch
    survives however long the batch waited to be sent.
    """

    episode_id: ID
    workspace_id: ID
    user_id: ID

    moments: list[Any] = Field(default_factory=list, sa_type=JSONB, nullable=False)


class TokenRow(  # pyright: ignore[reportUnsafeMultipleInheritance]
    SQLModel, IsAbstractClass
):
    """Single-use, position-bound credential minted by Initialize."""

    token: str = Field(primary_key=True)
    user_id: ID
    workspace_id: ID
    position: int = Field(nullable=False)
    expires: datetime = Field(
        # SQLModel annotates sa_type as `type[Any]` but hands it to Column(),
        # which takes an instance just as happily.
        sa_type=cast(type[TypeEngine[Any]], TIMESTAMP(timezone=True)),
        nullable=False,
    )


def stamped_by_the_choke_point() -> CheckConstraint:
    return CheckConstraint("position > 0", name="stamped_by_the_choke_point")


def _table_of(named: str | type[WithTableName]) -> str:
    """A host's table, however they care to name it."""
    return named if isinstance(named, str) else get_tablename(named)


@final
@dataclass(frozen=True)
class Models:
    """One wsfs schema, bound to one host's users and workspaces.

    Handed to `Workspaces.over` and carried from there: every query in this
    package reads its tables off this object rather than importing them, so
    two of these can coexist in one process against two different hosts.
    """

    entry: type[EntryRow]
    name: type[NameRow]
    parent: type[ParentRow]
    deletion: type[DeletionRow]
    text_content: type[TextContentRow]
    blob_content: type[BlobContentRow]
    text_cache: type[TextCacheRow]
    token: type[TokenRow]
    room: type[RoomRow]
    snapshot: type[SnapshotRow]
    execution: type[ExecutionRow]
    asked: type[ChatAskedRow]
    attachment: type[ChatAttachmentRow]
    answered: type[ChatAnsweredRow]
    cloned: type[ClonedRow]

    episode: type[StuckEpisodeRow]
    offer: type[StuckOfferRow]
    cooldown: type[StuckCooldownRow]
    stuck_window: type[StuckWindowRow]
    activity: type[StuckActivityRow]

    refused_name: type[RefusedNameRow]
    refused_parent: type[RefusedParentRow]
    refused_deletion: type[RefusedDeletionRow]
    refused_text: type[RefusedTextRow]
    refused_blob: type[RefusedBlobRow]
    unknown_entry: type[UnknownEntryRow]
    taken_id: type[TakenIdRow]
    refused_text_cache: type[RefusedTextCacheRow]

    @property
    def logs(self) -> tuple[type[TransactionRow], ...]:
        """The five append-only logs, which are also the event stream."""
        return (
            self.name,
            self.parent,
            self.deletion,
            self.text_content,
            self.blob_content,
        )

    @property
    def content(self) -> tuple[type[ContentRow], ...]:
        return (self.text_content, self.blob_content)

    @property
    def refused_logs(self) -> tuple[type[RefusedRow], ...]:
        """The same five properties, for transactions that were declined.

        In the same order as `logs`, and paired with it by `service._writes`:
        a refusal records the logs its operation WOULD have written, so a
        refused move leaves a name and a parent exactly as an accepted one
        would have.
        """
        return (
            self.refused_name,
            self.refused_parent,
            self.refused_deletion,
            self.refused_text,
            self.refused_blob,
        )

    def refused_for(self, log: type[TransactionRow]) -> type[RefusedRow]:
        """The refused table paired with one log.

        By POSITION in the two tuples, so a property added to one and not the
        other stops being buildable rather than silently recording nothing.
        """
        return dict(zip(self.logs, self.refused_logs, strict=True))[log]

    @property
    def refused_content(self) -> tuple[type[RefusedRow], ...]:
        return (self.refused_text, self.refused_blob)

    @property
    def tables(self) -> tuple[type[SQLModel], ...]:
        """Everything this schema owns -- for create_all, or a migration."""
        return (
            self.entry,
            *self.logs,
            *self.refused_logs,
            self.unknown_entry,
            self.taken_id,
            self.text_cache,
            self.refused_text_cache,
            self.token,
            self.room,
            self.snapshot,
            self.execution,
            self.asked,
            self.attachment,
            self.answered,
            self.cloned,
            self.episode,
            self.offer,
            self.cooldown,
            self.stuck_window,
            self.activity,
        )


def build_models(
    *,
    user_table: str | type[WithTableName],
    workspace_table: str | type[WithTableName],
    prefix: str = DEFAULT_PREFIX,
) -> Models:
    """The tables, pointed at the host's users and workspaces.

    Only two things about the host are needed, and neither is a class: the
    table a `user_id` refers to, and the table a `workspace_id` refers to.
    Nothing in this package reads a user or a workspace -- it stores their
    ids, and scopes queries by them -- so the host keeps every decision about
    what those are and who may reach them.

    `prefix` names the tables and the entry-type enum. Two wsfs schemas in one
    process need two prefixes, because SQLModel registers tables by name.
    Building the same prefix twice with the same arguments returns the schema
    already built; with different ones it raises, because that is a collision
    rather than a repeat.
    """
    users, workspaces = _table_of(user_table), _table_of(workspace_table)
    signature = (users, workspaces, prefix)
    if prefix in _BUILT:
        return _already_built(signature)
    _BUILT[prefix] = (signature, _build(users, workspaces, prefix))
    return _BUILT[prefix][1]


_BUILT: dict[str, tuple[tuple[str, str, str], Models]] = {}


def _already_built(signature: tuple[str, str, str]) -> Models:
    built, models = _BUILT[signature[2]]
    if built != signature:
        raise ValueError(
            f"a wsfs schema prefixed {signature[2]!r} already points at "
            f"{built[0]}/{built[1]}, not {signature[0]}/{signature[1]}. "
            "Give the second schema its own prefix."
        )
    return models


def _build(users: str, workspaces: str, prefix: str) -> Models:
    with warnings.catch_warnings():
        # A second schema re-registers these class NAMES in SQLAlchemy's
        # declarative registry, which matters only for resolving a
        # `relationship("Entry")` by string. This package declares no
        # relationships at all -- every join here is written out.
        warnings.filterwarnings("ignore", message=".*already contains a class.*")
        return _tables(users, workspaces, prefix)


def _tables(users: str, workspaces: str, prefix: str) -> Models:
    def named(part: str) -> type[WithTableName]:
        return tablename("custom", f"{prefix}_{part}")

    def logged(part: str) -> tuple[SchemaItem, ...]:
        """Only a create writes more than one log at a position, which is what
        makes "these rows are one transaction" a fact rather than a
        convention."""
        return (
            stamped_by_the_choke_point(),
            Index(f"ix_{prefix}_{part}_entry_position", "entry_id", "position"),
        )

    class Entry(EntryRow, named("entries"), table=True):
        workspace_id: ID = ForeignKeyField(workspaces)
        type: Type = EnumField(Type, name=f"{prefix}_entry_type")

    class Transaction(TransactionRow, IsAbstractClass):
        """The two ids every log row carries. Declared here, ahead of each
        log's own shape in the MRO, because these are the ones that had to
        wait for a host to say where they point."""

        entry_id: ID = ForeignKeyField(Entry)
        user_id: ID = ForeignKeyField(users)

    class Name(Transaction, NameRow, named("names"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("names")

    class Parent(Transaction, ParentRow, named("parentage"), table=True):
        parent_entry_id: ID | None = ForeignKeyField(Entry, nullable=True)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("parentage")

    class Deletion(Transaction, DeletionRow, named("deletions"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("deletions")

    class TextContent(Transaction, TextContentRow, named("text_content"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("text_content")

    class BlobContent(Transaction, BlobContentRow, named("blob_content"), table=True):
        __table_args__: ClassVar[tuple[SchemaItem, ...]] = logged("blob_content")

    class Refused(RefusedRow, IsAbstractClass):
        """The one id here that had to wait for a host to say where it points.

        `entry_id` deliberately does not join it -- see `RefusedRow`.
        """

        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

    class RefusedName(Refused, RefusedNameRow, named("refused_names"), table=True):
        pass

    class RefusedParent(
        Refused, RefusedParentRow, named("refused_parentage"), table=True
    ):
        pass

    class RefusedDeletion(
        Refused, RefusedDeletionRow, named("refused_deletions"), table=True
    ):
        pass

    class RefusedText(
        Refused, RefusedTextRow, named("refused_text_content"), table=True
    ):
        pass

    class RefusedBlob(
        Refused, RefusedBlobRow, named("refused_blob_content"), table=True
    ):
        pass

    class UnknownEntry(Refused, UnknownEntryRow, named("unknown_entries"), table=True):
        pass

    class TakenId(Refused, TakenIdRow, named("taken_ids"), table=True):
        pass

    class RefusedTextCache(
        RefusedTextCacheRow, named("refused_text_cache"), table=True
    ):
        user_id: ID = ForeignKeyField(users)
        refusal_id: ID = ForeignKeyField(RefusedText)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("entry_id", "user_id"),
        )

    class TextContentCache(TextCacheRow, named("text_cache"), table=True):
        entry_id: ID = ForeignKeyField(Entry)
        content_id: ID = ForeignKeyField(TextContent)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("entry_id"),
        )

    class StreamToken(TokenRow, named("stream_tokens"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

    class Snapshot(SnapshotRow, named("snapshots"), table=True):
        entry_id: ID = ForeignKeyField(Entry)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("snapshot", "entry_id"),
        )
        """One row per entry per snapshot. Naming an entry twice in one
        snapshot would be claiming it was at two versions at once."""

    class Execution(ExecutionRow, named("executions"), table=True):
        entry_id: ID = ForeignKeyField(Entry)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_executions_entry_time", "entry_id", "timestamp"),
        )
        """Newest-first for one file is the only way these are ever read."""

    class Asked(ChatAskedRow, named("chat_asked"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(
                f"ix_{prefix}_chat_asked_whose", "workspace_id", "user_id", "timestamp"
            ),
        )
        """A transcript is read one person's at a time, newest first, and that
        is the only way it is ever read."""

    class Attachment(ChatAttachmentRow, named("chat_attachments"), table=True):
        message_id: ID = ForeignKeyField(Asked)
        entry_id: ID = ForeignKeyField(Entry)
        execution_id: ID | None = ForeignKeyField(Execution, nullable=True)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_chat_attachments_message", "message_id"),
        )

    class Answered(ChatAnsweredRow, named("chat_answered"), table=True):
        message_id: ID = ForeignKeyField(Asked)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("message_id"),
        )
        """One answer per question. A second would not be a longer transcript,
        it would be two claims about what the tutor said."""

    # -- the study ---------------------------------------------------------------------
    #
    # `ondelete=None` on every episode reference below. These rows outlive the
    # thing they describe on purpose: a student's file being deleted is itself
    # a fact a study wants, and cascading it away would quietly rewrite the
    # record of a term. Only the workspace and the user cascade, because when
    # those go there is nobody the row could be about.

    class StuckEpisode(StuckEpisodeRow, named("stuck_episodes"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)
        entry_id: ID | None = ForeignKeyField(Entry, nullable=True, ondelete=None)
        rule: StuckRule = EnumField(StuckRule, name=f"{prefix}_stuck_rule")
        outcome: StuckOutcome = EnumField(
            StuckOutcome, name=f"{prefix}_stuck_outcome"
        )

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_stuck_episodes_whose", "user_id", "at"),
        )
        """One student's episodes in order is how every measure derived from
        these begins."""

    class StuckOffer(StuckOfferRow, named("stuck_offers"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)
        entry_id: ID | None = ForeignKeyField(Entry, nullable=True, ondelete=None)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """One acceptance per episode. A prompt is shown once, so taking it
        twice is one student clicking twice, not two answers."""

    class StuckCooldown(StuckCooldownRow, named("stuck_cooldowns"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """An episode starts at most one cooldown."""

    class StuckWindow(StuckWindowRow, named("stuck_windows"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """And at most one window -- "overlapping post-episode windows are not
        created" is the protocol's wording, and this is where it is true rather
        than merely intended."""

    class StuckActivity(StuckActivityRow, named("stuck_activity"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_stuck_activity_episode", "episode_id", "timestamp"),
        )
        """Many batches per window, read in the order they were sent."""

    class Room(RoomRow, named("rooms"), table=True):
        entry_id: ID = ForeignKeyField(Entry)
        base: ID | None = ForeignKeyField(TextContent, nullable=True, ondelete=None)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("entry_id"),
        )

    class Cloned(ClonedRow, named("cloned_entries"), table=True):
        source_workspace_id: ID = ForeignKeyField(workspaces)
        target_workspace_id: ID = ForeignKeyField(workspaces)
        source_entry_id: ID = ForeignKeyField(Entry)
        target_entry_id: ID = ForeignKeyField(Entry)
        user_id: ID = ForeignKeyField(users)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("target_entry_id"),
            Index(
                f"ix_{prefix}_cloned_from",
                "source_workspace_id",
                "target_workspace_id",
            ),
        )
        """An entry is cloned FROM many things and INTO exactly one, so the
        target side is unique and the source side is merely indexed. The pair
        index is what makes "everything that came out of that clone" a seek."""

    return Models(
        entry=Entry,
        name=Name,
        parent=Parent,
        deletion=Deletion,
        text_content=TextContent,
        blob_content=BlobContent,
        text_cache=TextContentCache,
        token=StreamToken,
        room=Room,
        snapshot=Snapshot,
        execution=Execution,
        asked=Asked,
        attachment=Attachment,
        answered=Answered,
        cloned=Cloned,
        episode=StuckEpisode,
        offer=StuckOffer,
        cooldown=StuckCooldown,
        stuck_window=StuckWindow,
        activity=StuckActivity,
        refused_name=RefusedName,
        refused_parent=RefusedParent,
        refused_deletion=RefusedDeletion,
        refused_text=RefusedText,
        refused_blob=RefusedBlob,
        unknown_entry=UnknownEntry,
        taken_id=TakenId,
        refused_text_cache=RefusedTextCache,
    )
