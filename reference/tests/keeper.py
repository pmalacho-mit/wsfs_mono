"""Keeping every entry's room in step with its file, without racing itself."""

import asyncio

from pycrdt import Doc, Map, Text

from wsfs_suede.release.backend.keeper import Keeper
from wsfs_suede.release.backend.rooms import Held

BORN = "01a02361-dad9-755a-ba88-e651f1ad637a"
WROTE = "01a02361-e423-71aa-ad9b-f4bd66c1aeb1"


class FakeLiveblocks:
    """Rooms as bytes, with every call counted."""

    def __init__(self) -> None:
        self.documents: dict[str, bytes] = {}
        self.created: list[str] = []
        self.sent: list[str] = []
        self.reads = 0
        self.between: object | None = None
        self.answering = asyncio.Event()
        self.answering.set()

    async def create(self, room: str) -> None:
        self.created.append(room)
        self.documents.setdefault(room, b"")

    async def document(self, room: str) -> bytes:
        """Answers, and only then lets `between` change the room.

        So the read that DECIDES sees the room as it was, and the read the
        update is built on sees it after -- which is the window the keeper has
        to close.
        """
        await self.answering.wait()
        self.reads += 1
        said = self.documents.get(room, b"")
        if self.between is not None:
            catching_up, self.between = self.between, None
            await catching_up()
        return said

    async def send(self, room: str, update: bytes) -> None:
        self.sent.append(room)
        doc = Doc()
        doc["content"] = Text()
        if self.documents.get(room):
            doc.apply_update(self.documents[room])
        doc.apply_update(update)
        self.documents[room] = doc.get_update()

    def text(self, room: str) -> str:
        doc = Doc()
        doc["content"] = Text()
        doc.apply_update(self.documents[room])
        return str(doc["content"])


class FakeFiles:
    def __init__(self, now: Held | None, history: dict[str, str] | None = None) -> None:
        self.held = now
        self.history = history or {}

    async def now(self, entry: str) -> Held | None:
        return self.held

    async def at(self, entry: str, version: str) -> str:
        return self.history[version]


class FakeStandings:
    """A table that survives, as far as a test is concerned."""

    def __init__(self) -> None:
        self.rows: dict[str, str | None] = {}
        self.reads = 0

    async def standing(self, entry: str) -> tuple[bool, str | None]:
        self.reads += 1
        return (entry in self.rows, self.rows.get(entry))

    async def remember(self, entry: str, base: str | None) -> None:
        self.rows[entry] = base


def keeping(
    liveblocks: FakeLiveblocks,
    files: FakeFiles,
    standings: FakeStandings | None = None,
) -> Keeper:
    return Keeper(
        collaboration=liveblocks, files=files, standings=standings or FakeStandings()
    )


async def test_a_room_is_created_and_filled_from_the_file():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))

    await keeper.ensure("entry")

    assert liveblocks.created == ["entry"]
    assert liveblocks.text("entry") == "hello\n"


async def test_a_room_already_standing_where_the_file_stands_is_left_alone():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    await keeper.ensure("entry")

    await keeper.ensure("entry")

    assert liveblocks.sent == ["entry"]


async def test_a_room_left_behind_has_the_change_carried_into_it():
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    files.held = Held("hello\nfrom a script\n", WROTE)
    files.history = {BORN: "hello\n"}
    await keeper.ensure("entry")

    assert liveblocks.text("entry") == "hello\nfrom a script\n"


async def test_unstored_typing_survives_a_change_being_carried_in():
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    typing = Doc()
    typing["content"] = Text()
    typing.apply_update(liveblocks.documents["entry"])
    typing["content"] += "not stored yet"
    await liveblocks.send("entry", typing.get_update())

    files.held = Held("hello\nfrom a script\n", WROTE)
    files.history = {BORN: "hello\n"}
    await keeper.ensure("entry")

    said = liveblocks.text("entry")
    assert "not stored yet" in said
    assert said.count("from a script") == 1


async def test_two_arrivals_at_a_cold_room_seed_it_once():
    # The race the client's own election existed for. One keeper, one lock,
    # and the second arrival finds a room that is already filled.
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    liveblocks.answering.clear()

    both = asyncio.gather(keeper.ensure("entry"), keeper.ensure("entry"))
    await asyncio.sleep(0)
    liveblocks.answering.set()
    await both

    assert liveblocks.text("entry") == "hello\n"
    assert liveblocks.sent == ["entry"]


