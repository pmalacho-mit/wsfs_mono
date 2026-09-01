"""The tutor: what it is asked, what it is shown, and what it says back.

NOTHING HERE IMPORTS A MODEL LIBRARY. What a tutor is, to this package, is one
method: given what has been said, produce more text. `ITutor` is that method,
the host supplies it -- exactly as it supplies a collaboration server -- and
`llm.py` is the one that actually talks to anybody.

That seam is not ceremony. It is what lets the whole feature be driven in a
test, on a machine with no API key, against a tutor that says what the test
told it to.

WHAT A GENERATION IS. Answering is slower than a request should be, so asking
and reading the answer are two calls: the first records the question and starts
the work, the second attaches to it. In between, the work belongs to nobody --
which is the point. A person who asks and closes the tab has still asked, and
the answer is written down whether or not anyone was listening. Losing the
connection loses the live text and nothing else; the transcript has it.
"""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, AsyncIterator, Iterable, Literal, Protocol, Sequence
from uuid import UUID

from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession

from . import reconstruct
from .contract import Asking, Attached, Executed, Occurrence, Transcript, Turn, Versions
from .minted import minted_at
from .models import Models
from .text import Text

TOKEN_TTL = timedelta(minutes=10)
"""How long a token to listen may go unclaimed. Generous: a slow page load
should not cost somebody the answer they are already paying for."""

KEPT_AFTER_FINISHING = timedelta(minutes=5)
"""How long a finished generation stays attachable.

Long enough for a client that asked and was slow to attach; short enough that
a process answering all day does not hold every answer it ever gave. What is
dropped is only the live copy -- the answer itself is a row.
"""

Role = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class Said:
    """One line of the conversation as a model will be given it.

    This package's own type rather than any library's, so that nothing about
    which model is in use reaches the rest of the code.
    """

    role: Role
    text: str


class ITutor(Protocol):
    """Whatever actually answers. See `llm.py` for the one that does."""

    @property
    def model(self) -> str:
        """Which model this is, for the transcript to record."""
        ...

    def answer(self, said: Sequence[Said]) -> AsyncIterator[str]:
        """Deltas, in order, until there are no more."""
        ...


SYSTEM = """\
You are the tutor embedded in a coding workspace. The person you are helping is \
learning, and they are looking at the files you have been shown.

Be direct and brief. Answer the question that was asked, in the fewest words \
that actually answer it. Prefer showing the line that matters to restating the \
whole file back at them.

When something is wrong, say what is wrong and why, then how to fix it. When \
they are close, say what is already right before what is missing. Do not \
rewrite their work in your own style; it is theirs.

If you have been shown output from running their code, read it before \
answering -- the error is usually in it.

If you have not been shown enough to answer, say what you would need to see.\
"""


# -- what a question is shown ---------------------------------------------------------


def _fenced(name: str, body: str) -> str:
    """A file, marked so a model can tell where it starts and stops.

    Backticks counted rather than assumed: a markdown file containing a fence
    would otherwise close ours, and everything after it would read as prose.
    """
    longest = 0
    run = 0
    for character in body:
        run = run + 1 if character == "`" else 0
        longest = max(longest, run)
    fence = "`" * max(3, longest + 1)
    return f"{name}\n{fence}\n{body}\n{fence}"


def _outputs(outputs: Iterable[Any]) -> str:
    """Whatever the kernel produced, as text.

    Opaque to this server -- see `ExecutionRow.outputs` -- so it is rendered
    rather than interpreted: a dict with a `text` in it is almost always the
    interesting part, and anything else is shown as it stands.
    """
    lines: list[str] = []
    for output in outputs:
        if isinstance(output, str):
            lines.append(output)
        elif isinstance(output, dict):
            said = output.get("text") or output.get("data") or output
            lines.append(said if isinstance(said, str) else repr(said))
        else:
            lines.append(repr(output))
    return "\n".join(lines).strip()


