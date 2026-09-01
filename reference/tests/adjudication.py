"""Every typed refusal the contract names, and the ones it does not."""

import asyncio

from conftest import (
    Api,
    meta,
    acknowledged,
    content_version,
    created,
    name_version,
    new_id,
    parent_version,
    refused,
    seen,
)


async def test_a_create_needs_a_live_folder_to_land_in(api: Api):
    folder = await created(api, "src", type="folder")
    await api.delete(folder, await seen(api, folder))

    entry = new_id()
    assert refused(await api.create(entry, name="main.py", parent=folder))["reason"] == (
        "parent was deleted"
    )


async def test_a_create_cannot_land_inside_a_file(api: Api):
    file = await created(api, "notes.txt")

    assert refused(await api.create(new_id(), name="nested", parent=file))["reason"] == (
        "that parent is not a folder"
    )


async def test_a_parent_that_never_existed_is_not_a_parent_that_was_deleted(api: Api):
    """With client-minted ids, naming a folder nobody ever created is a
    routine client mistake rather than an impossibility -- and telling that
    client its folder "was deleted" describes a deletion that never happened."""
    assert refused(
        await api.create(new_id(), name="a.py", parent=new_id())
    )["reason"] == "no such parent"


async def test_a_move_into_a_destination_that_never_existed_says_so(api: Api):
    file = await created(api, "a.py")

    refusal = refused(
        await api.reparent(file, await parent_version(api, file), new_id())
    )
    assert refusal["reason"] == "no such destination"


async def test_a_create_colliding_on_name_is_renamed_not_refused(api: Api):
    await created(api, "main.py")
    second = await created(api, "main.py")
    third = await created(api, "main.py")

    names = {entry["id"]: entry["name"] for entry in (await api.initialize())["entries"]}
    assert names[second] == "main (2).py"
    assert names[third] == "main (3).py"


async def test_the_deduping_rename_advances_the_name_token_past_the_create(api: Api):
    await created(api, "main.py")
    entry, born = new_id(), api.transaction()
    acknowledged(await api.create(entry, name="main.py", transaction=born))

    settled = await meta(api, entry)
    assert settled["name"] == "main (2).py"
    assert settled["name_version"] != born
    assert settled["parent_version"] == settled["deleted_version"] == born


async def test_a_dotfile_keeps_its_leading_dot_when_resolved(api: Api):
    await created(api, ".gitignore")
    second = await created(api, ".gitignore")

    names = {entry["id"]: entry["name"] for entry in (await api.initialize())["entries"]}
    assert names[second] == ".gitignore (2)"


async def test_renaming_onto_a_live_sibling_is_refused(api: Api):
    await created(api, "a.py")
    other = await created(api, "b.py")

    reason = refused(await api.rename(other, await name_version(api, other), "a.py"))["reason"]
    assert reason == "entry with name already exists within destination"


async def test_a_deleted_name_is_free_again(api: Api):
    first = await created(api, "main.py")
    acknowledged(await api.delete(first, await seen(api, first)))

    second = await created(api, "main.py")
    names = {entry["id"]: entry["name"] for entry in (await api.initialize())["entries"]}
    assert names[second] == "main.py"


async def test_a_rename_against_a_stale_token_is_refused_with_the_current_one(api: Api):
    file = await created(api, "a.py")
    stale = await name_version(api, file)
    acknowledged(await api.rename(file, stale, "b.py"))

    refusal = refused(await api.rename(file, stale, "c.py"))
    assert refusal["reason"] == "entry was already renamed"
    assert refusal["version"] == await name_version(api, file)


async def test_a_rename_of_a_deleted_entry_is_refused(api: Api):
    file = await created(api, "a.py")
    token = await name_version(api, file)
    acknowledged(await api.delete(file, await seen(api, file)))

    assert refused(await api.rename(file, token, "b.py"))["reason"] == "entry was deleted"


