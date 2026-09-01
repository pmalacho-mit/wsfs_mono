"""Opening a workspace, and who is allowed to say so."""

import httpx

from conftest import WSFS, Api, acknowledged, content_version, created, open_workspace


async def test_a_workspace_starts_empty_and_is_addressable_by_its_id(
    instance: httpx.AsyncClient,
):
    api = Api(instance, await open_workspace(instance), user="ada@example.com")

    assert (await api.initialize())["entries"] == []


async def test_workspaces_do_not_see_each_other(instance: httpx.AsyncClient, api: Api):
    await created(api, "mine.py")
    neighbour = Api(instance, await open_workspace(instance), user="ada@example.com")

    assert (await neighbour.initialize())["entries"] == []


async def test_a_request_must_say_who_is_making_it(
    instance: httpx.AsyncClient, workspace: str
):
    response = await instance.post(f"{WSFS}/workspaces/{workspace}/initialize", json={"outbox": []})

    assert response.status_code == 422


async def test_a_tree_is_built_from_creates_and_read_back_whole(api: Api):
    folder = await created(api, "src", type="folder")
    file = await created(api, "main.py", parent=folder)

    tree = {entry["name"]: entry for entry in (await api.initialize())["entries"]}

    assert tree["src"]["type"] == "folder"
    assert "parent" not in tree["src"]
    assert tree["main.py"]["id"] == file
    assert tree["main.py"]["parent"] == folder


async def test_a_write_is_readable_at_the_token_it_produced(api: Api):
    file = await created(api, "main.py")
    acknowledged(await api.write(file, await content_version(api, file), "print('hi')"))

    assert (await api.content(file)).json() == {
        "type": "text",
        "content": "print('hi')",
        "version": await content_version(api, file),
    }


async def test_two_users_share_one_workspace(api: Api, other: Api):
    file = await created(api, "shared.py")
    acknowledged(await other.write(file, await content_version(api, file), "theirs"))

    assert (await api.content(file)).json()["content"] == "theirs"


async def test_a_host_without_a_liveblocks_key_says_so_rather_than_failing_oddly(
    instance,
    monkeypatch,
):
    """The sample's own route, not wsfs's -- but a host that quietly returned a
    broken token would send every client into a retry loop against a room they
    can never enter, which is much harder to read than a 503.

    The absence is MADE here rather than assumed: the suite runs with a key
    set, because the sample host refuses to be built without one, and a test
    about not having one has to arrange not to have one.
    """
    monkeypatch.delenv("LIVEBLOCKS_SECRET_KEY", raising=False)
    answer = await instance.get(
        "/liveblocks/token?rooms=any",
        headers={"X-User-Email": "ada@example.com"},
    )
    assert answer.status_code == 503
    assert "without a Liveblocks key" in answer.text
