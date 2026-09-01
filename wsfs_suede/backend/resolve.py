# pyright: reportUnusedFunction=false
"""The router a host mounts, and the units of work behind it.

Every WRITE -- transactional requests and Initialize alike -- flows through the
workspace's controller: serialized per workspace, fanned out after commit.
READS (Content, blobs) bypass it; MVCC handles them.

Nothing here decides anything that belongs to the host. It is handed a schema
(`build_models`), a database, a blob store, and a dependency that says which
user may reach a workspace -- and it makes no other assumption about either.

TOPOLOGY INVARIANT: exactly one process serves a workspace's writes and
streams, and nothing enforces it (ARCHITECTURE.md invariant 11).
"""

from __future__ import annotations


from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import col, desc, select
from sqlmodel.ext.asyncio.session import AsyncSession


from .models import BlobContentRow, Models, TextContentRow
from .service import Workspaces


async def resolve_content(
    workspace_schema: Workspaces,
    session: AsyncSession,
    workspace_id: UUID,
    entry_id: UUID,
    content_id: UUID | None,
) -> Any:
    """The write a content token names.

    A client holds `content_version` in its metadata and fetches with it
    directly -- the token IS the write, so there is nothing to translate.
    """
    entry = await session.get(workspace_schema.models.entry, entry_id)
    known = entry is not None and entry.workspace_id == workspace_id

    held = None
    if known:
        held = (
            await _newest_write(workspace_schema, session, workspace_id, entry_id)
            if content_id is None
            else await _written(workspace_schema.models, session, content_id)
        )
        if held is not None and held.entry_id != entry_id:
            held = None

    if held is None and content_id is not None:
        held = await _refused_write(
            workspace_schema.models, session, workspace_id, entry_id, content_id
        )

    if held is None:
        raise HTTPException(
            404, "no such entry" if not known else "entry has no such content"
        )
    return held


async def _written(
    models: Models, session: AsyncSession, content_id: UUID
) -> TextContentRow | BlobContentRow | None:
    return await session.get(models.text_content, content_id) or await session.get(
        models.blob_content, content_id
    )


async def _refused_write(
    models: Models,
    session: AsyncSession,
    workspace_id: UUID,
    entry_id: UUID,
    content_id: UUID,
) -> Any | None:
    """A write this server declined, asked for by the transaction that sent it.

    Answered at the same address as an accepted one, because a client holding
    a transaction id should not have to know which way the answer went to ask
    what it said -- and the reason it is asking is usually that it does not.

    Newest of its transaction, which matters only for a request re-sent after
    a dropped connection: refused twice, two rows, and the one this client was
    holding when it gave up is the later.
    """
    for refused in models.refused_content:
        found = (
            await session.exec(
                select(refused)
                .where(
                    col(refused.workspace_id) == workspace_id,
                    col(refused.transaction) == content_id,
                    col(refused.entry_id) == entry_id,
                )
                .order_by(desc(col(refused.timestamp)))
            )
        ).first()
        if found is not None:
            return found
    return None


async def _newest_write(
    workspace_schema: Workspaces,
    session: AsyncSession,
    workspace_id: UUID,
    entry_id: UUID,
) -> TextContentRow | BlobContentRow | None:
    node = await workspace_schema.tree.node(session, workspace_id, entry_id)
    if node is None or node.content is None:
        return None
    return await _written(workspace_schema.models, session, node.content.version)
