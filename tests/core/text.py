"""What `Text` reconstructs, and what it avoids reconstructing twice.

No database here. The queries `Text` runs are two -- the anchor and a span of
deltas -- and standing in for them is what makes it possible to COUNT them,
which is the only way to state the thing that matters about the cache: not
that it answers, but that it stops walking the whole chain per version.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast
from uuid import UUID, uuid4

from pytest import MonkeyPatch

# Absolute, like every other test here: pytest roots this module at the first
# directory without an `__init__.py`, which is not deep enough for the package
# relative imports of `models` to resolve from.
from wsfs_mono.wsfs_core_suede.backend.diff import Delta, diff_to_delta
from wsfs_mono.wsfs_core_suede.backend.models import Models
from wsfs_mono.wsfs_core_suede.backend.text import (
    BEFORE_ANY_WRITE,
    FOLD_IN_A_THREAD_ABOVE,
    Text,
    _Anchor,  # pyright: ignore[reportPrivateUsage]
    _Reconstructed,  # pyright: ignore[reportPrivateUsage]
)

ENTRY = uuid4()
OTHER = uuid4()
NO_SESSION = cast(Any, None)


class _History:
    """One entry's committed text writes, and what reading them costs.

    `texts[i]` is what the entry held at position `i + 1`; position 0 is
    before any write, which is the empty string.
    """

    def __init__(self, *texts: str) -> None:
        self.texts = list(texts)
        self.deltas: list[Delta] = []
        previous = ""
        for text in self.texts:
            self.deltas.append(diff_to_delta(previous, text))
            previous = text
        self.anchors_read = 0
        self.deltas_read = 0

    @property
    def newest(self) -> int:
        return len(self.texts)

    def at(self, position: int) -> str:
        return "" if position == BEFORE_ANY_WRITE else self.texts[position - 1]


def _over(history: _History) -> Text:
    """A `Text` whose two queries are answered from `history`, and counted."""
    text = Text(cast(Models, None))

    async def anchor(_session: Any, _entry_id: UUID) -> _Anchor:
        history.anchors_read += 1
        return _Anchor(text=history.at(history.newest), position=history.newest)

    async def deltas(
        _session: Any, _entry_id: UUID, *, after: int, through: int
    ) -> list[Delta]:
        span = history.deltas[after:through]
        history.deltas_read += len(span)
        return span

    text._anchor = anchor  # pyright: ignore[reportAttributeAccessIssue]
    text._deltas = deltas  # pyright: ignore[reportAttributeAccessIssue]
    return text


def _chain(versions: int, *, columns: int = 22) -> _History:
    """A file somebody edited `versions` times, growing as they went.

    `columns` widens each line without changing the shape of the history,
    which is how a fold is made big enough to be worth a thread.
    """
    return _History(
        *[
            "\n".join(
                f"line {line} as of write {write}".ljust(columns, ".")
                for line in range(write + 3)
            )
            for write in range(1, versions + 1)
        ]
    )


# -- what it answers -------------------------------------------------------


async def test_committed_answers_what_at_answers():
    """The cache is an optimisation or it is a bug. There is no third option."""
    history = _chain(9)
    text = _over(history)
    for position in range(BEFORE_ANY_WRITE, history.newest + 1):
        assert await text.committed(NO_SESSION, ENTRY, position) == history.at(position)
        assert await text.at(NO_SESSION, ENTRY, position) == history.at(position)


async def test_committed_answers_the_same_in_any_order():
    """Which versions are already in hand must not change what is returned.

    Reading newest-first leaves a different set of remembered versions than
    reading oldest-first does, and every later read folds from one of them --
    so an off-by-one in either direction of the walk shows up here.
    """
    history = _chain(9)
    positions = list(range(BEFORE_ANY_WRITE, history.newest + 1))
    for order in (positions, list(reversed(positions)), [7, 1, 9, 4, 0, 6, 2]):
        text = _over(history)
        for position in order:
            assert await text.committed(
                NO_SESSION, ENTRY, position
            ) == history.at(position)


async def test_committed_reads_a_version_written_after_it_started():
    """A cache holding older versions must not answer for a newer one."""
    history = _chain(4)
    text = _over(history)
    assert await text.committed(NO_SESSION, ENTRY, 2) == history.at(2)

    history.texts.append("something else entirely")
    history.deltas.append(diff_to_delta(history.texts[-2], history.texts[-1]))

    assert await text.committed(NO_SESSION, ENTRY, 5) == history.at(5)


# -- what it avoids doing --------------------------------------------------


async def test_replaying_a_backlog_folds_one_delta_per_version():
    """The incident this exists for.

    A client reconnecting replays every version it missed, oldest first. Each
    of those used to walk back from the newest write, which is quadratic in
    the length of the chain; folding from the version already in hand is one
    delta each.
    """
    history = _chain(12)
    text = _over(history)

    for position in range(1, history.newest + 1):
        _ = await text.committed(NO_SESSION, ENTRY, position)

    walked_from_the_newest_each_time = sum(
        history.newest - position for position in range(1, history.newest + 1)
    )
    assert history.deltas_read < walked_from_the_newest_each_time / 2
    assert history.anchors_read == 1


async def test_a_version_already_in_hand_costs_nothing():
    history = _chain(6)
    text = _over(history)
    _ = await text.committed(NO_SESSION, ENTRY, 3)

    history.anchors_read = history.deltas_read = 0
    assert await text.committed(NO_SESSION, ENTRY, 3) == history.at(3)
    assert (history.anchors_read, history.deltas_read) == (0, 0)


async def test_a_distant_version_is_not_walked_to_when_the_anchor_is_closer():
    """Holding one far-off version must not mean folding the chain from it.

    Seeded with ONLY that version, because a `committed` call that reached
    the anchor would have remembered it -- and then the nearest version in
    hand is the anchor, which is not the case under test.
    """
    history = _chain(40)
    text = _over(history)
    text._reconstructed.put(  # pyright: ignore[reportPrivateUsage]
        ENTRY, 1, history.at(1)
    )

    assert await text.committed(NO_SESSION, ENTRY, 40) == history.at(40)
    assert history.anchors_read == 1, "worth one query rather than 39 deltas"
    assert history.deltas_read == 0


async def test_a_nearby_version_is_walked_to_without_asking_for_the_anchor():
    """The other side of the same guard, and the common case.

    A client replaying a backlog asks for the version after the one it just
    got. Spending a query to confirm what is already the nearest would put
    the anchor read back on the hot path this exists to take it off.
    """
    history = _chain(40)
    text = _over(history)
    text._reconstructed.put(  # pyright: ignore[reportPrivateUsage]
        ENTRY, 20, history.at(20)
    )

    assert await text.committed(NO_SESSION, ENTRY, 22) == history.at(22)
    assert history.anchors_read == 0
    assert history.deltas_read == 2


# -- what it does off the event loop ---------------------------------------


async def test_a_big_fold_is_handed_to_a_thread(monkeypatch: MonkeyPatch):
    """Big enough to stall everybody, so it goes where it can be interrupted."""
    threaded: list[str] = []
    handed_off = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded.append(fn.__name__)
        return await handed_off(fn, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", spy)

    small = _History("hello", "hello there", "hello there, world")
    assert await _over(small).committed(NO_SESSION, ENTRY, 1) == small.at(1)
    assert threaded == [], "a fold this small costs less than the handoff does"

    big = _chain(40, columns=60)
    assert len(big.at(big.newest)) * big.newest > FOLD_IN_A_THREAD_ABOVE
    assert await _over(big).committed(NO_SESSION, ENTRY, 1) == big.at(1)
    assert threaded == ["recover_base"]


# -- what it keeps ---------------------------------------------------------


def test_reconstructed_forgets_the_least_recently_used():
    held = _Reconstructed(budget=10)
    held.put(ENTRY, 1, "aaaa")
    held.put(ENTRY, 2, "bbbb")
    assert held.get(ENTRY, 1) == "aaaa"  # touched, so 2 is now the oldest

    held.put(ENTRY, 3, "cccc")
    assert held.get(ENTRY, 2) is None
    assert held.get(ENTRY, 1) == "aaaa"
    assert held.get(ENTRY, 3) == "cccc"


def test_reconstructed_counts_characters_rather_than_versions():
    held = _Reconstructed(budget=10)
    held.put(ENTRY, 1, "a" * 6)
    held.put(ENTRY, 2, "b" * 6)
    assert held.get(ENTRY, 1) is None, "two of these do not fit, however few they are"

    held.put(ENTRY, 3, "c" * 40)
    assert held.get(ENTRY, 3) is None, "one that would evict everything keeps nothing"
    assert held.get(ENTRY, 2) == "b" * 6


def test_reconstructed_replaces_rather_than_double_counting():
    held = _Reconstructed(budget=10)
    for _ in range(5):
        held.put(ENTRY, 1, "aaaa")
    held.put(ENTRY, 2, "bb")
    assert held.get(ENTRY, 1) == "aaaa"
    assert held.get(ENTRY, 2) == "bb"


def test_reconstructed_finds_the_nearest_version_of_the_right_entry():
    held = _Reconstructed(budget=1000)
    held.put(ENTRY, 2, "two")
    held.put(ENTRY, 9, "nine")
    held.put(OTHER, 7, "another entry's seven")

    assert held.nearest(ENTRY, 8) == _Anchor(text="nine", position=9)
    assert held.nearest(ENTRY, 4) == _Anchor(text="two", position=2)
    assert held.nearest(uuid4(), 4) is None


def test_reconstructed_stops_offering_what_it_has_evicted():
    held = _Reconstructed(budget=8)
    held.put(ENTRY, 1, "aaaa")
    held.put(ENTRY, 2, "bbbb")
    held.put(ENTRY, 3, "cccc")

    assert held.nearest(ENTRY, 1) == _Anchor(text="bbbb", position=2)
