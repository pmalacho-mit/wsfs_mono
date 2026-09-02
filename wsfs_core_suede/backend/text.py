"""An entry's text at a write, reconstructed from its chain of deltas.

The chain is anchored by the text cache, which holds the text as of the newest
write: reading current content folds nothing, and reading an older one walks
backwards by inverting the few deltas in between.

READS OF COMMITTED WRITES go through `committed` rather than `at`, and are
remembered in this process. That is what keeps a client replaying a backlog
cheap: a stream reconnect asks for every version an entry passed through, and
walking back to each of them from the newest is quadratic in the length of the
chain. Folding each one from the nearest version already in hand is linear.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import final
from uuid import UUID

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from .diff import Delta, apply_deltas, recover_base
from .models import Models, TextContentRow

BEFORE_ANY_WRITE = 0

REMEMBERED_CHARACTERS = 64 * 1024 * 1024
"""How much reconstructed text one process keeps, counted in CHARACTERS.

Counted in characters and not in entries because what runs a process out of
memory is one large file kept at many versions, not many files kept at one.
"""

FOLD_IN_A_THREAD_ABOVE = 64 * 1024
"""Character-operations past which a fold is handed to a thread.

Applying one delta rebuilds the whole text, so a fold costs about
`len(text) * len(deltas)` -- and it is pure Python with no `await` in it, so
until it finishes the event loop cannot run, cannot answer anything else, and
cannot return a single database connection to the pool.

A thread does not make it faster: the GIL means only one of these runs at a
time either way. It makes it INTERRUPTIBLE -- the interpreter switches threads
every few milliseconds, so a fold that would have stalled everything for a
second is instead spread across the work it used to block. Below the threshold
that trade is a loss: the handoff costs more than the fold does, and the
common read -- the newest version, which folds nothing at all -- never gets
here.
"""

WALK_WITHOUT_CHECKING_THE_ANCHOR = 8
"""How far a remembered version may be before the anchor is fetched to compare.

Folding from the nearest version in hand is only a win when it IS the nearest.
A process holding one old version and asked for the newest would otherwise
walk the whole chain rather than spend one query on the anchor it could have
started from. Past this many writes, that query is worth it.
"""


@dataclass(frozen=True)
class _Anchor:
    text: str
    position: int


@final
class _Reconstructed:
    """Reconstructed text, kept under the write it belongs to.

    Sound with no invalidation step at all, which is the whole reason to key
    it this way: `(entry, position)` names a COMMITTED write, and what a write
    left never changes afterwards. A line here is either absent or right. It
    is never stale.
    """

    def __init__(self, *, budget: int) -> None:
        self._budget = budget
        self._held: OrderedDict[tuple[UUID, int], str] = OrderedDict()
        self._positions: dict[UUID, set[int]] = {}
        self._characters = 0

    def get(self, entry: UUID, position: int) -> str | None:
        text = self._held.get((entry, position))
        if text is not None:
            self._held.move_to_end((entry, position))
        return text

    def nearest(self, entry: UUID, position: int) -> _Anchor | None:
        """The version of this entry in hand that is fewest writes away.

        Over one entry's positions rather than the whole cache: an entry has
        as many of these as it has versions, and the cache has as many as the
        deployment has files.
        """
        held = self._positions.get(entry)
        if not held:
            return None
        closest = min(held, key=lambda at: abs(at - position))
        text = self.get(entry, closest)
        return None if text is None else _Anchor(text=text, position=closest)

    def put(self, entry: UUID, position: int, text: str) -> None:
        if len(text) > self._budget:
            return  # a line that would evict everything else keeps nothing
        self._forget(entry, position)
        self._held[(entry, position)] = text
        self._positions.setdefault(entry, set()).add(position)
        self._characters += len(text)
        while self._characters > self._budget:
            (evicted, at), _ = next(iter(self._held.items()))
            self._forget(evicted, at)

    def _forget(self, entry: UUID, position: int) -> None:
        text = self._held.pop((entry, position), None)
        if text is None:
            return
        self._characters -= len(text)
        held = self._positions.get(entry)
        if held is not None:
            held.discard(position)
            if not held:
                del self._positions[entry]


@final
class Text:
    def __init__(
        self, models: Models, *, remember: int = REMEMBERED_CHARACTERS
    ) -> None:
        self.models = models
        self._reconstructed = _Reconstructed(budget=remember)

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
        """The entry's text as of `position` -- empty if it held none by then.

        Reads the session it is given and remembers nothing, because a writer
        calls this mid-transaction: `remember` has flushed rows that only this
        session can see, and what they say is not yet true for anybody else.
        Reads of committed writes want `committed` instead.
        """
        return await self._folded(
            session, entry_id, position, await self._anchor(session, entry_id)
        )

    async def committed(
        self, session: AsyncSession, entry_id: UUID, position: int
    ) -> str:
        """The text a COMMITTED write left, remembered between calls.

        The same answer `at` gives, by the same route. What it adds is that
        the result is kept, and that the next read of a nearby version folds
        from the nearest one already in hand instead of walking back from the
        newest -- which is the difference between one delta per version and
        the whole chain per version when a client replays a backlog.

        ONLY FOR WRITES THAT HAVE LANDED. Called with a session in the middle
        of a transaction it would remember rows nobody else can see yet.
        """
        remembered = self._reconstructed.get(entry_id, position)
        if remembered is not None:
            return remembered

        known = self._reconstructed.nearest(entry_id, position)
        if (
            known is None
            or abs(known.position - position) > WALK_WITHOUT_CHECKING_THE_ANCHOR
        ):
            anchor = await self._anchor(session, entry_id)
            self._reconstructed.put(entry_id, anchor.position, anchor.text)
            if known is None or abs(anchor.position - position) < abs(
                known.position - position
            ):
                known = anchor

        text = await self._folded(session, entry_id, position, known)
        self._reconstructed.put(entry_id, position, text)
        return text

    async def _folded(
        self, session: AsyncSession, entry_id: UUID, position: int, known: _Anchor
    ) -> str:
        """`known`, walked to `position` -- forwards or backwards as needed.

        Correct from ANY version of this entry, not only from the anchor: the
        deltas in a span are a fact about the span, so folding them onto the
        text at one end reaches the other regardless of where the newest write
        happens to be.
        """
        if position >= known.position:
            forwards = await self._deltas(
                session, entry_id, after=known.position, through=position
            )
            return await self._fold(apply_deltas, known.text, forwards)
        undone = await self._deltas(
            session, entry_id, after=position, through=known.position
        )
        return await self._fold(recover_base, known.text, undone)

    @staticmethod
    async def _fold(
        fold: Callable[[str, Iterable[Delta]], str], base: str, deltas: list[Delta]
    ) -> str:
        """Off the event loop when it is big enough to be worth the handoff."""
        if not deltas:
            return base
        if len(base) * len(deltas) < FOLD_IN_A_THREAD_ABOVE:
            return fold(base, deltas)
        return await asyncio.to_thread(fold, base, deltas)

    async def remember(
        self, session: AsyncSession, written: TextContentRow, content: str
    ) -> None:
        """Re-anchor the chain at `written`, which must be the entry's newest.

        Flushed before returning. A later write in the same unit of work reads
        the anchor back with a SELECT to fold its delta against, and leaving
        that to autoflush would make correctness here rest on a session
        setting somebody two layers up is free to turn off.

        Nothing is told to `_reconstructed` here. This runs inside the write's
        transaction, which may still be rolled back, and a write that lands
        invalidates nothing that is already held: the versions in hand are
        older ones, and what they say stays true.
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
