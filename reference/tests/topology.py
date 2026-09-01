"""One process per workspace, and what happens when that is violated or lost."""

import asyncio
from uuid import UUID

import pytest

from sqlmodel import Session, func, select

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    name_version,
    new_id,
    open_workspace,
    serving,
)
from wsfs_suede.samples.backend.app import MODELS


async def test_writes_to_one_workspace_are_serialized(api: Api, session: Session):
    await asyncio.gather(
        *(api.create(new_id(), name=f"f{index}.py") for index in range(20))
    )

    positions = sorted(session.exec(select(MODELS.name.position)).all())
    assert positions == list(range(1, 21))


async def test_a_restart_loses_nothing_and_the_stream_picks_up_where_it_left_off(
    processes, tmp_path
):
    deployment = tmp_path / "one-deployment"
    async with serving(processes(blob_root=deployment)) as first:
        workspace = await open_workspace(first)
        api = Api(first, workspace, user="ada@example.com")
        file = await created(api, "a.py")
        acknowledged(await api.write(file, await content_version(api, file), "work"))
        before = await api.initialize()

    # Controller memory is rebuildable from zero: postgres remains the truth.
    async with serving(processes(blob_root=deployment)) as second:
        api = Api(second, workspace, user="ada@example.com")
        after = await api.initialize()
        assert after["entries"] == before["entries"]

        async with listening(api, after["token"]) as heard:
            acknowledged(await api.rename(file, await name_version(api, file), "b.py"))
            assert (await heard.until(1))[0]["value"] == "b.py"

        assert (await api.content(file)).json()["content"] == "work"


async def test_an_idle_controller_is_retired_after_its_grace_period(api: Api, registry):
    await created(api, "a.py")
    workspace = UUID(api.workspace)

    assert registry.live(workspace) is not None
    await asyncio.sleep(0.4)  # grace_seconds is 0.2 in tests
    assert registry.live(workspace) is None


async def test_a_reconnect_within_the_grace_period_finds_the_same_controller(
    api: Api, registry
):
    workspace = UUID(api.workspace)
    async with listening(api, (await api.initialize())["token"]):
        pinned = registry.live(workspace)
        assert registry.count(workspace) == 1

    await asyncio.sleep(0.05)  # inside the grace window
    async with listening(api, (await api.initialize())["token"]):
        assert registry.live(workspace) is pinned


async def test_several_workers_are_refused_unless_someone_says_they_are_pinned(
    monkeypatch, processes, tmp_path
):
    from wsfs_suede.release.backend.main import SHARDING_ACKNOWLEDGED

    monkeypatch.setenv("WEB_CONCURRENCY", "4")
    with pytest.raises(RuntimeError, match="one workspace from several"):
        processes(blob_root=tmp_path / "blobs")

    monkeypatch.setenv(SHARDING_ACKNOWLEDGED, "1")
    assert processes(blob_root=tmp_path / "blobs") is not None


async def test_positions_resume_from_the_logs_when_a_process_goes_away(
    processes, session, tmp_path
):
    """Nothing writes a counter back, so a clean shutdown and a kill -9 leave
    the database in exactly the same state: the next controller reads the
    high-water mark out of the logs and carries on above it."""
    deployment = tmp_path / "one-deployment"
    async with serving(processes(blob_root=deployment)) as first:
        workspace = await open_workspace(first)
        api = Api(first, workspace, user="ada@example.com")
        for index in range(3):
            await created(api, f"f{index}.py")

    async with serving(processes(blob_root=deployment)) as second:
        api = Api(second, workspace, user="ada@example.com")
        await created(api, "after-the-restart.py")

    assert sorted(session.exec(select(MODELS.name.position)).all()) == [1, 2, 3, 4]


async def test_a_controller_is_not_retired_while_a_submission_is_in_flight(
    api: Api, registry
):
    """The controller carries the position counter, so its successor would
    re-seed from rows this submission has not committed yet."""
    workspace = UUID(api.workspace)

    async with registry.visiting(workspace) as controller:
        await asyncio.sleep(0.4)  # longer than grace_seconds
        assert registry.live(workspace) is controller

    await asyncio.sleep(0.4)
    assert registry.live(workspace) is None


async def test_a_position_a_rolled_back_submission_took_is_never_reissued(
    api: Api, registry, session: Session
):
    """A submission that raises has already taken its position, and nothing
    hands it back -- which costs the stream nothing, because positions have to
    increase rather than be dense. What must not happen is the NEXT controller
    reading the logs, seeing only what committed, and handing the same number
    out a second time: a token bound to it would then tell a stream to skip
    the row that finally lands there.
    """
    workspace = UUID(api.workspace)
    await created(api, "a.py")  # position 1
    leaked = registry.live(workspace).positions.take()

    await asyncio.sleep(0.4)  # grace_seconds is 0.2 in tests
    assert registry.live(workspace) is None

    await created(api, "b.py")

    assert sorted(session.exec(select(MODELS.name.position)).all()) == [1, leaked + 1]


async def test_a_stream_token_names_a_position_the_logs_really_carry(
    api: Api, registry, session: Session
):
    """The counter is the next number to hand out; a token is a promise about
    what has already happened. Binding one to the other puts the token above
    the log the moment anything rolls back."""
    await created(api, "a.py")
    registry.live(UUID(api.workspace)).positions.take()  # as a rollback leaves it

    minted = (await api.initialize())["token"]

    tokens = MODELS.token
    stored = session.exec(select(tokens).where(tokens.token == minted)).one()
    highest = session.exec(select(func.max(MODELS.name.position))).one()
    assert stored.position == highest