async def _shown(
    session: AsyncSession,
    models: Models,
    text: Text,
    workspace_id: UUID,
    request: Asking,
) -> str:
    """The attached files and runs, written out for the current question only.

    ONLY THE CURRENT ONE, deliberately. A transcript ten questions long that
    carried every file it ever mentioned would spend most of its context on
    copies of files that have since changed -- and the older copy is the one
    that is wrong. What a past turn contributes is what was said.
    """
    if not request.attached:
        return ""

    wanted = [one.entry for one in request.attached]
    versions = await _versions_in(session, models, workspace_id, request, wanted)
    rebuilt = {
        held.id: held
        for held in await reconstruct.reconstructed(
            session, models, text, workspace_id, versions
        )
    }
    runs = await _runs(session, models, workspace_id, request)

    blocks: list[str] = []
    for one in request.attached:
        held = rebuilt.get(one.entry)
        name = (held.name if held else None) or str(one.entry)
        body = held.content if held else None
        if body is None:
            blocks.append(f"{name}\n(this file's contents could not be recovered)")
        elif body.type == "text":
            blocks.append(_fenced(name, body.content))
        else:
            blocks.append(f"{name}\n({body.mime}, not text)")

        for execution in one.executions:
            row = runs.get(execution)
            if row is None:
                continue
            said = _outputs(row.outputs)
            ended = "ran without error" if row.ok else "raised"
            blocks.append(
                f"Output of running {name} ({ended}):\n"
                + (_fenced("", said) if said else "(no output)")
            )

    return "\n\n".join(blocks)


async def _versions_in(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    request: Asking,
    wanted: Sequence[UUID],
) -> list[Versions]:
    """The tokens the snapshot recorded for the entries being asked about.

    A question with no snapshot has none, and is answered from its text alone.
    """
    if request.snapshot is None:
        return []
    rows = (
        await session.exec(
            select(models.snapshot).where(
                col(models.snapshot.snapshot) == request.snapshot,
                col(models.snapshot.workspace_id) == workspace_id,
                col(models.snapshot.entry_id).in_(wanted),
            )
        )
    ).all()
    return [
        Versions(
            id=row.entry_id,
            name_version=row.name_version,
            parent_version=row.parent_version,
            deleted_version=row.deleted_version,
            content_version=row.content_version,
        )
        for row in rows
    ]


async def _runs(
    session: AsyncSession, models: Models, workspace_id: UUID, request: Asking
) -> dict[UUID, Any]:
    asked = {one for attached in request.attached for one in attached.executions}
    if not asked:
        return {}
    rows = (
        await session.exec(
            select(models.execution).where(
                col(models.execution.id).in_(asked),
                col(models.execution.workspace_id) == workspace_id,
            )
        )
    ).all()
    return {row.id: row for row in rows}


# -- what was asked before ------------------------------------------------------------


async def _before(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    user_id: UUID,
    until: datetime,
) -> list[Said]:
    """The conversation up to this question, oldest first.

    WHOSE conversation: this person's, in this workspace. Both, because a
    workspace can have more than one person in it and a tutor that answered
    somebody with a colleague's half-finished question would be reading out
    private work.

    TEXT ONLY. What a past turn contributes is what was said -- see `_shown`.
    """
    asked = models.asked
    rows = (
        await session.exec(
            select(asked)
            .where(
                col(asked.workspace_id) == workspace_id,
                col(asked.user_id) == user_id,
                col(asked.timestamp) < until,
            )
            .order_by(desc(col(asked.timestamp)))
            .limit(MOST_TURNS_CARRIED)
        )
    ).all()
    answers = await _answers(session, models, [row.id for row in rows])

    said: list[Said] = []
    for row in reversed(rows):
        said.append(Said(role="user", text=row.text))
        answer = answers.get(row.id)
        if answer is not None and answer.text:
            said.append(Said(role="assistant", text=answer.text))
    return said


MOST_TURNS_CARRIED = 20
"""How far back a question can see.

A limit rather than the whole transcript, because context is paid for by the
token and a conversation has no natural end. Twenty turns is a long tutoring
session and still a small prompt, since only the current turn carries files.
"""


