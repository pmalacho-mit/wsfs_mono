"""Initialize: the handshake that is also cold start, reconnect and recovery."""

from typing import Any

from sqlmodel import Session, func, select

from conftest import (
    WSFS,
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    meta,
    name_version,
    new_id,
    refused,
    seen,
)
from wsfs_suede.samples.backend.app import MODELS


def creating(api: Api, entry: str, **fields: Any) -> dict[str, Any]:
    return {"op": "create", "transaction": api.transaction(), "id": entry,
            "type": "file", "name": f"entry-{entry[:8]}",
            "content": {"type": "text", "content": ""}, **fields}


async def test_an_empty_outbox_is_a_cheap_no_op(api: Api):
    await created(api, "a.py")

    first = await api.initialize()
    second = await api.initialize()

    assert first["entries"] == second["entries"]
    assert (second["applied"], second["rejected"]) == ([], [])
    assert first["token"] != second["token"]


async def test_tombstones_stay_in_the_snapshot(api: Api):
    file = await created(api, "a.py")
    acknowledged(await api.delete(file, await seen(api, file)))

    assert (await meta(api, file))["deleted"] is True


async def test_a_whole_offline_session_replays_in_order(api: Api):
    entry, born = new_id(), api.transaction()

    snapshot = await api.initialize(
        [
            creating(api, entry, transaction=born),
            {"op": "write", "transaction": api.transaction(),
             "id": entry, "content_version": born, "content": {"type": "text", "content": "offline work"}},
            {"op": "rename", "transaction": api.transaction(), "id": entry,
             "name_version": born, "name": "notes.md"},
        ]
    )

    assert len(snapshot["applied"]) == 3
    assert (await meta(api, entry))["name"] == "notes.md"
    assert (await api.content(entry)).json()["content"] == "offline work"


async def test_a_queued_chain_on_one_property_needs_no_remapping(api: Api):
    file = await created(api, "a.py")
    held = await name_version(api, file)
    first, second = api.transaction(), api.transaction()

    snapshot = await api.initialize(
        [
            {"op": "rename", "transaction": first, "id": file,
             "name_version": held, "name": "b.py"},
            {"op": "rename", "transaction": second, "id": file,
             "name_version": first, "name": "c.py"},
        ]
    )

    assert len(snapshot["applied"]) == 2
    assert (await meta(api, file))["name"] == "c.py"


async def test_a_queued_delete_after_a_queued_rename_still_deletes(api: Api):
    file = await created(api, "a.py")
    was = await seen(api, file)
    renamed = api.transaction()

    snapshot = await api.initialize(
        [
            {"op": "rename", "transaction": renamed, "id": file,
             "name_version": was["name_version"], "name": "b.py"},
            {"op": "delete", "transaction": api.transaction(), "id": file,
             "seen": {**was, "name_version": renamed}},
        ]
    )

    assert len(snapshot["applied"]) == 2
    assert (await meta(api, file))["deleted"] is True


async def test_an_outbox_still_loses_to_somebody_elses_work(api: Api, other: Api):
    file = await created(api, "a.py")
    held = await name_version(api, file)
    acknowledged(await other.rename(file, held, "theirs.py"))

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": api.transaction(), "id": file,
          "name_version": held, "name": "mine.py"}]
    )

    assert snapshot["applied"] == []
    assert snapshot["rejected"][0]["reason"] == "entry was already renamed"


async def test_a_refused_create_does_not_cascade_into_its_dependents(api: Api):
    folder = await created(api, "src", type="folder")
    acknowledged(await api.delete(folder, await seen(api, folder)))
    entry = new_id()
    dependent = api.transaction()

    snapshot = await api.initialize(
        [
            creating(api, entry, parent=folder),
            {"op": "write", "transaction": dependent, "id": entry,
             "content_version": new_id(), "content": {"type": "text", "content": "orphaned"}},
        ]
    )

    assert [rejection["reason"] for rejection in snapshot["rejected"]] == [
        "parent was deleted",
        "the create this depends on was refused",
    ]


async def test_a_refused_create_does_not_cascade_into_a_nested_create(api: Api):
    """The chain holds transitively, and says something true at every rung.

    `Stillborn` shields transactions that NAME a refused entry -- a write, a
    rename -- and a create nested inside one names its own new id instead. So
    it is really adjudicated, and refused for the true reason: it points at a
    folder that was never created. Nothing was created for the rung below to
    point at either, all the way down to the leaf.
    """
    folder = await created(api, "src", type="folder")
    acknowledged(await api.delete(folder, await seen(api, folder)))
    refused_folder, nested_folder, nested_file = new_id(), new_id(), new_id()

    snapshot = await api.initialize(
        [
            creating(api, refused_folder, type="folder", content=None, parent=folder),
            creating(api, nested_folder, type="folder", content=None,
                     parent=refused_folder),
            creating(api, nested_file, parent=nested_folder),
        ]
    )

    assert [rejection["reason"] for rejection in snapshot["rejected"]] == [
        "parent was deleted",
        "no such parent",
        "no such parent",
    ]
    assert snapshot["applied"] == []
    born = {entry["id"] for entry in (await api.initialize())["entries"]}
    assert born.isdisjoint({refused_folder, nested_folder, nested_file})


