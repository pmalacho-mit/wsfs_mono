"""The tutor's tables of record, built against a host schema and against core's.

A conversation is not a transaction. Nothing here changes an entry, takes a
position, or presents a token, so none of it is in the event stream or the
delta chain -- the same reasoning that put snapshots and executions in tables
of their own, for the same reason.

What it IS is a record of what somebody asked and what they were shown, which
is worth as much as the ability to read it back later. So it is stored the way
everything else in wsfs is stored: rows, not blobs, and no fact recorded twice.

NOTHING HERE IS A MODULE-LEVEL TABLE, for the reason core's `models` gives at
length. What is different here is that a host is not the only thing these
tables have to be pointed at: an attachment names an entry and a run, so
`build_chat_models` takes core's schema as well and reads those two classes off
it. That is the whole of what this package needs to know about core's tables --
it never queries one it did not attach to.
"""

from __future__ import annotations

from abc import ABC as IsAbstractClass
from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar, final

from sqlalchemy import Index, UniqueConstraint
from sqlalchemy.sql.schema import SchemaItem
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
from ...sqlmodel_utils_suede.tablenames import (
    tablename,
)

DEFAULT_PREFIX = "wsfs_chat"


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


@final
@dataclass(frozen=True)
class ChatModels:
    """One chat schema, bound to one host's users and workspaces and to one
    core schema.

    `core` is here rather than passed alongside because every query in this
    package that reaches a core table -- a snapshot's entries, a run's output --
    reaches it through this object, which is what keeps "which tables does the
    assistant read" answerable by reading one dataclass.
    """

    core: Models

    asked: type[ChatAskedRow]
    attachment: type[ChatAttachmentRow]
    answered: type[ChatAnsweredRow]

    @property
    def tables(self) -> tuple[type[SQLModel], ...]:
        """Everything this schema owns. Core's are core's -- a host creating
        both creates both."""
        return (self.asked, self.attachment, self.answered)


def build_chat_models(
    *,
    core: Models,
    user_table: str | type[WithTableName],
    workspace_table: str | type[WithTableName],
    prefix: str = DEFAULT_PREFIX,
) -> ChatModels:
    """The chat tables, pointed at the host's users and workspaces.

    `prefix` defaults to something other than core's, because SQLModel
    registers tables by name and these sit beside core's in one process.
    Building the same prefix twice with the same arguments returns the schema
    already built; with different ones it raises, because that is a collision
    rather than a repeat.
    """
    users, workspaces = table_of(user_table), table_of(workspace_table)
    signature = (users, workspaces, prefix)
    if prefix in _BUILT:
        return _already_built(signature)
    _BUILT[prefix] = (signature, _tables(core, users, workspaces, prefix))
    return _BUILT[prefix][1]


_BUILT: dict[str, tuple[tuple[str, str, str], ChatModels]] = {}


def _already_built(signature: tuple[str, str, str]) -> ChatModels:
    built, models = _BUILT[signature[2]]
    if built != signature:
        raise ValueError(
            f"a wsfs chat schema prefixed {signature[2]!r} already points at "
            f"{built[0]}/{built[1]}, not {signature[0]}/{signature[1]}. "
            "Give the second schema its own prefix."
        )
    return models


def _tables(core: Models, users: str, workspaces: str, prefix: str) -> ChatModels:
    def named(part: str) -> type[WithTableName]:
        return tablename("custom", f"{prefix}_{part}")

    Entry, Execution = core.entry, core.execution

    class Asked(ChatAskedRow, named("asked"), table=True):
        user_id: ID = ForeignKeyField(users)
        workspace_id: ID = ForeignKeyField(workspaces)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(
                f"ix_{prefix}_asked_whose", "workspace_id", "user_id", "timestamp"
            ),
        )
        """A transcript is read one person's at a time, newest first, and that
        is the only way it is ever read."""

    class Attachment(ChatAttachmentRow, named("attachments"), table=True):
        message_id: ID = ForeignKeyField(Asked)
        entry_id: ID = ForeignKeyField(Entry)
        execution_id: ID | None = ForeignKeyField(Execution, nullable=True)

        __table_args__: ClassVar[tuple[SchemaItem, ...]] = (
            Index(f"ix_{prefix}_attachments_message", "message_id"),
        )

    class Answered(ChatAnsweredRow, named("answered"), table=True):
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

    return ChatModels(
        core=core,
        asked=Asked,
        attachment=Attachment,
        answered=Answered,
    )
