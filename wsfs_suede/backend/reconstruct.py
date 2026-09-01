"""What a client was looking at, rebuilt from the transactions it named.

A client snapshots by writing down tokens: for each entry, the transactions
that gave it its name, its place, its liveness and its content at that moment.
Handing those back here returns what each of them said, so the same filesystem
can be assembled somewhere else -- another machine, an assistant, a session
weeks later reading back what somebody had on screen when they asked a
question.

WHETHER A TRANSACTION WAS ACCEPTED IS NOT THE QUESTION. A client shows its own
queued work immediately, so a snapshot routinely names transactions the server
has not ruled on and sometimes ones it went on to refuse. Those still described
the screen. So every token is looked for in the applied logs and, failing that,
in the refused ones, and the answer does not say which it came from.

What the answer DOES say is when a token cannot be found at all. That is not
the same as an entry with no name: it is work that never reached this server,
sitting in an outbox or gone with the tab that held it. `unresolved` names
those, so a caller rebuilding a tree can tell a hole from a fact.

The route is a wrapper over `reconstructed`. Everything is here so that
anything else wanting a filesystem as of a snapshot -- and there will be more
of them -- calls a function rather than an endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence
from uuid import UUID

from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession

from . import refusals
from .contract import BinaryBody, Body, Reconstructed, TextBody, Versions
from .models import Models
from .text import Text

NAME, PARENT, DELETED, CONTENT = (
    "name_version",
    "parent_version",
    "deleted_version",
    "content_version",
)


@dataclass(frozen=True)
class _Found:
    """One property's rows, applied and refused, by the token naming them."""

    applied: dict[UUID, Any]
    refused: dict[UUID, Any]

    def at(self, token: UUID | None) -> Any | None:
        """Applied first.

        A token can be in both only if a client spent one id twice and the
        second attempt landed -- and what the filesystem HOLDS is the one that
        landed, so that is the one a reconstruction shows.
        """
        if token is None:
            return None
        return self.applied.get(token) or self.refused.get(token)


async def _applied(
    session: AsyncSession,
    models: Models,
    log: Any,
    workspace_id: UUID,
    tokens: set[UUID],
) -> dict[UUID, Any]:
    """Scoped by joining the entry, which is where an applied row's workspace
    lives -- a log row carries no workspace of its own because the entry it
    names cannot move between them."""
    if not tokens:
        return {}
    entry = models.entry
    rows = await session.exec(
        select(log)
        .join(entry, col(entry.id) == col(log.entry_id))
        .where(col(entry.workspace_id) == workspace_id, col(log.id).in_(tokens))
    )
    return {row.id: row for row in rows}


async def _refused(
    session: AsyncSession, refused: Any, workspace_id: UUID, tokens: set[UUID]
) -> dict[UUID, Any]:
    """Scoped by the row's own column, because a refused create left no entry
    to reach one through.

    Newest per transaction. A request re-sent after a dropped connection is
    refused again and leaves a second row; the later one is what the client
    was holding when it stopped trying.
    """
    if not tokens:
        return {}
    rows = await session.exec(
        select(refused)
        .where(
            col(refused.workspace_id) == workspace_id,
            col(refused.transaction).in_(tokens),
        )
        .order_by(col(refused.transaction), desc(col(refused.timestamp)))
    )
    found: dict[UUID, Any] = {}
    for row in rows:
        found.setdefault(row.transaction, row)
    return found


def _tokens(wanted: Iterable[Versions], field: str) -> set[UUID]:
    asked = (getattr(entry, field) for entry in wanted)
    return {token for token in asked if token is not None}


async def _content(
    session: AsyncSession,
    models: Models,
    text: Text,
    row: Any,
) -> Body:
    """A body, however the row keeping it happens to store one.

    Applied text folds the entry's delta chain up to its position; refused
    text walks its own chain of bases back to something the applied history
    can answer. Binary is a pointer either way -- the bytes are the blob
    store's, and a caller fetches them with the hash.
    """
    if isinstance(row, models.text_content):
        return TextBody(content=await text.at(session, row.entry_id, row.position))
    if isinstance(row, models.refused_text):
        return TextBody(content=await refusals.text_of(session, models, text, row))
    return BinaryBody(hash=row.hash, size=row.size, mime=row.mime)


async def reconstructed(
    session: AsyncSession,
    models: Models,
    text: Text,
    workspace_id: UUID,
    wanted: Sequence[Versions],
) -> list[Reconstructed]:
    """The filesystem those tokens describe, one answer per entry asked about.

    Rows are gathered a property at a time rather than an entry at a time, so
    a snapshot of five hundred files costs a fixed handful of queries instead
    of two thousand. Content is the exception: folding a delta chain is per
    file, and there is no batching that away.
    """
    names = _Found(
        applied=await _applied(
            session, models, models.name, workspace_id, _tokens(wanted, NAME)
        ),
        refused=await _refused(
            session, models.refused_name, workspace_id, _tokens(wanted, NAME)
        ),
    )
    parents = _Found(
        applied=await _applied(
            session, models, models.parent, workspace_id, _tokens(wanted, PARENT)
        ),
        refused=await _refused(
            session, models.refused_parent, workspace_id, _tokens(wanted, PARENT)
        ),
    )
    deletions = _Found(
        applied=await _applied(
            session, models, models.deletion, workspace_id, _tokens(wanted, DELETED)
        ),
        refused=await _refused(
            session, models.refused_deletion, workspace_id, _tokens(wanted, DELETED)
        ),
    )

    held = _tokens(wanted, CONTENT)
    contents = _Found(
        applied={
            **await _applied(
                session, models, models.text_content, workspace_id, held
            ),
            **await _applied(
                session, models, models.blob_content, workspace_id, held
            ),
        },
        refused={
            **await _refused(session, models.refused_text, workspace_id, held),
            **await _refused(session, models.refused_blob, workspace_id, held),
        },
    )

    answers: list[Reconstructed] = []
    for entry in wanted:
        name = names.at(entry.name_version)
        parent = parents.at(entry.parent_version)
        deletion = deletions.at(entry.deleted_version)
        content = contents.at(entry.content_version)

        answers.append(
            Reconstructed(
                id=entry.id,
                name=None if name is None else name.name,
                parent=None if parent is None else parent.parent_entry_id,
                deleted=None if deletion is None else deletion.deleted,
                content=(
                    None
                    if content is None
                    else await _content(session, models, text, content)
                ),
                unresolved=[
                    field
                    for field, token, found in (
                        (NAME, entry.name_version, name),
                        (PARENT, entry.parent_version, parent),
                        (DELETED, entry.deleted_version, deletion),
                        (CONTENT, entry.content_version, content),
                    )
                    if token is not None and found is None
                ],
            )
        )
    return answers