async def test_a_transaction_id_may_not_be_reused_for_another_operation(api: Api):
    """A create writes name, parent and deletion at one id. A rename reusing
    that id finds its own name row, matching entry and all -- and would be
    acknowledged without renaming anything if dedup only looked at one log."""
    entry, born = new_id(), api.transaction()
    acknowledged(await api.create(entry, name="a.py", transaction=born))

    reused = await api.rename(entry, born, "b.py", transaction=born)

    assert refused(reused)["reason"] == "that id is already in use"
    assert (await meta(api, entry))["name"] == "a.py"


async def test_a_transaction_id_may_not_be_reused_across_disjoint_logs(api: Api):
    """The reverse direction, which a one-sided check cannot see.

    A rename and a write share no log, so looking only at the logs THIS
    request would write finds nothing, calls the id fresh, and applies it --
    no primary key conflict, because the tables differ. The entry ends up with
    two properties whose CAS tokens are the same UUID, and a later honest
    replay of the rename is refused because of it.
    """
    file = await created(api, "a.py")
    renamed = api.transaction()
    acknowledged(await api.rename(file, await name_version(api, file), "b.py", transaction=renamed))

    reused = await api.write(file, await content_version(api, file), "text", transaction=renamed)

    assert refused(reused)["reason"] == "that id is already in use"
    assert (await api.content(file)).json()["content"] == ""
    assert (await meta(api, file))["content_version"] != renamed


async def test_a_replay_is_still_free_after_the_shape_check(api: Api):
    """The check must not cost the thing it protects: an honest replay names
    exactly the logs it wrote, against the entry it wrote them for."""
    file = await created(api, "a.py")
    held = await name_version(api, file)
    replayed = api.transaction()
    acknowledged(await api.rename(file, held, "b.py", transaction=replayed))

    assert acknowledged(await api.rename(file, held, "b.py", transaction=replayed))
    assert (await meta(api, file))["name"] == "b.py"


async def test_a_folder_created_earlier_in_the_outbox_can_be_created_into(api: Api):
    """The first create is judged against a folder that does not exist yet --
    it is judged against nothing, and refused. What must not survive that is
    the ANSWER: the folder arrives two items later, and the create after it
    has to be judged against the folder that is now there."""
    folder, before, after = new_id(), new_id(), new_id()

    snapshot = await api.initialize(
        [
            creating(api, before, parent=folder),
            creating(api, folder, type="folder", content=None),
            creating(api, after, parent=folder),
        ]
    )

    assert [rejection["reason"] for rejection in snapshot["rejected"]] == [
        "no such parent"
    ]
    entries = {entry["id"]: entry for entry in (await api.initialize())["entries"]}
    assert entries[after]["parent"] == folder
    assert before not in entries


async def test_a_folder_deleted_earlier_in_the_outbox_can_no_longer_be_created_into(
    api: Api,
):
    """The other direction: the folder was live when the delete looked at it,
    and must not still be live when the create does."""
    folder = await created(api, "src", type="folder")
    doomed = new_id()

    snapshot = await api.initialize(
        [
            {"op": "delete", "transaction": api.transaction(), "id": folder,
             "seen": await seen(api, folder)},
            creating(api, doomed, parent=folder),
        ]
    )

    assert [rejection["reason"] for rejection in snapshot["rejected"]] == [
        "parent was deleted"
    ]


async def test_work_applied_by_initialize_reaches_the_other_streams(api: Api, other: Api):
    file = await created(api, "a.py")
    token = (await other.initialize())["token"]

    async with listening(other, token) as heard:
        await api.initialize(
            [{"op": "rename", "transaction": api.transaction(), "id": file,
              "name_version": await name_version(api, file), "name": "b.py"}]
        )
        event = (await heard.until(1))[0]

    assert (event["type"], event["value"]) == ("name", "b.py")


async def test_a_transaction_already_applied_is_reported_not_reapplied(
    api: Api, session: Session
):
    file = await created(api, "a.py")
    replayed = api.transaction()
    acknowledged(
        await api.rename(file, await name_version(api, file), "b.py", transaction=replayed)
    )

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": replayed, "id": file,
          "name_version": await name_version(api, file), "name": "b.py"}]
    )

    assert snapshot["applied"] == [replayed]
    assert session.exec(select(func.count()).select_from(MODELS.name)).one() == 2


async def test_a_refused_transaction_writes_nothing(api: Api, session: Session):
    file = await created(api, "a.py")
    held = await content_version(api, file)
    acknowledged(await api.write(file, held, "first"))

    def rows() -> tuple[int, ...]:
        return tuple(
            session.exec(select(func.count()).select_from(table)).one()
            for table in (MODELS.name, MODELS.parent, MODELS.deletion, MODELS.text_content)
        )

    before = rows()
    refused(await api.write(file, held, "second"))
    session.expire_all()

    assert rows() == before


