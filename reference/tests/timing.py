"""When a transaction happened -- on the client that made it, and on the server.

Two clocks, recorded two different ways and for two different reasons.

The client's is not sent at all. A transaction's id is a UUIDv7 minted at the
moment the user acted, and a v7 carries its own millisecond, so the instant is
already in the primary key and the server reads it back out. What a v7 cannot
carry is which clock the client was reading, so the offset -- and only the
offset -- rides on the request.

The server's is stamped as the row is applied. It is the half that can be
trusted, and after an offline week it is days away from the other one.
"""

from datetime import UTC, datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from sqlmodel import Session, select

from wsfs_suede.samples.backend.app import MODELS
from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    meta,
    minted_elsewhere,
    name_version,
    new_id,
    seen,
)
from wsfs_suede.release.backend.minted import mint, minted_at

BERLIN_IN_SUMMER = 120
LOS_ANGELES = -420
NEPAL = 345
"""Not every zone is a whole number of hours, and the wire carries minutes so
that the ones that are not can be said at all."""


def when(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


# -- what a v7 does and does not carry ----------------------------------------


def test_a_v7_says_when_it_was_minted():
    """Sub-millisecond precision is dropped, and dropped DOWNWARDS -- 48 bits
    of milliseconds is what the format has room for."""
    at = datetime(2026, 8, 19, 17, 4, 5, 678999, tzinfo=UTC)
    assert minted_at(mint(at)) == at.replace(microsecond=678000)


@pytest.mark.parametrize(
    "at",
    [
        datetime(2038, 9, 27, 22, 45, 23, 857000, tzinfo=UTC),
        datetime(1978, 9, 8, 7, 20, 59, 715000, tzinfo=UTC),
        datetime(2039, 5, 15, 5, 45, 9, 186000, tzinfo=UTC),
    ],
)
def test_a_whole_millisecond_survives_being_minted(at: datetime):
    """Instants whose seconds-as-a-float land just under the millisecond they
    are. Computing the epoch offset in floating point and truncating loses the
    last millisecond on roughly one instant in a hundred and sixty; integer
    division does not, and these three are the ones that noticed.
    """
    assert minted_at(mint(at)) == at


def test_a_v7_is_the_same_instant_whatever_zone_it_was_minted_in():
    """The heart of it: an instant has no zone, so two clients on opposite
    sides of the planet acting at the same moment mint the same timestamp.

    Which is exactly why the offset has to be carried separately -- these two
    ids are indistinguishable, and their users were not looking at remotely the
    same clock.
    """
    instant = datetime(2026, 8, 19, 17, 4, 5, tzinfo=UTC)
    berlin = instant.astimezone(timezone(timedelta(minutes=BERLIN_IN_SUMMER)))
    los_angeles = instant.astimezone(timezone(timedelta(minutes=LOS_ANGELES)))

    assert berlin.hour != los_angeles.hour  # the wall clocks disagree
    assert minted_at(mint(berlin)) == minted_at(mint(los_angeles))


def test_an_id_minted_some_other_way_says_nothing_about_when():
    assert minted_at(uuid4()) is None


def test_a_clock_far_enough_out_reads_as_silence_rather_than_crashing():
    """48 bits of milliseconds reach the year 10889 and a datetime stops at
    9999, so a broken (or hostile) clock must not be able to raise here: this
    runs on the read path of every event."""
    beyond = UUID(int=((1 << 48) - 1) << 80 | (7 << 76) | (0b10 << 62))
    assert minted_at(beyond) is None


def test_minting_stays_inside_the_shape_a_v7_has_to_have():
    ids = [mint() for _ in range(50)]
    assert {id.version for id in ids} == {7}
    assert len(set(ids)) == len(ids)


# -- what the server records ---------------------------------------------------


async def test_the_client_instant_is_not_stored_beside_the_key_that_holds_it(
    api: Api, session: Session, workspace: str
):
    """There is no column for it, and that is the design: the id IS the record.

    Asserting on the table rather than on a response, because the claim is
    about what was stored -- a column added later "for convenience" would make
    two answers to one question, and this is what would notice.
    """
    born = api.transaction()
    entry = await created(api, "a.py", transaction=born)

    row = session.exec(select(MODELS.name).where(MODELS.name.id == UUID(born))).one()
    assert {"minted", "client_time"}.isdisjoint(type(row).model_fields)
    assert minted_at(row.id) is not None
    assert row.entry_id == UUID(entry)


async def test_the_server_stamps_its_own_clock_as_it_applies(
    api: Api, session: Session
):
    before = datetime.now(UTC)
    born = api.transaction()
    await created(api, "a.py", transaction=born)
    after = datetime.now(UTC)

    row = session.exec(select(MODELS.name).where(MODELS.name.id == UUID(born))).one()
    assert before <= row.timestamp <= after


async def test_the_offset_the_client_sent_is_what_is_stored(api: Api, session: Session):
    born = api.transaction()
    await created(api, "a.py", transaction=born, offset=NEPAL)

    row = session.exec(select(MODELS.name).where(MODELS.name.id == UUID(born))).one()
    assert row.utc_offset == NEPAL


async def test_a_client_that_says_nothing_about_its_zone_stores_nothing(
    api: Api, session: Session
):
    born = api.transaction()
    await created(api, "a.py", transaction=born)

    row = session.exec(select(MODELS.name).where(MODELS.name.id == UUID(born))).one()
    assert row.utc_offset is None


@pytest.mark.parametrize("offset", [-24 * 60, 24 * 60, 100_000])
async def test_an_offset_that_cannot_be_a_clock_is_refused(api: Api, offset: int):
    response = await api.create(new_id(), name="a.py", offset=offset)
    assert response.status_code == 422, response.text


# -- what a client is told -----------------------------------------------------


async def test_an_entrys_metadata_carries_both_clocks(api: Api):
    born = api.transaction()
    before = datetime.now(UTC)
    await created(api, "a.py", transaction=born, offset=LOS_ANGELES)

    modified = (await meta(api, await _only_entry(api)))["modified"]

    assert modified["minted"] == minted_at(UUID(born)).isoformat().replace("+00:00", "Z")
    assert modified["offset"] == LOS_ANGELES
    assert when(modified["accepted"]) >= before


async def test_the_mtime_follows_the_newest_change_whichever_property_moved(api: Api):
    file = await created(api, "a.py", offset=BERLIN_IN_SUMMER)
    born = (await meta(api, file))["modified"]

    renaming = api.transaction()
    acknowledged(
        await api.rename(
            file, await name_version(api, file), "b.py",
            transaction=renaming, offset=LOS_ANGELES,
        )
    )

    modified = (await meta(api, file))["modified"]
    assert modified["offset"] == LOS_ANGELES  # the rename's zone, not the create's
    assert when(modified["accepted"]) >= when(born["accepted"])
    assert modified["minted"] == minted_at(UUID(renaming)).isoformat().replace("+00:00", "Z")


async def test_a_write_moves_the_mtime_though_it_moves_nothing_else(api: Api):
    file = await created(api, "a.py", offset=BERLIN_IN_SUMMER)
    before = (await meta(api, file))["modified"]

    writing = api.transaction()
    acknowledged(
        await api.write(
            file, await content_version(api, file), "hello",
            transaction=writing, offset=NEPAL,
        )
    )

    after = (await meta(api, file))["modified"]
    assert after["offset"] == NEPAL
    assert after["minted"] != before["minted"]


async def test_a_tombstoned_entry_keeps_the_time_it_was_deleted(api: Api):
    file = await created(api, "a.py")
    deleting = api.transaction()
    acknowledged(
        await api.delete(file, await seen(api, file), transaction=deleting, offset=NEPAL)
    )

    modified = (await meta(api, file))["modified"]
    assert modified["offset"] == NEPAL


async def test_an_event_carries_when_the_transaction_it_announces_happened(api: Api):
    file = await created(api, "a.py")
    renaming = api.transaction()
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        acknowledged(
            await api.rename(
                file, await name_version(api, file), "b.py",
                transaction=renaming, offset=LOS_ANGELES,
            )
        )
        event = (await heard.until(1))[0]

    assert event["at"]["offset"] == LOS_ANGELES
    assert event["at"]["minted"] == minted_at(UUID(renaming)).isoformat().replace(
        "+00:00", "Z"
    )
    assert when(event["at"]["accepted"]) <= datetime.now(UTC)


async def test_a_create_event_says_the_entry_was_modified_when_it_was_born(api: Api):
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        await created(api, "a.py", offset=BERLIN_IN_SUMMER)
        event = (await heard.until(1))[0]

    assert event["value"]["modified"] == event["at"]


async def test_a_transaction_the_client_did_not_mint_as_a_v7_still_lands(api: Api):
    """The contract prefers a v7 and does not require one. Such a client gets
    an entry, an mtime and a server clock -- it simply says nothing about when
    it acted, which is the truthful answer rather than an invented one."""
    born = minted_elsewhere()
    entry = await created(api, "a.py", transaction=born)

    modified = (await meta(api, entry))["modified"]
    assert "minted" not in modified
    assert when(modified["accepted"]) <= datetime.now(UTC)


async def test_the_rename_the_controller_issues_itself_is_timed_too(api: Api):
    """The one transaction no client minted. It gets a v7 of the server's own,
    so it answers "when" like every other event -- and no offset, because no
    client's clock saw it."""
    await created(api, "notes.md")
    token = (await api.initialize())["token"]
    async with listening(api, token) as heard:
        await created(api, "notes.md")
        events = await heard.until(2)

    settling = events[1]
    assert settling["type"] == "name"
    assert "offset" not in settling["at"]
    assert when(settling["at"]["minted"]) <= when(settling["at"]["accepted"])


# -- the scenario the whole feature exists for ---------------------------------


async def test_an_outbox_filled_in_one_zone_and_replayed_in_another_keeps_both(
    api: Api,
):
    """Somebody works in Los Angeles on Monday and lands in London on Tuesday.

    The outbox they carry is replayed in ONE Initialize by a client that is now
    somewhere else, and each item has to keep the clock its own user was
    reading. That is the whole reason the offset rides on the transaction
    rather than on the connection: a per-connection one would stamp Tuesday's
    zone onto Monday's work.
    """
    monday, tuesday = new_id(), new_id()
    outbox = [
        {"op": "create", "transaction": api.transaction(), "id": monday,
         "type": "file", "name": "monday.py", "parent": None,
         "content": {"type": "text", "content": ""}, "offset": LOS_ANGELES},
        {"op": "create", "transaction": api.transaction(), "id": tuesday,
         "type": "file", "name": "tuesday.py", "parent": None,
         "content": {"type": "text", "content": ""}, "offset": 0},
    ]

    snapshot = await api.initialize(outbox)
    assert len(snapshot["applied"]) == 2

    zones = {entry["name"]: entry["modified"]["offset"] for entry in snapshot["entries"]}
    assert zones == {"monday.py": LOS_ANGELES, "tuesday.py": 0}


async def test_replaying_a_transaction_does_not_restamp_it(api: Api):
    """A retry is free, and that has to include its clocks: the dedup path
    answers with what was recorded rather than recording it again."""
    born = api.transaction()
    entry = new_id()
    acknowledged(await api.create(entry, name="a.py", transaction=born, offset=NEPAL))
    first = (await meta(api, entry))["modified"]

    acknowledged(await api.create(entry, name="a.py", transaction=born, offset=0))
    assert (await meta(api, entry))["modified"] == first


async def _only_entry(api: Api) -> str:
    (entry,) = (await api.initialize())["entries"]
    return entry["id"]
