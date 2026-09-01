"""The three answers a collaboration service owes, asked of every implementation.

CONFORMANCE.md section O. The point of this file is not that any one service
works -- it is that the seam is three methods and nothing in it is shaped like
a vendor. A rule that only one implementation is ever asked about is a rule
nobody has tested; two make it a fact.

`InProcessCollaboration` is always exercised. `Liveblocks` joins in only when
there is a key and a network to reach it with, which is the arrangement that
lets the rest of the suite run with neither.
"""

import os

import pytest
from pycrdt import Doc, Text

from wsfs_mono.wsfs_core_suede.backend.collaboration import (
    ICollaboration,
    InProcessCollaboration,
    Liveblocks,
)
from wsfs_mono.wsfs_core_suede.backend.rooms import seeded


def implementations() -> list[pytest.param]:
    """Every service this package ships, and a reason for any that is skipped."""
    secret = os.environ.get("LIVEBLOCKS_SECRET_KEY")
    return [
        pytest.param(InProcessCollaboration, id="in-process"),
        pytest.param(
            lambda: Liveblocks(secret or ""),
            id="liveblocks",
            marks=pytest.mark.skipif(
                not secret, reason="no LIVEBLOCKS_SECRET_KEY, so no service to reach"
            ),
        ),
    ]


@pytest.fixture(params=implementations())
def collaboration(request) -> ICollaboration:
    return request.param()


def text_of(update: bytes) -> str:
    doc = Doc()
    doc["content"] = Text()
    if update:
        doc.apply_update(update)
    return str(doc["content"])


async def test_a_room_nobody_has_written_to_reads_as_nothing(collaboration, room):
    """O1. The one behaviour worth stating twice.

    An implementation that raises here passes casual testing and breaks
    seeding: the keeper's whole job is telling "no such room" from "a room
    holding nothing" with a lock, and it cannot do that if the service will
    not answer the second.
    """
    await collaboration.create(room)
    assert await collaboration.document(room) == b""


async def test_a_room_that_was_never_created_also_reads_as_nothing(collaboration, room):
    """The same ambiguity from the other side, and deliberately the same answer."""
    assert await collaboration.document(room) == b""


async def test_creating_a_room_twice_is_creating_it_once(collaboration, room):
    """The keeper remembers that a room exists, and that memory is all that
    stands between a restart and paying for this on every file anybody opens.
    A memory that is merely usually right is fine only if being wrong is free."""
    await collaboration.create(room)
    await collaboration.send(room, seeded("hello"))
    await collaboration.create(room)
    assert text_of(await collaboration.document(room)) == "hello"


async def test_an_update_reaches_the_room(collaboration, room):
    await collaboration.create(room)
    await collaboration.send(room, seeded("print(1)"))
    assert text_of(await collaboration.document(room)) == "print(1)"


async def test_the_same_update_twice_merges_to_the_same_document(collaboration, room):
    """An update carries the identities of the characters in it, which is what
    lets a client cut off from the service hand its work to the host and still
    have its own connection deliver it when that returns. Neither route has to
    know about the other."""
    await collaboration.create(room)
    update = seeded("once")
    await collaboration.send(room, update)
    await collaboration.send(room, update)
    assert text_of(await collaboration.document(room)) == "once"


async def test_rooms_do_not_leak_into_each_other(collaboration, room, another_room):
    await collaboration.create(room)
    await collaboration.create(another_room)
    await collaboration.send(room, seeded("mine"))
    assert await collaboration.document(another_room) == b""


@pytest.fixture
def room() -> str:
    from uuid import uuid4

    return f"wsfs-conformance-{uuid4()}"


@pytest.fixture
def another_room() -> str:
    from uuid import uuid4

    return f"wsfs-conformance-{uuid4()}"