async def test_re_presenting_a_refused_transaction_gives_the_same_reason(api: Api):
    file = await created(api, "a.py")
    held = await content_version(api, file)
    acknowledged(await api.write(file, held, "first"))
    doomed = api.transaction()

    refusals = [
        refused(await api.write(file, held, "second", transaction=doomed))
        for _ in range(3)
    ]

    assert refusals[0] == refusals[1] == refusals[2]
    assert refusals[0]["reason"] == "content was already updated"


async def test_a_refusal_reports_the_token_the_conflict_ux_needs_now(api: Api):
    file = await created(api, "a.py")
    held = await content_version(api, file)
    acknowledged(await api.write(file, held, "first"))
    doomed = api.transaction()
    refused(await api.write(file, held, "second", transaction=doomed))

    acknowledged(await api.write(file, await content_version(api, file), "third"))
    again = refused(await api.write(file, held, "second", transaction=doomed))

    # Not the token it lost to back then -- the one it would lose to now.
    assert again["version"] == await content_version(api, file)


async def test_an_outbox_refusal_is_reported_against_its_transaction(api: Api):
    file = await created(api, "a.py")
    held = await name_version(api, file)
    acknowledged(await api.rename(file, held, "b.py"))
    doomed = api.transaction()

    snapshot = await api.initialize(
        [{"op": "rename", "transaction": doomed, "id": file,
          "name_version": held, "name": "c.py"}]
    )

    assert snapshot["applied"] == []
    assert snapshot["rejected"] == [
        {"transaction": doomed, "reason": "entry was already renamed",
         "version": await name_version(api, file)}
    ]


async def test_an_outbox_cannot_be_unbounded(api: Api):
    response = await api.http.post(
        f"{WSFS}/workspaces/{api.workspace}/initialize",
        json={"outbox": [creating(api, new_id()) for _ in range(10_001)]},
        headers={"X-User-Email": api.user},
    )

    assert response.status_code == 422


async def test_an_unknown_workspace_is_not_found(instance):
    response = await instance.post(
        f"{WSFS}/workspaces/{new_id()}/initialize",
        json={"outbox": []},
        headers={"X-User-Email": "ada@example.com"},
    )
    assert response.status_code == 404


async def test_a_rename_queued_behind_a_colliding_create_settles_it_for_free(
    api: Api, other: Api
):
    """The case deferring the dedupe exists for.

    Offline: create `notes.md`, then type a real name over it. Somebody else
    took `notes.md` meanwhile. Because names settle at the END of the unit of
    work, the queued rename lands first, nothing collides by then, and the
    controller issues no rename at all -- the typed name simply wins.
    """
    await created(other, "notes.md")
    entry, born, typed = new_id(), api.transaction(), api.transaction()
    token = (await api.initialize())["token"]

    async with listening(api, token) as heard:
        snapshot = await api.initialize(
            [
                creating(api, entry, transaction=born, name="notes.md"),
                {"op": "rename", "transaction": typed, "id": entry,
                 "name_version": born, "name": "report.md"},
            ]
        )
        events = await heard.until(2)

    assert snapshot["applied"] == [born, typed]
    assert (await meta(api, entry))["name"] == "report.md"
    assert [event["type"] for event in events] == ["create", "name"]
    assert events[1]["transaction"] == typed  # the client's rename, not the controller's


async def test_a_colliding_create_deleted_in_the_same_outbox_is_never_renamed(
    api: Api, other: Api
):
    await created(other, "notes.md")
    entry, born = new_id(), api.transaction()

    snapshot = await api.initialize(
        [
            creating(api, entry, transaction=born, name="notes.md"),
            {"op": "delete", "transaction": api.transaction(), "id": entry,
             "seen": {"name_version": born, "parent_version": born,
                      "deleted_version": born, "content_version": born}},
        ]
    )

    assert len(snapshot["applied"]) == 2
    assert (await meta(api, entry))["name"] == "notes.md"


async def test_creates_colliding_within_one_outbox_settle_in_the_order_they_arrived(
    api: Api
):
    first, second, third = new_id(), new_id(), new_id()

    await api.initialize(
        [creating(api, entry, name="a.md") for entry in (first, second, third)]
    )

    names = {entry["id"]: entry["name"] for entry in (await api.initialize())["entries"]}
    assert names[first] == "a.md"
    assert names[second] == "a (2).md"
    assert names[third] == "a (3).md"


async def test_a_rename_onto_a_name_a_deferred_create_holds_is_still_refused(
    api: Api, other: Api
):
    """The duplicate-name window is real but never wrong.

    A create only settles away from its name when somebody claimed that name
    first -- and that earlier claimant still holds it afterwards. So a rename
    refused during the window would have been refused after it too.
    """
    held = await created(other, "notes.md")
    loser = await created(api, "other.md")
    entry = new_id()

    snapshot = await api.initialize(
        [
            creating(api, entry, name="notes.md"),
            {"op": "rename", "transaction": api.transaction(), "id": loser,
             "name_version": await name_version(api, loser), "name": "notes.md"},
        ]
    )

    assert snapshot["rejected"][0]["reason"] == (
        "entry with name already exists within destination"
    )
    assert (await meta(api, held))["name"] == "notes.md"
    assert (await meta(api, entry))["name"] == "notes (2).md"
