"""Every transaction that was declined, kept.

The five logs record what happened. This records what was ASKED and not
granted, and it exists because the two are not the same story. A user whose
write loses a compare-and-swap has typed something real; a server that answers
"no" and keeps nothing has destroyed it. Afterwards nobody -- not the user, not
a client offering to recover it, not anyone reading the history back -- can say
what they had.

So: what a refusal records is exactly what applying it would have written. A
refused move leaves a name and a parent, a refused create leaves a name, a
parent, a deletion and its content, a refused write leaves its text. The
pairing is `Models.refused_for`, and it is driven off `service._writes` so the
two cannot drift.

Two refusals are kept apart from the rest, in their own tables. `ENTRY_UNKNOWN`
has no entry to attribute anything to, and `ID_TAKEN` is a client minting badly
rather than a user losing a race -- both are worth being able to count on their
own, and neither is content anyone will want back.

WHAT THIS MUST NOT TOUCH. These rows carry no position, which is what keeps
them out of the event stream, out of the delta chain a read folds, and out of
the dedup scan that decides whether an id is spent. Not by filtering -- by
being in tables none of those three ever look at. Recording a refusal cannot
change what was accepted: by the time anything here runs, the answer is given.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .contract import (
    BinaryBody,
    Body,
    Create,
    Delete,
    Move,
    Refusal,
    Rename,
    Reparent,
    Submitted,
    TextBody,
    Transacted,
    Write,
)
from .diff import apply_deltas, diff_to_delta
from .models import Models, RefusedRow, RefusedTextRow
from .text import Text

ELSEWHERE = {Refusal.ENTRY_UNKNOWN, Refusal.ID_TAKEN}


def _storable(name: str) -> str:
    """A name a `text` column can actually hold.

    Recording what was REFUSED means recording things that were refused for
    being malformed, and a Postgres text column rejects exactly one byte no
    matter how it is quoted: U+0000. So it is dropped here, and only here.

    Nothing recoverable is lost. This runs on a name that has already been
    declined, and the reason stored beside it says why -- a client asking what
    it sent is answered by `NAME_INVALID`, not by getting the bad bytes back.
    """
    return name.replace("\x00", "")


def _common(submission: Any, request: Transacted, reason: str) -> dict[str, Any]:
    return {
        "transaction": request.transaction,
        "entry_id": request.id,
        "workspace_id": submission.workspace,
        "user_id": submission.user,
        "op": request.op,
        "reason": reason,
        "utc_offset": request.offset,
    }


def _name_wanted(request: Submitted) -> tuple[str, UUID | None] | None:
    """The name this asked for, and the token it presented for it."""
    if isinstance(request, Create):
        return request.name, None
    if isinstance(request, (Rename, Move)):
        return request.name, request.name_version
    return None


def _parent_wanted(request: Submitted) -> tuple[UUID | None, UUID | None] | None:
    if isinstance(request, Create):
        return request.parent, None
    if isinstance(request, (Reparent, Move)):
        return request.parent, request.parent_version
    return None


def _deletion_wanted(request: Submitted) -> tuple[bool, UUID | None] | None:
    """A create asks to be alive; a delete asks to be gone."""
    if isinstance(request, Create):
        return False, None
    if isinstance(request, Delete):
        return True, request.seen.deleted_version
    return None


def _body_wanted(request: Submitted) -> tuple[Body | None, UUID | None]:
    if isinstance(request, Create):
        return request.content, None
    if isinstance(request, Write):
        return request.content, request.content_version
    return None, None


async def _accepted_position(submission: Any, presented: UUID | None) -> int | None:
    """Where in the entry's history the token this request claimed sits."""
    if presented is None:
        return None
    models: Models = submission.models
    for log in models.content:
        row = await submission.session.get(log, presented)
        if row is not None:
            return row.position
    return None


async def _refusal_named(
    submission: Any, predecessor: UUID | None, entry_id: UUID
) -> RefusedTextRow | None:
    """This client's own earlier refused write, if it named one it still has.

    Scoped to the user as well as the entry: a predecessor is a claim about
    what THIS client sent before, and one client must not be able to describe
    its text as a diff against another's.

    Newest first, because a transaction re-sent after a dropped connection is
    refused again and leaves a second row -- and the newest is the one whose
    text a client counting on this would have been holding.
    """
    if predecessor is None:
        return None
    refused = submission.models.refused_text
    found = (
        await submission.session.exec(
            select(refused)
            .where(
                col(refused.transaction) == predecessor,
                col(refused.entry_id) == entry_id,
                col(refused.user_id) == submission.user,
            )
            .order_by(desc(col(refused.timestamp)))
        )
    ).first()
    return found