async def _answers(
    session: AsyncSession, models: Models, messages: Sequence[UUID]
) -> dict[UUID, Any]:
    if not messages:
        return {}
    rows = (
        await session.exec(
            select(models.answered).where(col(models.answered.message_id).in_(messages))
        )
    ).all()
    return {row.message_id: row for row in rows}


async def prompt(
    session: AsyncSession,
    models: Models,
    text: Text,
    workspace_id: UUID,
    user_id: UUID,
    request: Asking,
    until: datetime,
) -> list[Said]:
    """Everything the model is given, in the order it is given it.

    THE CALLER'S SYSTEM MESSAGE, IF IT SENT ONE, goes after this package's and
    before the conversation. After, because `SYSTEM` says what a tutor is and
    the caller's says what this particular one is teaching -- the narrower of
    two instructions is the one that should be read last. Before the turns,
    because instructions that arrive halfway through a conversation read as
    something somebody said in it.
    """
    shown = await _shown(session, models, text, workspace_id, request)
    asking = request.text if not shown else f"{request.text}\n\n{shown}"
    standing = (request.system or "").strip()
    return [
        Said(role="system", text=SYSTEM),
        *([Said(role="system", text=standing)] if standing else []),
        *await _before(session, models, workspace_id, user_id, until),
        Said(role="user", text=asking),
    ]


# -- writing it down ------------------------------------------------------------------


async def already_asked(
    session: AsyncSession, models: Models, message: UUID
) -> bool:
    """Whether this question is already here.

    The same rule as everywhere else: a client whose connection dropped
    re-sends what it sent, and the second copy is answered rather than asked
    again -- which would cost a second generation and put two of the same
    question in the transcript.
    """
    found = (
        await session.exec(
            select(models.asked.id).where(col(models.asked.id) == message).limit(1)
        )
    ).first()
    return found is not None


def rows_for(
    models: Models, workspace_id: UUID, user_id: UUID, request: Asking
) -> list[Any]:
    """The question and everything attached to it, as rows."""
    rows: list[Any] = [
        models.asked(
            id=request.message,
            workspace_id=workspace_id,
            user_id=user_id,
            snapshot=request.snapshot,
            text=request.text,
            utc_offset=request.offset,
        )
    ]
    for attached in request.attached:
        if not attached.executions:
            rows.append(
                models.attachment(
                    message_id=request.message,
                    entry_id=attached.entry,
                    execution_id=None,
                )
            )
            continue
        rows.extend(
            models.attachment(
                message_id=request.message,
                entry_id=attached.entry,
                execution_id=execution,
            )
            for execution in attached.executions
        )
    return rows


# -- reading the transcript back ------------------------------------------------------


async def transcript(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    user_id: UUID,
    before: datetime | None,
    limit: int,
) -> Transcript:
    """This person's conversation here, newest first.

    Paged the same way the file history is, and for the same reason: a panel
    shows the last few and asks for more when somebody scrolls past them. The
    cursor is a time rather than an offset, so a question arriving while
    somebody is reading does not shift the page under them.
    """
    asked = models.asked
    conditions = [
        col(asked.workspace_id) == workspace_id,
        col(asked.user_id) == user_id,
    ]
    if before is not None:
        conditions.append(col(asked.timestamp) < before)

    rows = (
        await session.exec(
            select(asked)
            .where(*conditions)
            .order_by(desc(col(asked.timestamp)), desc(col(asked.id)))
            .limit(limit + 1)
        )
    ).all()
    more = len(rows) > limit
    rows = list(rows[:limit])

    answers = await _answers(session, models, [row.id for row in rows])
    attached = await _attached(session, models, [row.id for row in rows])

    return Transcript(
        turns=[
            Turn(
                message=row.id,
                at=Occurrence(
                    minted=minted_at(row.id),
                    offset=row.utc_offset,
                    accepted=row.timestamp,
                ),
                text=row.text,
                snapshot=row.snapshot,
                attached=attached.get(row.id, []),
                answer=None if row.id not in answers else answers[row.id].text,
                failure=None if row.id not in answers else answers[row.id].failure,
                model=None if row.id not in answers else answers[row.id].model,
            )
            for row in rows
        ],
        more=more,
    )


