"""Two things a client records that change nothing.

A SNAPSHOT is a claim that the workspace looked like this: a set of entries,
each at the four tokens that are its identity. An EXECUTION is what came out
of running one of those files, against one of those snapshots.

WHY THEY ARE TRANSACTIONS AT ALL, rather than a side channel. Both are made by
a client that may be offline, and both are worth exactly as much as the
guarantee that they arrive -- an execution that never reached the server is
evidence of nothing. Being transactions puts them in the outbox, which is the
one machine here that promises delivery.

WHY THEY ARE NOT LOGS. Neither changes any entry, so neither belongs in the
event stream, the delta chain, or the position counter. A subscriber replaying
a workspace must not see them, and it cannot: they are in tables of their own
rather than filtered out of the ones it reads. That is also why they present
no token and cannot lose a compare-and-swap -- there is nothing to swap.

WHAT THEY CAN STILL BE REFUSED FOR is the claim itself. A snapshot naming a
version this server never issued describes a state that never existed, and an
execution against a snapshot nobody took is output with no subject. Keeping
either would be keeping a sentence with no referent.
"""

from __future__ import annotations

from uuid import UUID

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import Execute, Snapshot
from .models import Models


async def _issued(
    session: AsyncSession, models: Models, versions: set[UUID]
) -> set[UUID]:
    """Which of these this server actually minted, across every log.

    All five, not just the content one: a snapshot names what an entry was
    CALLED and where it lived as well as what it held, and a token from any of
    those is as real as one from any other.
    """
    if not versions:
        return set()
    found: set[UUID] = set()
    for log in models.logs:
        rows = (
            await session.exec(select(log.id).where(col(log.id).in_(versions)))
        ).all()
        found.update(rows)
    return found


def _named(request: Snapshot) -> set[UUID]:
    return {
        version
        for entry in request.entries
        for version in (
            entry.name_version,
            entry.parent_version,
            entry.deleted_version,
            entry.content_version,
        )
        if version is not None
    }


async def refuses_snapshot(
    session: AsyncSession, models: Models, workspace_id: UUID, request: Snapshot
) -> str | None:
    if not request.entries:
        return "a snapshot of nothing describes nothing"

    known = await _issued(session, models, _named(request))
    unknown = _named(request) - known
    if unknown:
        return (
            f"{len(unknown)} of the versions named were never issued, so this "
            "describes a state the workspace was never in"
        )

    entries = {entry.id for entry in request.entries}
    rows = (
        await session.exec(
            select(models.entry.id).where(
                col(models.entry.id).in_(entries),
                col(models.entry.workspace_id) == workspace_id,
            )
        )
    ).all()
    missing = entries - set(rows)
    return (
        None
        if not missing
        else f"{len(missing)} of the entries named are not in this workspace"
    )


async def refuses_execution(
    session: AsyncSession, models: Models, workspace_id: UUID, request: Execute
) -> str | None:
    within = (
        await session.exec(
            select(models.snapshot.entry_id).where(
                col(models.snapshot.snapshot) == request.snapshot,
                col(models.snapshot.workspace_id) == workspace_id,
            )
        )
    ).all()
    if not within:
        return "no snapshot of that name was taken in this workspace"
    if request.id not in set(within):
        return "that entry is not in that snapshot, so this ran against something else"
    return None


async def already_recorded(
    session: AsyncSession, models: Models, request: Snapshot | Execute
) -> bool:
    """Whether this transaction is already here.

    Dedup, and the same rule as everywhere else: a client whose connection
    dropped re-sends what it sent, and the second copy must be answered rather
    than recorded twice. Asked of the table this request would write, which is
    enough because these ids are never spent on anything else -- neither op
    can name an entry property, so there is no other table to collide in.
    """
    if isinstance(request, Snapshot):
        found = (
            await session.exec(
                select(models.snapshot.id)
                .where(col(models.snapshot.snapshot) == request.transaction)
                .limit(1)
            )
        ).first()
        return found is not None
    found = (
        await session.exec(
            select(models.execution.id)
            .where(col(models.execution.id) == request.transaction)
            .limit(1)
        )
    ).first()
    return found is not None


def snapshot_rows(
    models: Models, workspace_id: UUID, user_id: UUID, request: Snapshot
) -> list[object]:
    return [
        models.snapshot(
            snapshot=request.transaction,
            entry_id=entry.id,
            user_id=user_id,
            workspace_id=workspace_id,
            name_version=entry.name_version,
            parent_version=entry.parent_version,
            deleted_version=entry.deleted_version,
            content_version=entry.content_version,
        )
        for entry in request.entries
    ]


def execution_row(
    models: Models, workspace_id: UUID, user_id: UUID, request: Execute
) -> object:
    return models.execution(
        id=request.transaction,
        snapshot=request.snapshot,
        entry_id=request.id,
        user_id=user_id,
        workspace_id=workspace_id,
        outputs=request.outputs,
        ok=request.ok,
        utc_offset=request.offset,
    )


async def executions_of(
    session: AsyncSession, models: Models, workspace_id: UUID, entry_id: UUID, limit: int
) -> list[object]:
    """Newest first, which is the only order these are ever read in."""
    return list(
        (
            await session.exec(
                select(models.execution)
                .where(
                    col(models.execution.entry_id) == entry_id,
                    col(models.execution.workspace_id) == workspace_id,
                )
                .order_by(col(models.execution.timestamp).desc())
                .limit(limit)
            )
        ).all()
    )


async def entries_in(
    session: AsyncSession, models: Models, workspace_id: UUID, snapshot: UUID
) -> list[object]:
    return list(
        (
            await session.exec(
                select(models.snapshot).where(
                    col(models.snapshot.snapshot) == snapshot,
                    col(models.snapshot.workspace_id) == workspace_id,
                )
            )
        ).all()
    )