async def text_of(
    session: AsyncSession, models: Models, text: Text, row: RefusedTextRow
) -> str:
    """What a refused write was trying to say.

    Walks `basis` back to something the accepted history can answer -- a
    position, or the empty text a file had before anyone wrote to it -- and
    folds forwards. The cache usually cuts this to nothing; it is a walk at
    all only for a refusal older than the newest one this client made.
    """
    chain: list[RefusedTextRow] = []
    seen: set[UUID] = set()
    walking: RefusedTextRow | None = row

    while walking is not None:
        if walking.id in seen:
            raise ValueError(f"refused write {walking.id} is its own basis")
        seen.add(walking.id)
        chain.append(walking)

        cached = await _cached(session, models, walking)
        if cached is not None:
            return apply_deltas(cached, [held.delta for held in reversed(chain[:-1])])
        walking = (
            None
            if walking.basis is None
            else await session.get(models.refused_text, walking.basis)
        )

    anchor = chain[-1]
    base = ""
    if anchor.basis is None and anchor.presented is not None:
        position = await _position_of(session, models, anchor.presented)
        if position is not None:
            base = await text.at(session, anchor.entry_id, position)
    return apply_deltas(base, [held.delta for held in reversed(chain)])


async def _position_of(
    session: AsyncSession, models: Models, presented: UUID
) -> int | None:
    for log in models.content:
        row = await session.get(log, presented)
        if row is not None:
            return row.position
    return None


async def _cached(
    session: AsyncSession, models: Models, row: RefusedTextRow
) -> str | None:
    cache = models.refused_text_cache
    held = (
        await session.exec(select(cache).where(col(cache.refusal_id) == row.id))
    ).first()
    return None if held is None else held.content


async def _remember(submission: Any, row: RefusedTextRow, content: str) -> None:
    """Re-anchor this client's refused chain for this entry at `row`.

    One row per entry per user, replaced rather than appended: the only text a
    later refusal will be diffed against is the newest one, and keeping the
    rest would be keeping a whole history of things that did not happen.
    """
    cache = submission.models.refused_text_cache
    anchored = (
        await submission.session.exec(
            select(cache).where(
                col(cache.entry_id) == row.entry_id,
                col(cache.user_id) == row.user_id,
            )
        )
    ).first()
    if anchored is None:
        submission.session.add(
            cache(
                entry_id=row.entry_id,
                user_id=row.user_id,
                refusal_id=row.id,
                content=content,
            )
        )
        return
    anchored.refusal_id = row.id
    anchored.content = content
    submission.session.add(anchored)


async def _record_content(
    submission: Any, request: Submitted, reason: str
) -> RefusedRow | None:
    """Adds the text row itself, rather than handing it back, because the
    cache has to be anchored at a row that exists. A blob has no cache and no
    delta, so it goes back the ordinary way."""
    body, presented = _body_wanted(request)
    if body is None:
        return None
    common = _common(submission, request, reason)

    if isinstance(body, BinaryBody):
        return submission.models.refused_blob(
            **common, presented=presented, hash=body.hash, size=body.size, mime=body.mime
        )

    assert isinstance(body, TextBody)
    base, basis = await _base_for(submission, request, presented)
    row = submission.models.refused_text(
        **common,
        presented=presented,
        basis=basis,
        size=len(body.content.encode()),
        mime="text/plain",
        delta=diff_to_delta(base, after=body.content),
    )
    submission.session.add(row)
    await _remember(submission, row, body.content)
    return None


