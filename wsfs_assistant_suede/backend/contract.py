"""The tutor's wire shapes, and the only place they are declared.

Core's rule, applied to this package: a second copy of a contract does not stay
a copy. The client's types are GENERATED from this file
(`frontend/generate.py`), so the two cannot drift without the build saying so.

WHAT IS IMPORTED FROM CORE rather than restated: `Occurrence` and `Executed`.
An answer is timestamped the way every other wsfs event is, and a run attached
to a question is the same run the filesystem recorded. Restating either here
would be the drift this file exists to prevent.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from ...wsfs_core_suede.backend.contract import (
    Executed,
    Occurrence,
)

__all__ = [
    "Answering",
    "Asked",
    "Asking",
    "Attached",
    "Attaching",
    "Transcript",
    "Turn",
]


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
