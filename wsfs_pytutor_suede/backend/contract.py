"""The tutoring feature's wire shapes, and the only place they are declared.

TWO FEATURES, ONE FILE, and they are here together for a reason. `Judging` /
`Judged` are the question asked on a timer about whether a student is getting
anywhere; the rest is what the nudge protocol writes down about having asked.
Neither is core's, and neither is the assistant's chat -- see the README on the
two pytutor names.

Core's rule applies here as it does everywhere: the client's types are
GENERATED from this file, so the two cannot drift without the build saying so.
"""

from __future__ import annotations

import enum
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

__all__ = [
    "Accepted",
    "Became",
    "Detected",
    "Judged",
    "Judging",
    "Moment",
    "Recorded",
    "Rule",
    "Span",
]


# -- has this moved? -------------------------------------------------------------------


class Judging(BaseModel):
    """Two versions of one program, and what it was meant to do."""

    goal: str = Field(min_length=1, max_length=8_000)
    before: str = Field(default="", max_length=200_000)
    after: str = Field(default="", max_length=200_000)


class Judged(BaseModel):
    progressing: bool
    why: str = ""



# -- the study -------------------------------------------------------------------------
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