async def _base_for(
    submission: Any, request: Submitted, presented: UUID | None
) -> tuple[str, UUID | None]:
    """The text this delta is taken against, and the refusal it came from.

    Three answers, in the order they are worth having:

      1. the client's own previous refusal, when it named one. A run of
         refusals diverges further from the accepted head with each one, so
         diffing against that head stores the whole divergence again every
         time; diffing against the previous refusal stores what was typed
         since. This is the only reason `predecessor` is on the wire.
      2. the accepted content the request presented -- the ordinary case, and
         the one that makes a lone refusal readable with no chain at all.
      3. nothing, which is a create, or a token the server never issued. The
         delta is then the whole text, which is exactly right: there is no
         earlier state of this file that anybody agreed to.
    """
    named = await _refusal_named(
        submission, getattr(request, "predecessor", None), request.id
    )
    if named is not None:
        return (
            await text_of(
                submission.session, submission.models, submission.text, named
            ),
            named.id,
        )

    position = await _accepted_position(submission, presented)
    if position is None:
        return "", None
    return await submission.text.at(submission.session, request.id, position), None


def _property_row(
    submission: Any, request: Submitted, reason: str, kind: type[RefusedRow]
) -> RefusedRow | None:
    models: Models = submission.models
    common = _common(submission, request, reason)

    if kind is models.refused_name:
        wanted = _name_wanted(request)
        if wanted is None:
            return None
        name, presented = wanted
        return models.refused_name(
            **common, presented=presented, name=_storable(name)
        )

    if kind is models.refused_parent:
        holder = _parent_wanted(request)
        if holder is None:
            return None
        parent, presented = holder
        return models.refused_parent(
            **common, presented=presented, parent_entry_id=parent
        )

    if kind is models.refused_deletion:
        gone = _deletion_wanted(request)
        if gone is None:
            return None
        deleted, presented = gone
        return models.refused_deletion(**common, presented=presented, deleted=deleted)

    return None


async def record(submission: Any, request: Submitted, reason: str, *logs: type) -> None:
    """Keep a declined transaction, in whatever tables applying it would have
    written -- or in one of the two set aside for the refusals that have
    nowhere to be attributed.

    `logs` is what `service._writes` says this operation touches; the refused
    tables are paired to it one for one, so nothing here decides a second time
    which properties an operation is about.
    """
    models: Models = submission.models

    if reason in ELSEWHERE:
        table = models.unknown_entry if reason == Refusal.ENTRY_UNKNOWN else models.taken_id
        submission.session.add(table(**_common(submission, request, reason)))
        # and on, deliberately. These two are kept apart so they can be
        # COUNTED apart -- a workspace collecting them is saying something is
        # wrong. That is no reason to throw away what the user had typed: a
        # write to an entry whose create was refused earlier arrives here, and
        # its text is the only copy anybody has.

    for log in logs:
        kind = models.refused_for(log)
        row = (
            await _record_content(submission, request, reason)
            if kind in models.refused_content
            else _property_row(submission, request, reason, kind)
        )
        if row is not None:
            submission.session.add(row)


async def clear(
    session: AsyncSession, models: Models, workspace_id: UUID, transactions: list[UUID]
) -> None:
    """Mark these drafts as work that has since reached everybody else.

    Cleared rather than deleted: the row is still the record of what that
    client had, and a snapshot may still name it.
    """
    if not transactions:
        return
    for kept in models.refused_content:
        rows = (
            await session.exec(
                select(kept).where(
                    col(kept.workspace_id) == workspace_id,
                    col(kept.transaction).in_(transactions),
                    col(kept.reason) == Refusal.NOT_SHARED,
                )
            )
        ).all()
        for row in rows:
            row.cleared = True
            session.add(row)


async def stranded(
    session: AsyncSession, models: Models, workspace_id: UUID
) -> list[Any]:
    """Drafts nobody has said got out, newest first.

    Only drafts. A refusal shares the table and means the opposite thing --
    the system declining rather than a user's work waiting -- and showing the
    two as one would be telling somebody their work is stuck when it was
    simply superseded.
    """
    from .contract import Stranded

    waiting: list[Any] = []
    for kept in models.refused_content:
        rows = (
            await session.exec(
                select(kept)
                .where(
                    col(kept.workspace_id) == workspace_id,
                    col(kept.reason) == Refusal.NOT_SHARED,
                    col(kept.cleared) == False,  # noqa: E712 -- SQL, not Python
                )
                .order_by(desc(col(kept.timestamp)))
            )
        ).all()
        waiting.extend(
            Stranded(
                transaction=row.transaction,
                entry=row.entry_id,
                user_id=row.user_id,
                at=row.timestamp,
            )
            for row in rows
        )
    return waiting
