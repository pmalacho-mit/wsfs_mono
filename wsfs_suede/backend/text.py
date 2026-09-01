"""An entry's text at a write, reconstructed from its chain of deltas.

The chain is anchored by the text cache, which holds the text as of the newest
write: reading current content folds nothing, and reading an older one walks
backwards by inverting the few deltas in between.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import final
from uuid import UUID

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .diff import Delta, apply_deltas, recover_base
from .models import Models, TextContentRow

BEFORE_ANY_WRITE = 0


@dataclass(frozen=True)
class _Anchor:
    text: str
    position: int


@final
class Text:
    def __init__(self, models: Models) -> None:
        self.models = models

    async def _anchor(self, session: AsyncSession, entry_id: UUID) -> _Anchor:
        cache, written = self.models.text_cache, self.models.text_content
        cached = (
            await session.exec(
                select(cache, written)
                .join(written, col(written.id) == col(cache.content_id))
                .where(col(cache.entry_id) == entry_id)
            )
        ).first()
        if cached is None:
            return _Anchor(text="", position=BEFORE_ANY_WRITE)
        anchored, write = cached
        return _Anchor(text=anchored.content, position=write.position)

    async def _deltas(
        self, session: AsyncSession, entry_id: UUID, *, after: int, through: int
    ) -> list[Delta]:
        """Every text delta this entry gained in (after, through], oldest first.

        Binary writes in that span contribute nothing: an entry's text chain
        runs through its text writes alone, so a file that went text -> binary
        -> text still reconstructs.
        """
        written = self.models.text_content
        deltas = (
            select(col(written.delta))
            .where(
                col(written.entry_id) == entry_id,
                col(written.position) > after,
                col(written.position) <= through,
            )
            .order_by(col(written.position))
        )
        return list(await session.exec(deltas))

    async def at(self, session: AsyncSession, entry_id: UUID, position: int) -> str:
        """The entry's text as of `position` -- empty if it held none by then."""
        anchor = await self._anchor(session, entry_id)
        if position >= anchor.position:
            forwards = await self._deltas(
                session, entry_id, after=anchor.position, through=position
            )
            return apply_deltas(anchor.text, forwards)
        undone = await self._deltas(
            session, entry_id, after=position, through=anchor.position
        )
        return recover_base(anchor.text, undone)

    async def remember(
        self, session: AsyncSession, written: TextContentRow, content: str
    ) -> None:
        """Re-anchor the chain at `written`, which must be the entry's newest.

        Flushed before returning. A later write in the same unit of work reads
        the anchor back with a SELECT to fold its delta against, and leaving
        that to autoflush would make correctness here rest on a session
        setting somebody two layers up is free to turn off.
        """
        cache = self.models.text_cache
        anchored = (
            await session.exec(
                select(cache).where(col(cache.entry_id) == written.entry_id)
            )
        ).first()
        if anchored is None:
            session.add(
                cache(entry_id=written.entry_id, content_id=written.id, content=content)
            )
        else:
            anchored.content_id = written.id
            anchored.content = content
            session.add(anchored)
        await session.flush()
