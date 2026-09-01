"""The study's tables of record, built against a host schema and against core's.

Stuck episodes, and everything that happened around one. Like the tutor's
tables, none of this is a transaction -- nothing changes an entry, takes a
position or presents a token -- so it is out of the event stream and out of the
delta chain.

WRITTEN WITH LESS CEREMONY THAN ANYTHING ELSE IN WSFS, on purpose. A client
posts these and does not wait; a post that fails is a row that never exists.
That is the right trade for telemetry and the wrong one for a filesystem, which
is why these are not in the outbox with the writes. The ids are still
client-minted, so the retries a client DOES make cannot double-count.

EVERY ROW NAMES ITS EPISODE. The episode id is minted by the client at the
moment of detection and repeats on the offer, the cooldown, the window and
every batch of activity, which is what makes five tables one story.

NOTHING HERE IS A MODULE-LEVEL TABLE, for the reason core's `models` gives at
length. `build_study_models` takes core's schema as well as the host's, because
an episode names the entry a student was looking at.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
import enum
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, cast, final

from sqlalchemy import Index, TIMESTAMP, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql.schema import SchemaItem
from sqlalchemy.types import TypeEngine
from sqlmodel import Field, SQLModel

from ...wsfs_core_suede.backend.models import (
    Minted,
    Models,
    table_of,
)
from ...sqlmodel_utils_suede.associations import (
    ID,
    WithID,
    WithTime,
    WithTableName,
    ForeignKeyField,
)
from ...sqlmodel_utils_suede.columns import EnumField
from ...sqlmodel_utils_suede.tablenames import tablename

DEFAULT_PREFIX = "wsfs_study"


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


@final
@dataclass(frozen=True)
class StudyModels:
    """One study schema, bound to one host's users and workspaces and to one
    core schema.

    `core` is here for the same reason the assistant's `ChatModels` carries it:
    an episode names an entry, and which of core's tables this package touches
    is answerable by reading one dataclass.
    """

    core: Models

    episode: type[StuckEpisodeRow]
    offer: type[StuckOfferRow]
    cooldown: type[StuckCooldownRow]
    window: type[StuckWindowRow]
    activity: type[StuckActivityRow]

    @property
    def tables(self) -> tuple[type[SQLModel], ...]:
        """Everything this schema owns. Core's are core's -- a host creating
        both creates both."""
        return (
            self.episode,
            self.offer,
            self.cooldown,
            self.window,
            self.activity,
        )


def build_study_models(
    *,
    core: Models,
    user_table: str | type[WithTableName],
    workspace_table: str | type[WithTableName],
    prefix: str = DEFAULT_PREFIX,
) -> StudyModels:
    """The study tables, pointed at the host's users and workspaces.

    `prefix` defaults to something other than core's and other than the
    assistant's, because SQLModel registers tables by name and all three sit
    beside each other in one process. Building the same prefix twice with the
    same arguments returns the schema already built; with different ones it
    raises, because that is a collision rather than a repeat.
    """
    users, workspaces = table_of(user_table), table_of(workspace_table)
    signature = (users, workspaces, prefix)
    if prefix in _BUILT:
        return _already_built(signature)
    _BUILT[prefix] = (signature, _tables(core, users, workspaces, prefix))
    return _BUILT[prefix][1]


_BUILT: dict[str, tuple[tuple[str, str, str], StudyModels]] = {}


def _already_built(signature: tuple[str, str, str]) -> StudyModels:
    built, models = _BUILT[signature[2]]
    if built != signature:
        raise ValueError(
            f"a wsfs study schema prefixed {signature[2]!r} already points at "
            f"{built[0]}/{built[1]}, not {signature[0]}/{signature[1]}. "
            "Give the second schema its own prefix."
        )
    return models


def _tables(core: Models, users: str, workspaces: str, prefix: str) -> StudyModels:
    def named(part: str) -> type[WithTableName]:
        return tablename("custom", f"{prefix}_{part}")

    Entry = core.entry

    # -- the study ---------------------------------------------------------------------
    #
    # `ondelete=None` on every episode reference below. These rows outlive the
    # thing they describe on purpose: a student's file being deleted is itself
    # a fact a study wants, and cascading it away would quietly rewrite the
    # record of a term. Only the workspace and the user cascade, because when
    # those go there is nobody the row could be about.

    class StuckEpisode(StuckEpisodeRow, named("episodes"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)
        entry_id: ID | None = ForeignKeyField(Entry, nullable=True, ondelete=None)
        rule: StuckRule = EnumField(StuckRule, name=f"{prefix}_rule")
        outcome: StuckOutcome = EnumField(
            StuckOutcome, name=f"{prefix}_outcome"
        )

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_episodes_whose", "user_id", "at"),
        )
        """One student's episodes in order is how every measure derived from
        these begins."""

    class StuckOffer(StuckOfferRow, named("offers"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)
        entry_id: ID | None = ForeignKeyField(Entry, nullable=True, ondelete=None)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """One acceptance per episode. A prompt is shown once, so taking it
        twice is one student clicking twice, not two answers."""

    class StuckCooldown(StuckCooldownRow, named("cooldowns"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """An episode starts at most one cooldown."""

    class StuckWindow(StuckWindowRow, named("windows"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            UniqueConstraint("episode_id"),
        )
        """And at most one window -- "overlapping post-episode windows are not
        created" is the protocol's wording, and this is where it is true rather
        than merely intended."""

    class StuckActivity(StuckActivityRow, named("activity"), table=True):
        episode_id: ID = ForeignKeyField(StuckEpisode, ondelete=None)
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_activity_episode", "episode_id", "timestamp"),
        )
        """Many batches per window, read in the order they were sent."""

    return StudyModels(
        core=core,
        episode=StuckEpisode,
        offer=StuckOffer,
        cooldown=StuckCooldown,
        window=StuckWindow,
        activity=StuckActivity,
    )