async def _attached(
    session: AsyncSession, models: Models, messages: Sequence[UUID]
) -> dict[UUID, list[Attached]]:
    """What went with each of these questions, folded back into files.

    Stored one row per file-and-run precisely so this can be asked by index;
    read back, the rows for one file become one `Attached` with its runs in
    it, which is the shape the panel drew them in.
    """
    if not messages:
        return {}
    rows = (
        await session.exec(
            select(models.attachment).where(
                col(models.attachment.message_id).in_(messages)
            )
        )
    ).all()
    runs = await _executions(
        session,
        models,
        [row.execution_id for row in rows if row.execution_id is not None],
    )

    folded: dict[UUID, dict[UUID, Attached]] = {}
    for row in rows:
        files = folded.setdefault(row.message_id, {})
        held = files.setdefault(row.entry_id, Attached(entry=row.entry_id))
        run = runs.get(row.execution_id) if row.execution_id is not None else None
        if run is not None:
            held.executions.append(run)
    return {
        message: list(files.values()) for message, files in folded.items()
    }


async def _executions(
    session: AsyncSession, models: Models, wanted: Sequence[UUID]
) -> dict[UUID, Executed]:
    if not wanted:
        return {}
    rows = (
        await session.exec(
            select(models.execution).where(col(models.execution.id).in_(set(wanted)))
        )
    ).all()
    return {
        row.id: Executed(
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
    }


# -- the answer being written ---------------------------------------------------------


@dataclass
class Generation:
    """One answer as it is produced, and everything a listener needs.

    ACCUMULATED RATHER THAN QUEUED. A queue is consumed, so an answer that
    finished before anybody attached would be delivered to nobody -- and
    attaching late is the ordinary case, since the request that starts this
    returns before the client has opened anything. Keeping the deltas means a
    listener replays from the beginning however late it is, and a second
    listener is free.
    """

    said: list[str] = field(default_factory=list)
    done: bool = False
    failure: str | None = None
    moved: asyncio.Condition = field(default_factory=asyncio.Condition)
    finished: datetime | None = None

    async def add(self, delta: str) -> None:
        async with self.moved:
            self.said.append(delta)
            self.moved.notify_all()

    async def end(self, failure: str | None, when: datetime) -> None:
        async with self.moved:
            self.failure = failure
            self.done = True
            self.finished = when
            self.moved.notify_all()

    async def follow(self) -> AsyncIterator[str]:
        """Every delta from the first, then every one as it arrives."""
        at = 0
        while True:
            async with self.moved:
                await self.moved.wait_for(
                    lambda: len(self.said) > at or self.done
                )
                deltas = self.said[at:]
                at = len(self.said)
                ended = self.done
            for delta in deltas:
                yield delta
            if ended:
                return

    @property
    def text(self) -> str:
        return "".join(self.said)


class Tutoring:
    """Every answer being written in this process, by the token that names it.

    IN MEMORY, AND THAT IS THE POINT. A token here is not a durable fact like
    the stream's -- it names a generation running in THIS process, and one
    claimed anywhere else would name work that host is not doing. What is
    durable is the answer, which is a row, written when the generation ends
    whether or not anybody was listening.
    """

    def __init__(self, tutor: ITutor, now: Any) -> None:
        self._tutor = tutor
        self._now = now
        self._live: dict[str, Generation] = {}
        self._running: set[asyncio.Task[None]] = set()

    @property
    def model(self) -> str:
        return self._tutor.model

    @property
    def tutor(self) -> ITutor:
        """The tutor itself, for the one caller that is not a conversation."""
        return self._tutor

    def start(
        self,
        said: Sequence[Said],
        record: Any,
    ) -> str:
        """Begin answering, and answer with the token to listen on.

        `record` is handed the finished text and is what writes it down. It is
        passed in rather than done here so this class owns the generation and
        nothing else -- it has no session, and should not have one.
        """
        self._forget_the_stale()
        token = secrets.token_hex(nbytes=16)
        generation = Generation()
        self._live[token] = generation
        task = asyncio.create_task(self._write(generation, said, record))
        self._running.add(task)
        task.add_done_callback(self._running.discard)
        return token

    def claim(self, token: str) -> Generation | None:
        """The generation a token names, or nothing if it names none.

        NOT single-use, unlike the stream's. A stream token buys a position in
        a sequence and spending it twice would replay it; this one names work
        that is happening anyway, and a page that reloaded mid-answer being
        able to pick it up again is a feature rather than a hole. It stops
        working when the answer is old, not when it is read.
        """
        return self._live.get(token)

    async def _write(
        self, generation: Generation, said: Sequence[Said], record: Any
    ) -> None:
        failure: str | None = None
        try:
            async for delta in self._tutor.answer(said):
                await generation.add(delta)
        except asyncio.CancelledError:
            failure = "the answer was interrupted"
            raise
        except Exception as reason:  # noqa: BLE001 -- reported, not swallowed
            failure = str(reason) or reason.__class__.__name__
        finally:
            await generation.end(failure, self._now())
            try:
                await record(generation.text, failure, self._tutor.model)
            except Exception:  # noqa: BLE001
                """The answer is lost from the transcript and was still shown.

                Nothing better is available here: the person is reading it, and
                raising would only turn a database problem into an unhandled
                task exception nobody sees.
                """

    def _forget_the_stale(self) -> None:
        """Drop finished generations nobody is coming back for.

        Only the live copy: the answer is a row, and `KEPT_AFTER_FINISHING` is
        about how long a listener may be late, not about how long an answer
        lasts.
        """
        cutoff = self._now() - KEPT_AFTER_FINISHING
        for token, generation in list(self._live.items()):
            if generation.finished is not None and generation.finished < cutoff:
                del self._live[token]


# -- has this moved? ------------------------------------------------------------------


JUDGING = """\
You are grading progress, not code. You will be shown what a student is trying \
to do, their program a few minutes ago, and their program now.

Answer with one word on the first line -- YES if they have made meaningful \
progress toward the goal since the earlier version, NO if they have not -- and \
then one short sentence saying why.

Meaningful progress is work toward the goal: new or changed code that moves \
them along, or a fix to something that was wrong. It is NOT whitespace, \
renaming, comments, deleting and retyping the same thing, or edits that leave \
them where they were. If the two versions are the same, the answer is NO.\
"""


def _asking(goal: str, before: str, after: str) -> list[Said]:
    return [
        Said(role="system", text=JUDGING),
        Said(
            role="user",
            text=(
                f"The goal:\n{goal}\n\n"
                f"{_fenced('A few minutes ago:', before)}\n\n"
                f"{_fenced('Now:', after)}"
            ),
        ),
    ]


async def judged(tutor: ITutor, goal: str, before: str, after: str) -> tuple[bool, str]:
    """Whether the student got anywhere, and why somebody thinks so.

    NO HISTORY, and that is the whole difference between this and a question.
    A conversation is about what has been said; this is one measurement of two
    snapshots, and carrying a transcript into it would let something said an
    hour ago decide what this minute looks like.

    Collected rather than streamed: nobody is reading it, and the answer is a
    yes or a no.
    """
    said = "".join([delta async for delta in tutor.answer(_asking(goal, before, after))])
    first, _, rest = said.strip().partition("\n")
    """The first word rather than a search for "yes" anywhere: a sentence
    explaining why there is NO progress contains the word "no", and half the
    ways of saying it contain the word "yes" as well."""
    progressing = first.strip().upper().startswith("YES")
    why = (rest.strip() or first.strip())[:400]
    return progressing, why