async def test_different_entries_do_not_wait_on_each_other():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    liveblocks.answering.clear()

    both = asyncio.gather(keeper.ensure("one"), keeper.ensure("two"))
    await asyncio.sleep(0)
    liveblocks.answering.set()
    await both

    assert sorted(liveblocks.created) == ["one", "two"]


async def test_a_room_is_only_created_once_however_often_it_is_ensured():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))

    await keeper.ensure("entry")
    await keeper.ensure("entry")
    await keeper.ensure("entry")

    assert liveblocks.created == ["entry"]


async def test_a_file_that_is_not_text_is_left_without_a_room_to_fill():
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(None))

    await keeper.ensure("entry")

    assert liveblocks.sent == []


async def test_a_write_a_member_made_costs_nothing_to_settle():
    """The saving the whole design turns on.

    A client saves; every other client with that file open asks this host to
    settle the room. If answering meant reading the collaboration server, one
    person typing would cost a round trip per collaborator per save.
    """
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    files.held = Held("hello\nmine\n", WROTE)
    await keeper.stored("entry", WROTE)
    reads = liveblocks.reads

    for _ in range(50):
        await keeper.ensure("entry")

    assert liveblocks.reads == reads
    assert liveblocks.sent == ["entry"]


async def test_a_change_that_arrives_while_the_keeper_decides_is_not_carried_twice():
    """The decision and the update are built from two different reads.

    A room that catches up in between already holds what the carry was going
    to insert, and inserting it again is the doubling this whole design exists
    to prevent -- so what the room says is checked once more, against the read
    the update is actually built on.
    """
    liveblocks = FakeLiveblocks()
    files = FakeFiles(Held("hello\n", BORN))
    keeper = keeping(liveblocks, files)
    await keeper.ensure("entry")

    files.held = Held("hello\nfrom a script\n", WROTE)
    files.history = {BORN: "hello\n"}

    async def the_room_catches_up_first():
        caught = Doc()
        caught["content"] = Text()
        caught.apply_update(liveblocks.documents["entry"])
        caught["content"] += "from a script\n"
        await liveblocks.send("entry", caught.get_update())

    liveblocks.between = the_room_catches_up_first
    await keeper.ensure("entry")

    assert liveblocks.text("entry") == "hello\nfrom a script\n"


async def test_a_client_that_cannot_reach_the_room_is_carried_into_it(api_free=None):
    """The server puts one client's own update into the room for it.

    Forwarded, not interpreted: the update carries its own identities, so it
    merges exactly once however many routes it arrives by -- including that
    client's own connection when it comes back.
    """
    liveblocks = FakeLiveblocks()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)))
    await keeper.ensure("entry")

    alone = Doc()
    alone["content"] = Text()
    alone.apply_update(liveblocks.documents["entry"])
    alone["content"] += "typed with no room\n"
    mine = alone.get_update()

    await keeper.hand_over("entry", mine)
    await keeper.hand_over("entry", mine)

    assert liveblocks.text("entry") == "hello\ntyped with no room\n"


async def test_what_the_host_knows_survives_it_being_restarted():
    """A room is created once, ever, and nothing here destroys one.

    Remembering that in a table rather than in memory is what stops a restart
    charging for the answer again on the first file anybody opens.
    """
    liveblocks = FakeLiveblocks()
    standings = FakeStandings()
    files = FakeFiles(Held("hello\n", BORN))
    await keeping(liveblocks, files, standings).ensure("entry")

    afresh = keeping(liveblocks, files, standings)
    await afresh.ensure("entry")

    assert liveblocks.created == ["entry"]
    assert liveblocks.sent == ["entry"]
    assert liveblocks.reads == 1


async def test_settling_a_room_already_where_it_should_be_asks_nothing():
    """Not the collaboration server, and not the table either."""
    liveblocks = FakeLiveblocks()
    standings = FakeStandings()
    keeper = keeping(liveblocks, FakeFiles(Held("hello\n", BORN)), standings)
    await keeper.ensure("entry")
    reads = standings.reads

    for _ in range(50):
        await keeper.ensure("entry")

    assert standings.reads == reads