async def test_a_move_into_a_deleted_folder_is_refused(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    acknowledged(await api.delete(folder, await seen(api, folder)))

    reason = refused(await api.reparent(file, await parent_version(api, file), folder))["reason"]
    assert reason == "the destination was deleted"


async def test_a_move_into_the_entrys_own_subtree_is_refused(api: Api):
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    deeper = await created(api, "deeper", type="folder", parent=inner)

    for destination in (outer, inner, deeper):
        refusal = refused(
            await api.reparent(outer, await parent_version(api, outer), destination)
        )
        assert refusal["reason"] == "the destination is inside the entry"


async def test_a_move_that_would_collide_with_a_sibling_is_refused(api: Api):
    folder = await created(api, "src", type="folder")
    await created(api, "a.py", parent=folder)
    loose = await created(api, "a.py")

    reason = refused(
        await api.reparent(loose, await parent_version(api, loose), folder)
    )["reason"]
    assert reason == "entry with name already exists within destination"


async def test_a_move_against_a_stale_token_is_refused(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    stale = await parent_version(api, file)
    acknowledged(await api.reparent(file, stale, folder))

    assert refused(await api.reparent(file, stale, None))["reason"] == (
        "entry had already been moved"
    )


async def test_a_write_against_a_stale_token_names_the_token_it_lost_to(api: Api):
    file = await created(api, "a.py")
    stale = await content_version(api, file)
    acknowledged(await api.write(file, stale, "first"))

    refusal = refused(await api.write(file, stale, "second"))
    assert refusal["reason"] == "content was already updated"
    assert refusal["version"] == await content_version(api, file)


async def test_a_write_to_a_deleted_entry_is_refused_so_the_client_can_park_it(api: Api):
    file = await created(api, "a.py")
    held = await content_version(api, file)
    acknowledged(await api.delete(file, await seen(api, file)))

    assert refused(await api.write(file, held, "work"))["reason"] == "entry was deleted"


async def test_a_folder_holds_no_content(api: Api):
    folder = await created(api, "src", type="folder")

    assert refused(await api.write(folder, new_id(), "not a file"))["reason"] == (
        "content cannot be written to a folder"
    )


async def test_a_write_naming_bytes_that_were_never_stored_is_refused(api: Api):
    file = await created(api, "blob.bin")

    refusal = refused(
        await api.write_blob(
            file, await content_version(api, file),
            hash="0" * 64, size=3, mime="application/x-thing",
        )
    )
    assert refusal["reason"] == "content bytes were never stored"


async def test_deleting_what_is_already_deleted_is_acknowledged(api: Api):
    file = await created(api, "a.py")
    was = await seen(api, file)
    acknowledged(await api.delete(file, was))

    # A second delete achieved what its caller asked for, so there is nothing
    # to refuse -- and the contract has no reason string that would be honest.
    acknowledged(await api.delete(file, was))


async def test_a_stale_delete_names_what_it_would_have_destroyed_unseen(api: Api):
    file = await created(api, "a.py")
    was = await seen(api, file)
    acknowledged(await api.write(file, was["content_version"], "unsaved work"))

    assert refused(await api.delete(file, was))["reason"] == (
        "later versions modified the content of the entry"
    )


async def test_a_stale_delete_reports_a_rename_too(api: Api):
    file = await created(api, "a.py")
    was = await seen(api, file)
    acknowledged(await api.rename(file, was["name_version"], "b.py"))
    acknowledged(await api.write(file, was["content_version"], "work"))

    assert refused(await api.delete(file, was))["reason"] == (
        "later versions modified the content and name of the entry"
    )


async def test_an_unknown_entry_is_not_reported_as_a_deleted_one(api: Api):
    unknown = new_id()

    assert refused(await api.rename(unknown, new_id(), "b.py"))["reason"] == "no such entry"
    assert refused(await api.write(unknown, new_id(), "x"))["reason"] == "no such entry"


async def test_names_that_could_not_be_a_path_segment_are_refused(api: Api):
    file = await created(api, "a.py")
    token = await name_version(api, file)

    for name in ("", ".", "..", "a/b", "a\\b", "a\x00b", " padded ", "x" * 300):
        assert refused(await api.rename(file, token, name))["reason"] == (
            "that name is not permitted"
        ), name


async def test_names_are_normalised_so_two_clients_cannot_disagree_about_one(api: Api):
    composed = "café.py"  # NFC
    decomposed = "café.py"  # NFD -- the same word, as macOS sends it
    await created(api, composed)
    second = await created(api, decomposed)

    names = {entry["id"]: entry["name"] for entry in (await api.initialize())["entries"]}
    assert names[second] == "café (2).py"


async def test_a_token_that_was_never_issued_is_not_an_ordinary_conflict(api: Api):
    file = await created(api, "a.py")

    fabricated = refused(await api.rename(file, new_id(), "b.py"))
    assert fabricated["reason"] == "the version presented was never issued"


async def test_another_entrys_token_does_not_vouch_for_this_one(api: Api):
    file = await created(api, "a.py")
    neighbour = await created(api, "b.py")

    borrowed = await name_version(api, neighbour)
    assert refused(await api.rename(file, borrowed, "c.py"))["reason"] == (
        "the version presented was never issued"
    )


async def test_a_create_naming_bytes_that_were_never_stored_is_refused(api: Api):
    refusal = refused(
        await api.create(
            new_id(),
            name="logo.png",
            content={"type": "binary", "hash": "0" * 64, "size": 3, "mime": "image/png"},
        )
    )
    assert refusal["reason"] == "content bytes were never stored"


async def test_a_file_is_created_with_content_and_a_folder_without(api: Api):
    malformed = [
        {"type": "folder", "name": "src", "content": {"type": "text", "content": "x"}},
        {"type": "file", "name": "a.py", "content": None},
    ]
    for request in malformed:
        response = await api.submit(op="create", id=new_id(), **request)
        assert response.status_code == 422, request


async def test_a_move_changes_where_an_entry_lives_and_what_it_is_called(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    was = await meta(api, file)

    acknowledged(
        await api.move(
            file,
            name="b.py",
            name_version=was["name_version"],
            parent=folder,
            parent_version=was["parent_version"],
        )
    )

    moved = await meta(api, file)
    assert (moved["name"], moved["parent"]) == ("b.py", folder)


async def test_a_move_that_loses_either_race_moves_nothing(api: Api, other: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    was = await meta(api, file)
    acknowledged(await other.rename(file, was["name_version"], "theirs.py"))

    refusal = refused(
        await api.move(
            file,
            name="b.py",
            name_version=was["name_version"],
            parent=folder,
            parent_version=was["parent_version"],
        )
    )

    assert refusal["reason"] == "entry was already renamed"
    still = await meta(api, file)
    assert (still["name"], still.get("parent")) == ("theirs.py", None)


async def test_a_move_into_a_deleted_folder_moves_nothing(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "a.py")
    acknowledged(await api.delete(folder, await seen(api, folder)))
    was = await meta(api, file)

    refusal = refused(
        await api.move(
            file,
            name="b.py",
            name_version=was["name_version"],
            parent=folder,
            parent_version=was["parent_version"],
        )
    )

    assert refusal["reason"] == "the destination was deleted"
    assert (await meta(api, file))["name"] == "a.py"


async def test_a_move_may_not_swallow_its_own_subtree(api: Api):
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    was = await meta(api, outer)

    refusal = refused(
        await api.move(
            outer,
            name="renamed",
            name_version=was["name_version"],
            parent=inner,
            parent_version=was["parent_version"],
        )
    )
    assert refusal["reason"] == "the destination is inside the entry"


async def test_a_write_on_a_token_another_write_replaced_is_refused(api: Api):
    """The compare-and-swap on content, at its plainest.

    Worth stating on its own because the refusal carries the token to rebase
    onto, and a client with nothing to rebase from would rather be told it
    lost than be quietly overwritten.
    """
    file = await created(api, "notes.md")
    token = await content_version(api, file)

    acknowledged(await api.write(file, token, "one"))
    refusal = refused(await api.write(file, token, "two"))

    assert refusal["reason"] == "content was already updated"
    assert refusal["version"] == await content_version(api, file)
    assert (await api.content(file)).json()["content"] == "one"


async def test_two_writes_in_flight_at_once_do_not_both_land(api: Api):
    """Both sent before either is answered, which is what a debounced save
    and an explicit one look like when they arrive together.

    The controller serialises writes, so one has to lose -- and it has to
    lose by being REFUSED. Applying both and keeping whichever arrived last
    would make the outcome depend on scheduling.
    """
    file = await created(api, "racing.md")
    token = await content_version(api, file)

    first, second = await asyncio.gather(
        api.write(file, token, "one"),
        api.write(file, token, "two"),
    )

    assert sorted(response.json()["rejected"] for response in (first, second)) == [
        False,
        True,
    ]
