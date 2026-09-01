"""Recording the nudge protocol: episodes, offers, cooldowns, windows, activity.

WRITE-ONLY, AND ALLOWED TO FAIL. Everything else this package stores is
somebody's work, and losing a byte of it loses their program -- which is why
writes go through an outbox, present tokens, and are refused rather than
guessed at. None of that applies here. These rows are a study's observations
of a term: one that never arrives is a missing data point, and paying for its
certainty with a slower editor would be a bad trade made on a student's time.

So: a client posts and moves on, and every route here answers 204 whether or
not there was anything to write. What keeps that honest is that the ids are
client-minted, so the retries a client does make are recorded once.

NOTHING HERE READS. What is written is read by whoever is analysing the term,
against the database, with the questions they have then -- and inventing an
API for questions nobody has asked yet is how you get an API nobody uses.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Accepted, Detected, Recorded
from .models import Models, StuckOutcome, StuckRule


async def detected(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    user: UUID,
    told: Detected,
) -> None:
    """One episode, and the periods it opened, in one transaction.

    ALL OF IT OR NONE OF IT. The cooldown and the window are decided in the
    same instant as the episode by the same coin; an episode row claiming a
    window that no row records would be a worse record than no row at all.
    """
    if await session.get(models.episode, told.episode) is not None:
        return  # already told, by a client that retried

    async with _kept(session):
        session.add(
            models.episode(
                id=told.episode,
                workspace_id=workspace_id,
                user_id=user,
                at=told.at,
                utc_offset=told.offset,
                rule=StuckRule(told.rule.value),
                outcome=StuckOutcome(told.became.value),
                detail=told.detail,
                course_event=told.course_event,
                entry_id=told.entry,
                path=told.path,
                code=told.code,
            )
        )
        # FLUSHED BEFORE THE ROWS THAT POINT AT IT. Nothing in this package
        # declares an ORM relationship -- every join here is written out -- so
        # the unit of work has no reason to know a cooldown must be inserted
        # after the episode it names, and it got the order wrong. Still one
        # transaction: the commit is what makes any of it visible.
        await session.flush()
        for row, span in (
            (models.cooldown, told.cooldown),
            (models.stuck_window, told.window),
        ):
            if span is None:
                continue
            session.add(
                row(
                    episode_id=told.episode,
                    workspace_id=workspace_id,
                    user_id=user,
                    course_event=told.course_event,
                    began=span.began,
                    ends=span.ends,
                )
            )


async def accepted(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    user: UUID,
    told: Accepted,
) -> None:
    """A student took the offer.

    That one was SHOWN is already known -- it is the episode whose outcome is
    `offered` -- so this row is their answer and its absence is the other one.
    """
    if await session.get(models.offer, told.offer) is not None:
        return
    async with _kept(session):
        session.add(
            models.offer(
                id=told.offer,
                episode_id=told.episode,
                workspace_id=workspace_id,
                user_id=user,
                at=told.at,
                utc_offset=told.offset,
                course_event=told.course_event,
                entry_id=told.entry,
            )
        )


async def recorded(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    user: UUID,
    told: Recorded,
) -> None:
    """One flush of what happened inside a post-episode window.

    The row's id is this server's, unlike everything else here, because a
    batch is not a thing the client names: it is whatever was in the buffer
    when the timer went. A client that re-sends one sends it again, and two
    identical batches a second apart are visibly that.
    """
    if not told.moments:
        return
    async with _kept(session):
        session.add(
            models.activity(
                episode_id=told.episode,
                workspace_id=workspace_id,
                user_id=user,
                moments=[moment.model_dump(mode="json") for moment in told.moments],
            )
        )


@asynccontextmanager
async def _kept(session: AsyncSession) -> AsyncIterator[None]:
    """Committed, or quietly not.

    The one failure worth naming is a row whose episode is not here -- a client
    whose detection post was lost, still reporting what happened after it.
    There is nothing to attach that to and nothing a student loses by it, so
    the session is rolled back and the route still answers 204. See the note at
    the top.

    Around the whole block rather than the commit alone, because a flush can
    raise the same violation a commit can.
    """
    try:
        yield
        await session.commit()
    except IntegrityError:
        await session.rollback()
