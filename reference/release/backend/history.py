"""What one file has said, newest first.

THE QUESTION THIS ANSWERS is the one a user asks when work seems to have gone:
what did this file hold before, and can I have it back. Answering it needs
three things that live apart, because they are three different facts:

  - what the workspace ACCEPTED, in the content logs;
  - what this user ASKED and was declined, in the refusal store;
  - what this user KEPT because it had reached nobody, which shares that table
    and means the opposite thing.

ONLY THIS USER'S REFUSALS AND DRAFTS. A draft is work that reached nobody --
by definition the author is the only person who has ever seen it -- so listing
somebody else's would publish typing they never shared. Accepted versions are
everyone's, because accepting one is what sharing means.

The fourth source is the client's own outbox, and it is not here: the server
has never heard of it. The client merges that half in front of this one, which
is also why a user with no network still has a history to read.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Kind, Occurrence, Refusal, Standing, Version
from .minted import minted_at
from .models import Models


def _occurred(transaction: UUID, offset: int | None, accepted: datetime | None):
    return Occurrence(
        minted=minted_at(transaction), offset=offset, accepted=accepted
    )


def _standing(reason: str) -> Standing:
    """A draft and a refusal share a table and mean opposite things.

    One is the system declining; the other is a client asking to keep work it
    could not share. Telling a user the second was "refused" would report
    their own caution as a failure.
    """
    return Standing.DRAFT if reason == Refusal.NOT_SHARED else Standing.REFUSED


async def _applied(
    session: AsyncSession,
    models: Models,
    entry_id: UUID,
    before: datetime | None,
    limit: int,
) -> list[Version]:
    """The logs are keyed by entry, not by workspace.

    Scoping them is `of_entry`'s job, done once against the entry itself --
    which is where the workspace is recorded -- rather than repeated as a
    column these tables do not have.
    """
    found: list[Version] = []
    for log in models.content:
        where = [col(log.entry_id) == entry_id]
        if before is not None:
            where.append(col(log.timestamp) < before)
        rows = (
            await session.exec(
                select(log).where(*where).order_by(desc(col(log.timestamp))).limit(limit)
            )
        ).all()
        found.extend(
            Version(
                transaction=row.id,
                at=_occurred(row.id, row.utc_offset, row.timestamp),
                standing=Standing.APPLIED,
                kind=Kind.TEXT if log is models.text_content else Kind.BINARY,
                size=_sized(row),
            )
            for row in rows
        )
    return found


async def _mine(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    entry_id: UUID,
    user_id: UUID,
    before: datetime | None,
    limit: int,
) -> list[Version]:
    found: list[Version] = []
    for kept in models.refused_content:
        where = [
            col(kept.entry_id) == entry_id,
            col(kept.workspace_id) == workspace_id,
            col(kept.user_id) == user_id,
        ]
        if before is not None:
            where.append(col(kept.timestamp) < before)
        rows = (
            await session.exec(
                select(kept)
                .where(*where)
                .order_by(desc(col(kept.timestamp)))
                .limit(limit)
            )
        ).all()
        found.extend(
            Version(
                transaction=row.transaction,
                at=_occurred(row.transaction, None, row.timestamp),
                standing=_standing(row.reason),
                kind=Kind.TEXT if kept is models.refused_text else Kind.BINARY,
                size=_sized(row),
                why=None if row.reason == Refusal.NOT_SHARED else row.reason,
            )
            for row in rows
        )
    return found


def _sized(row: Any) -> int:
    """How big the file was, which every content row records directly.

    Not measured from what the row stores: a text row holds a DELTA against
    what came before it, so its stored length is the size of an edit script
    rather than of the file. `size` is the file's, written when the row was.
    """
    return row.size


async def of_entry(
    session: AsyncSession,
    models: Models,
    workspace_id: UUID,
    entry_id: UUID,
    user_id: UUID,
    before: datetime | None,
    limit: int,
) -> tuple[list[Version], bool]:
    """This entry's versions, newest first, and whether there are more.

    ONE MORE THAN ASKED FOR is how `more` is answered: counting the whole
    history to say "yes there are others" would read every row to report one
    boolean. The extra row is dropped before answering.

    `before` rather than an offset, because rows arrive while somebody reads.
    An offset would show one version twice or skip one entirely; a timestamp
    names a place in the order that new rows cannot move.
    """
    entry = await session.get(models.entry, entry_id)
    if entry is None or entry.workspace_id != workspace_id:
        """An entry is named by an id a caller can guess, and `authorize`
        answers for the WORKSPACE. Without this, naming another workspace's
        entry would read its history through a door opened for this one."""
        return [], False

    wanted = limit + 1
    found = [
        *await _applied(session, models, entry_id, before, wanted),
        *await _mine(
            session, models, workspace_id, entry_id, user_id, before, wanted
        ),
    ]
    found.sort(key=_ordering, reverse=True)
    return found[:limit], len(found) > limit


def _ordering(version: Version) -> datetime:
    """The server's clock, which is the only one every row shares.

    A client's minted time is the more meaningful number to show, and the
    wrong one to sort by: two clients' clocks disagree, and a history that
    interleaved them would put a version before the one it was a change to.
    """
    return version.at.accepted or datetime.min
