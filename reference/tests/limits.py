"""Bounds on what a client can mint offline and flush in one go."""

import pytest

from conftest import Api, acknowledged, created, new_id, parent_version, refused
from wsfs_suede.release.backend import service


@pytest.fixture
def shallow(monkeypatch):
    monkeypatch.setattr(service, "MOST_NESTING", 3)


@pytest.fixture
def cramped(monkeypatch):
    monkeypatch.setattr(service, "MOST_SIBLINGS", 2)


async def test_the_tree_may_not_nest_without_end(api: Api, shallow):  # pyright: ignore[reportUnusedParameter]
    at = None
    for _ in range(service.MOST_NESTING):
        at = await created(api, "down", type="folder", parent=at)

    assert refused(await api.create(new_id(), name="deeper", parent=at))["reason"] == (
        "that destination is nested too deeply"
    )


async def test_a_move_may_not_nest_without_end(api: Api, shallow):  # pyright: ignore[reportUnusedParameter]
    at = None
    for _ in range(service.MOST_NESTING):
        at = await created(api, "down", type="folder", parent=at)
    loose = await created(api, "a.py")

    assert refused(
        await api.reparent(loose, await parent_version(api, loose), at)
    )["reason"] == "that destination is nested too deeply"


async def test_a_folder_may_not_hold_without_end(api: Api, cramped):  # pyright: ignore[reportUnusedParameter]
    folder = await created(api, "src", type="folder")
    for index in range(service.MOST_SIBLINGS):
        await created(api, f"f{index}.py", parent=folder)

    assert refused(await api.create(new_id(), name="one-too-many", parent=folder))[
        "reason"
    ] == "that folder already holds too many entries"


async def test_a_deleted_sibling_frees_room_again(api: Api, cramped):  # pyright: ignore[reportUnusedParameter]
    from conftest import seen

    folder = await created(api, "src", type="folder")
    doomed = await created(api, "a.py", parent=folder)
    await created(api, "b.py", parent=folder)
    acknowledged(await api.delete(doomed, await seen(api, doomed)))

    assert acknowledged(await api.create(new_id(), name="c.py", parent=folder))
