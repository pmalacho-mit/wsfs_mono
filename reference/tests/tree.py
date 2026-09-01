"""The shape of the tree: naming, nesting, and what a deletion reaches."""

from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from conftest import (
    Api,
    acknowledged,
    created,
    meta,
    new_id,
    parent_version,
    refused,
    seen,
)
from wsfs_suede.samples.backend.app import MODELS
from wsfs_suede.release.backend.tree import Tree

tree = Tree(MODELS)


async def test_a_name_is_only_taken_within_its_own_folder(api: Api):
    first = await created(api, "src", type="folder")
    second = await created(api, "test", type="folder")

    for parent in (first, second, None):
        entry = await created(api, "main.py", parent=parent)
        assert (await meta(api, entry))["name"] == "main.py"


async def test_the_snapshot_carries_every_entry_with_its_parent(api: Api):
    folder = await created(api, "src", type="folder")
    nested = await created(api, "deep", type="folder", parent=folder)
    leaf = await created(api, "a.py", parent=nested)

    entries = {entry["id"]: entry for entry in (await api.initialize())["entries"]}

    assert "parent" not in entries[folder]
    assert entries[nested]["parent"] == folder
    assert entries[leaf]["parent"] == nested


async def test_deleting_a_folder_closes_it_to_new_entries_all_the_way_down(api: Api):
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    acknowledged(await api.delete(outer, await seen(api, outer)))

    # `inner` is not itself a tombstone -- it is merely no longer reachable.
    assert refused(await api.create(new_id(), name="a.py", parent=inner))["reason"] == (
        "parent was deleted"
    )
    assert "deleted" not in await meta(api, inner)


async def test_nothing_may_be_moved_into_an_unreachable_folder(api: Api):
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    loose = await created(api, "a.py")
    acknowledged(await api.delete(outer, await seen(api, outer)))

    reason = refused(
        await api.reparent(loose, await parent_version(api, loose), inner)
    )["reason"]
    assert reason == "the destination was deleted"


async def test_a_lineage_runs_from_the_parent_to_the_root(api: Api, reading: AsyncSession):
    workspace = UUID(api.workspace)
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    leaf = await created(api, "a.py", parent=inner)

    assert (await tree.lineage(reading, workspace, UUID(leaf))).ancestors == (
        UUID(inner),
        UUID(outer),
    )
    assert (await tree.lineage(reading, workspace, UUID(outer))).depth == 0
    assert await tree.descends_from(reading, workspace, UUID(leaf), UUID(outer))
    assert not await tree.descends_from(reading, workspace, UUID(outer), UUID(leaf))


async def test_an_entry_descends_from_itself(api: Api, reading: AsyncSession):
    folder = await created(api, "src", type="folder")
    assert await tree.descends_from(reading, UUID(api.workspace), UUID(folder), UUID(folder))


async def test_a_lineage_reports_a_deletion_anywhere_above_it(
    api: Api, reading: AsyncSession
):
    workspace = UUID(api.workspace)
    outer = await created(api, "outer", type="folder")
    inner = await created(api, "inner", type="folder", parent=outer)
    leaf = await created(api, "a.py", parent=inner)

    assert not (await tree.lineage(reading, workspace, UUID(leaf))).interrupted
    acknowledged(await api.delete(outer, await seen(api, outer)))
    assert (await tree.lineage(reading, workspace, UUID(leaf))).interrupted
