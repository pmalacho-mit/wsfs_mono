"""The room routes, over HTTP, against a collaboration service that is real.

CONFORMANCE.md section O, from the outside. `rooms.py` proves the rules and
`keeper.py` proves the keeper against a fake; this proves the whole of it
through the routes a browser calls, with a service that actually merges Yjs
updates -- and with no API key anywhere, which is the property that makes every
room test an ordinary test.
"""

import pytest
from pycrdt import Doc, Text

from conftest import Api, acknowledged, created, new_id, serving
from wsfs_mono.wsfs_core_suede.backend.collaboration import InProcessCollaboration


@pytest.fixture
def collaboration() -> InProcessCollaboration:
    return InProcessCollaboration()


@pytest.fixture
async def api(processes, collaboration):
    """One client, onto a host whose rooms this test can read directly."""
    app = processes(collaboration=collaboration)
    async with serving(app) as http:
        answer = await http.post("/projects")
        yield Api(http, answer.json()["id"], user="ada@example.com")


def reading(update: bytes) -> str:
    """A browser's view of an update, through the name the client uses."""
    doc = Doc()
    doc["content"] = Text()
    if update:
        doc.apply_update(update)
    return str(doc["content"])


def typing(into: str, text: str) -> bytes:
    """What a member holding this document would hand over."""
    doc = Doc()
    doc["content"] = Text()
    if into:
        doc.apply_update(into)
    was = doc.get_state()
    doc["content"] += text
    return doc.get_update(was)


async def bring_room_up_to_file(api: Api, entry: str) -> dict:
    answer = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/rooms/{entry}",
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


async def a_file(api: Api, content: str) -> str:
    entry = new_id()
    acknowledged(
        await api.create(
            entry, name=f"{entry}.py", content={"type": "text", "content": content}
        )
    )
    return entry


async def test_settling_a_room_fills_it_from_the_file(api, collaboration):
    entry = await a_file(api, "print(1)\n")
    standing = await bring_room_up_to_file(api, entry)
    assert standing["base"] is not None
    assert reading(await collaboration.document(entry)) == "print(1)\n"


async def test_an_empty_file_is_not_reseeded(api, collaboration):
    """O1, and the reason `document` must answer empty rather than raise: an
    empty file's room holds nothing, and a host that read that as "no room"
    would seed it again on every visit."""
    entry = await a_file(api, "")
    first = await bring_room_up_to_file(api, entry)
    second = await bring_room_up_to_file(api, entry)
    assert first["base"] == second["base"]
    assert reading(await collaboration.document(entry)) == ""


async def test_a_room_already_where_the_file_stands_is_left_alone(api, collaboration):
    entry = await a_file(api, "one\n")
    await bring_room_up_to_file(api, entry)
    filled = await collaboration.document(entry)
    await bring_room_up_to_file(api, entry)
    assert reading(await collaboration.document(entry)) == reading(filled)


async def test_a_write_a_member_made_is_told_rather_than_carried(api, collaboration):
    """The room already holds the text, so what changes is only where this
    host believes it stands. Carrying it in again would say it twice."""
    entry = await a_file(api, "one\n")
    await bring_room_up_to_file(api, entry)
    version = api.transaction()
    acknowledged(
        await api.write(
            entry, (await bring_room_up_to_file(api, entry))["base"], "one\ntwo\n", transaction=version
        )
    )
    await collaboration.send(entry, typing(await collaboration.document(entry), "two\n"))

    told = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/rooms/{entry}/stored",
        json={"version": version},
        headers={"X-User-Email": api.user},
    )
    assert told.status_code == 204, told.text
    assert reading(await collaboration.document(entry)) == "one\ntwo\n"
    assert (await bring_room_up_to_file(api, entry))["base"] == version


async def test_a_client_that_cannot_reach_the_room_hands_its_update_over(
    api, collaboration
):
    """The one thing a client cannot do for itself. Losing the connection to
    the collaboration server should cost the direct route to everybody else,
    not everybody else."""
    entry = await a_file(api, "one\n")
    await bring_room_up_to_file(api, entry)
    update = typing(await collaboration.document(entry), "handed over\n")

    answer = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/rooms/{entry}/updates",
        content=update,
        headers={
            "Content-Type": "application/octet-stream",
            "X-User-Email": api.user,
        },
    )
    assert answer.status_code == 204, answer.text
    assert "handed over" in reading(await collaboration.document(entry))


async def test_a_file_that_is_not_text_gets_no_room(api, collaboration):
    """`base` is null for a file a room cannot hold, and nothing is created."""
    entry = new_id()
    digest = await api.store(b"\x89PNG\r\n\x1a\n")
    acknowledged(
        await api.create(
            entry,
            name="picture.png",
            content={
                "type": "binary",
                "hash": digest,
                "size": 8,
                "mime": "image/png",
            },
        )
    )
    assert (await bring_room_up_to_file(api, entry))["base"] is None
    assert await collaboration.document(entry) == b""
