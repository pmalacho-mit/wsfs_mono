"""What a shared room owes the file underneath it, and the updates that settle it.

The room is a Liveblocks document; the file is wsfs. This decides which of the
two is behind and builds the Yjs update that closes the gap. Nothing here
reaches Liveblocks.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Iterator, Union

from fast_diff_match_patch import diff

from pycrdt import Doc, Map, Text

CONTENT = "content"


@dataclass(frozen=True)
class Standing:
    """A room: what its document holds, and what this host remembers of it.

    THE TEXT COMES FROM THE ROOM AND THE BASE DOES NOT. Keeping the base in
    the document would be honest and ruinous: advancing it is a write, so
    every store by anybody would cost a round trip to the collaboration
    server for every client that heard about it. It is bookkeeping, this host
    is the only thing that writes it, and this host has a much cheaper place
    to put it.
    """

    text: str
    base: str | None


@dataclass(frozen=True)
class Held:
    """A file, as wsfs reports it."""

    text: str
    version: str


@dataclass(frozen=True)
class Change:
    """What one writer did, between two stored versions."""

    before: str
    after: str


@dataclass(frozen=True)
class Settled:
    pass


@dataclass(frozen=True)
class Seed:
    text: str
    version: str


@dataclass(frozen=True)
class Rebase:
    version: str


@dataclass(frozen=True)
class Carry:
    since: str
    version: str


Plan = Union[Settled, Seed, Rebase, Carry]


# -- what a room owes ------------------------------------------------------------------


def unseeded(room: Standing) -> bool:
    """Nobody has ever filled this room.

    Asked of the base and not of the text, because a file is allowed to be
    empty and a room judged by its text would be seeded again every time.
    """
    return room.base is None


def standing_where_the_file_stands(room: Standing, file: Held) -> bool:
    return room.base == file.version


def already_says_it(room: Standing, file: Held) -> bool:
    """The same conclusion for a write whose bookkeeping has not arrived yet.

    The two travel by different routes -- the write through the server, the
    room's note of it through the document -- and nothing orders them.
    """
    return room.text == file.text


def plan(room: Standing, file: Held) -> Plan:
    if unseeded(room):
        return Seed(text=file.text, version=file.version)
    if standing_where_the_file_stands(room, file):
        return Settled()
    if already_says_it(room, file):
        return Rebase(version=file.version)
    assert room.base is not None
    return Carry(since=room.base, version=file.version)


# -- reading and writing a room --------------------------------------------------------


def _opened(update: bytes) -> Doc[Any]:
    doc = Doc()
    doc[CONTENT] = Text()
    if update:
        doc.apply_update(update)
    return doc


def standing_of(update: bytes, base: str | None) -> Standing:
    """What the room holds, put together with what this host remembers."""
    return Standing(text=str(_opened(update)[CONTENT]), base=base)


def seeded(text: str) -> bytes:
    doc = _opened(b"")
    doc[CONTENT] += text
    return doc.get_update()


def carried(live: bytes, change: Change) -> bytes:
    """An update taking the room from what it holds to what the file now says.

    Built on the room's LIVE state, because a Yjs update computed against a
    stale one is dropped without a word.
    """
    doc = _opened(live)
    was = doc.get_state()
    _carry(doc[CONTENT], change)
    return doc.get_update(was)


# -- carrying one writer's change into a room that has moved on ------------------------


@dataclass(frozen=True)
class Edit:
    """One writer's change, at a position in the text they started from."""

    at: int
    remove: int
    insert: str


def _edits(change: Change) -> Iterator[Edit]:
    """`change` as edits positioned in `change.before`.

    Both sides are stored versions, so this describes only what that writer
    did. Diffing from the room instead would call another user's unstored
    typing text to delete.
    """
    at = 0
    reached = 0
    for op, length in diff(change.before, change.after, timelimit=0, checklines=False):
        if op == "=":
            at += length
            reached += length
        elif op == "-":
            yield Edit(at=at, remove=length, insert="")
            at += length
        else:
            yield Edit(at=at, remove=0, insert=change.after[reached : reached + length])
            reached += length


def _elsewhere(before: str, live: str):
    """Where a position in `before` has ended up in `live`.

    The room has drifted from the version the change was written against, so
    the positions have to be found again rather than trusted.
    """
    blocks = SequenceMatcher(None, before, live, autojunk=False).get_matching_blocks()

    def moved(at: int) -> int:
        for starts, lands, size in blocks:
            if at < starts:
                return lands
            if at < starts + size:
                return lands + (at - starts)
        return len(live)

    return moved


def _upto(before: str, live: str):
    """Where a span ENDING at a position in `before` ends in `live`.

    Not the same question as where the position itself moved to, and the
    difference is somebody else's typing. A position at the boundary between
    two matched runs moves FORWARD past anything inserted between them -- so
    using it as an exclusive end would delete that insertion along with the
    span. This answers with the end of the run the span was in, which is the
    last character that actually corresponds to what the writer removed.
    """
    blocks = SequenceMatcher(None, before, live, autojunk=False).get_matching_blocks()

    def ending(at: int) -> int:
        reached = 0
        for starts, lands, size in blocks:
            if at <= starts:
                break
            if at <= starts + size:
                return lands + (at - starts)
            reached = lands + size
        return reached

    return ending


def _carry(text: Text, change: Change) -> None:
    """Apply `change` to `text` as edits, latest first.

    Latest first so that earlier positions stay valid as it goes, which is the
    whole of the bookkeeping this would otherwise need.
    """
    live = str(text)
    moved = _elsewhere(change.before, live)
    ending = _upto(change.before, live)
    for edit in sorted(_edits(change), key=lambda edit: edit.at, reverse=True):
        at = moved(edit.at)
        if edit.remove:
            """BOTH ENDS are moved, not the start plus a length.

            `remove` counts characters in `before`, and the room has drifted
            from `before` -- so the same span is a different length here, and
            adding the old one walks off the end of somebody else's text. It
            did: pycrdt PANICS rather than raising ("couldn't remove 65
            elements, only 49 were removed"), which took the room's whole
            settle with it.

            Moving the end instead deletes the region that CORRESPONDS to
            what the writer deleted. It cannot run past the text, because
            `_elsewhere` never answers beyond it, and it does not eat a
            neighbour's insertion the way a fixed count does.
            """
            end = ending(edit.at + edit.remove)
            if end > at:
                del text[at:end]
        if edit.insert:
            text.insert(at, edit.insert)
