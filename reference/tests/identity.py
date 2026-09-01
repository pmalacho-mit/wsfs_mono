"""Client-minted identity: what a client can now predict, and what it may not."""

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    meta,
    name_version,
    new_id,
    refused,
)


async def test_a_client_knows_the_entrys_id_before_it_asks(api: Api):
    minted = new_id()
    acknowledged(await api.create(minted, name="a.py"))

    assert [entry["id"] for entry in (await api.initialize())["entries"]] == [minted]


async def test_a_create_replayed_after_a_dropped_response_mints_one_entry(api: Api):
    minted, once = new_id(), api.transaction()

    acknowledged(await api.create(minted, name="a.py", transaction=once))
    acknowledged(await api.create(minted, name="a.py", transaction=once))

    assert len((await api.initialize())["entries"]) == 1


async def test_two_clients_racing_one_entry_id_is_loud(api: Api, other: Api):
    contested = new_id()
    acknowledged(await api.create(contested, name="mine.py"))

    assert refused(await other.create(contested, name="theirs.py"))["reason"] == (
        "that id is already in use"
    )


async def test_a_creates_own_transaction_is_the_token_for_every_property(api: Api):
    minted, once = new_id(), api.transaction()
    acknowledged(await api.create(minted, name="a.py", transaction=once))

    entry = await meta(api, minted)
    assert entry["name_version"] == entry["parent_version"] == once
    assert entry["deleted_version"] == entry["content_version"] == once


async def test_a_write_does_not_invalidate_a_concurrent_rename(api: Api, other: Api):
    file = await created(api, "a.py")
    held = await name_version(api, file)
    acknowledged(await other.write(file, await content_version(api, file), "their work"))

    # Under a whole-entry token this was refused as ALREADY_RENAMED, which was
    # never true: the two clients touched different properties.
    acknowledged(await api.rename(file, held, "b.py"))
    assert (await meta(api, file))["name"] == "b.py"


async def test_a_rename_does_not_invalidate_a_concurrent_write(api: Api, other: Api):
    file = await created(api, "a.py")
    acknowledged(await other.rename(file, await name_version(api, file), "b.py"))

    acknowledged(await api.write(file, await content_version(api, file), "my work"))
    assert (await api.content(file)).json()["content"] == "my work"


async def test_a_move_does_not_invalidate_a_concurrent_rename(api: Api, other: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    held = await name_version(api, file)
    acknowledged(await other.reparent(file, (await meta(api, file))["parent_version"], folder))

    acknowledged(await api.rename(file, held, "b.py"))


async def test_a_client_chains_its_own_work_without_asking(api: Api):
    file = await created(api, "a.py")
    first, second, third = api.transaction(), api.transaction(), api.transaction()
    held = await name_version(api, file)

    acknowledged(await api.rename(file, held, "b.py", transaction=first))
    acknowledged(await api.rename(file, first, "c.py", transaction=second))
    acknowledged(await api.rename(file, second, "d.py", transaction=third))

    entry = await meta(api, file)
    assert (entry["name"], entry["name_version"]) == ("d.py", third)


async def test_the_entrys_own_id_is_never_a_property_token(api: Api):
    file = await created(api, "a.py")

    assert refused(await api.rename(file, file, "b.py"))["reason"] == (
        "the version presented was never issued"
    )


async def test_a_transaction_id_is_spent_once(api: Api):
    first = await created(api, "a.py")
    second = await created(api, "b.py")
    once = api.transaction()
    acknowledged(await api.rename(first, await name_version(api, first), "c.py", transaction=once))

    reused = await api.rename(second, await name_version(api, second), "d.py", transaction=once)
    assert refused(reused)["reason"] == "that id is already in use"
    assert (await meta(api, second))["name"] == "b.py"
