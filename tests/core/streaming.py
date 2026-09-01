"""The stream: one ordered channel, claimed once, spliced without a gap."""

import asyncio
import time
from uuid import UUID

from conftest import (
    Api,
    meta,
    acknowledged,
    content_version,
    created,
    listening,
    name_version,
    new_id,
    parent_version,
    seen,
)


async def test_every_mutation_reaches_the_stream_in_order(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        folder = await created(api, "src", type="folder")
        file = await created(api, "a.py", parent=folder)
        acknowledged(await api.write(file, await content_version(api, file), "hello"))
        acknowledged(await api.rename(file, await name_version(api, file), "b.py"))
        acknowledged(await api.reparent(file, await parent_version(api, file), folder))
        acknowledged(await api.delete(file, await seen(api, file)))

        events = await heard.until(6)

    assert [event["type"] for event in events] == [
        "create", "create", "write", "name", "parent", "delete",
    ]


async def test_a_create_event_carries_the_whole_entry_and_its_tokens(api: Api):
    born = api.transaction()
    folder = new_id()
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(await api.create(folder, name="src", type="folder", transaction=born))
        event = (await heard.until(1))[0]

    assert event["value"] == {
        "id": folder,
        "type": "folder",
        "name": "src",
        "name_version": born,
        "parent_version": born,
        "deleted_version": born,
        # A birth is one transaction, so the entry's mtime is that transaction.
        "modified": event["at"],
    }


async def test_an_event_announces_the_transaction_that_is_now_the_token(api: Api):
    file = await created(api, "a.py")
    renaming = api.transaction()
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(
            await api.rename(file, await name_version(api, file), "b.py", transaction=renaming)
        )
        event = (await heard.until(1))[0]

    assert event["transaction"] == renaming == await name_version(api, file)


async def test_a_write_event_is_a_pure_invalidation_signal(api: Api):
    file = await created(api, "a.py")
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(await api.write(file, await content_version(api, file), "secret"))
        event = (await heard.until(1))[0]

    assert set(event) == {"type", "id", "transaction", "user", "at"}
    assert "secret" not in str(event)
    assert event["transaction"] == await content_version(api, file)


async def test_a_move_to_the_root_carries_an_explicit_null(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py", parent=folder)
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(await api.reparent(file, await parent_version(api, file), None))
        event = (await heard.until(1))[0]

    assert event["value"] is None


async def test_the_internal_position_never_reaches_a_client(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        await created(api, "a.py")
        event = (await heard.until(1))[0]

    assert "position" not in event


async def test_a_deduping_rename_reaches_the_client_as_an_ordinary_name_event(api: Api):
    await created(api, "notes.md")
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        second = await created(api, "notes.md")
        events = await heard.until(2)

    assert [event["type"] for event in events] == ["create", "name"]
    assert events[0]["value"]["name"] == "notes.md"  # applied as asked
    assert events[1] == {
        "type": "name",
        "id": second,
        "transaction": events[1]["transaction"],
        "value": "notes (2).md",
        "user": events[0]["user"],
        "at": events[1]["at"],
    }
    assert events[1]["transaction"] != events[0]["transaction"]


async def test_a_stream_replays_what_it_missed_before_going_live(api: Api):
    token = (await api.initialize())["token"]
    await created(api, "missed-while-connecting.py")

    async with listening(api, token) as heard:
        await created(api, "seen-live.py")
        events = await heard.until(2)

    assert [event["value"]["name"] for event in events] == [
        "missed-while-connecting.py",
        "seen-live.py",
    ]


async def test_a_snapshot_and_its_token_leave_no_gap_and_no_overlap(api: Api):
    await created(api, "before.py")
    snapshot = await api.initialize()

    async with listening(api, snapshot["token"]) as heard:
        await created(api, "after.py")
        events = await heard.until(1)

    assert [entry["name"] for entry in snapshot["entries"]] == ["before.py"]
    assert [event["value"]["name"] for event in events] == ["after.py"]


async def test_a_token_is_spent_by_the_connection_that_claims_it(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token):
        async with api.stream(token) as second:
            assert second.status_code == 401


async def test_two_connections_racing_one_token_produce_exactly_one_winner(api: Api):
    token = (await api.initialize())["token"]

    async def connect() -> int:
        async with api.stream(token) as response:
            return response.status_code

    statuses = await asyncio.gather(connect(), connect())
    assert sorted(statuses) == [200, 401]


async def test_an_unknown_token_is_refused(api: Api):
    async with api.stream("not-a-token") as response:
        assert response.status_code == 401


async def test_every_subscriber_sees_every_event(api: Api, other: Api):
    mine = (await api.initialize())["token"]
    theirs = (await other.initialize())["token"]

    async with listening(api, mine) as heard, listening(other, theirs) as overheard:
        await created(api, "shared.py")
        assert (await heard.until(1))[0] == (await overheard.until(1))[0]


async def test_heartbeats_keep_an_idle_stream_alive(api: Api):
    """Waited for rather than slept through: a fixed sleep asserts how fast
    the machine is, which is not what this is about."""
    token = (await api.initialize())["token"]
    async with api.stream(token) as response:
        beats: list[str] = []

        async def read() -> None:
            async for line in response.aiter_lines():
                if line.startswith(":"):
                    beats.append(line)

        reading = asyncio.create_task(read())
        deadline = time.monotonic() + 5.0
        while not beats and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        reading.cancel()

    assert beats and beats[0] == ": hb"


async def test_a_move_arrives_as_one_event_carrying_both_halves(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    was = await meta(api, file)
    moving = api.transaction()
    token = (await api.initialize())["token"]

    async with listening(api, token) as heard:
        acknowledged(
            await api.move(
                file,
                name="b.py",
                name_version=was["name_version"],
                parent=folder,
                parent_version=was["parent_version"],
                transaction=moving,
            )
        )
        events = await heard.until(1)

    assert len(events) == 1  # never a rename the client has to pair with a move
    assert events[0]["type"] == "move"
    assert events[0]["value"] == {"name": "b.py", "parent": folder}
    assert events[0]["transaction"] == moving

async def test_a_replay_never_sees_a_transaction_half_written(api: Api, app):
    """A transaction's rows live in up to four logs, and the replay reads five.

    Under read committed each of those five queries takes its own snapshot, so
    a transaction committing between two of them is visible in one log and not
    the next -- and a folder create caught that way arrives as a bare `name`,
    which is a perfectly legal event for an entry the client has never heard
    of. It applies nothing, no error is raised anywhere, and the entry is gone
    from that client for good.

    So this hammers replays against a stream of commits and insists every
    event keep the shape the transaction that wrote it had.
    """
    backend = app.state.wsfs
    workspace = UUID(api.workspace)
    total = 40

    async def creating() -> None:
        for n in range(total):
            acknowledged(await api.create(new_id(), name=f"folder-{n}", type="folder"))

    async def replaying() -> list[str]:
        kinds: list[str] = []
        while not writing.done():
            async with backend.database.session() as session:
                replayed = await backend.schema.stream.since(session, workspace, 0)
            kinds.extend(emitted.event.type.value for emitted in replayed)
            await asyncio.sleep(0)
        return kinds

    writing = asyncio.ensure_future(creating())
    watchers = [asyncio.ensure_future(replaying()) for _ in range(4)]
    await writing
    observed = [kind for watcher in await asyncio.gather(*watchers) for kind in watcher]

    # Only creates happened, so only creates may be reported. A torn read
    # shows up here as a `name` or a `move` -- the halves of a create seen on
    # their own.
    assert set(observed) == {"create"}
    async with backend.database.session() as session:
        replayed = await backend.schema.stream.since(session, workspace, 0)
    assert len(replayed) == total
