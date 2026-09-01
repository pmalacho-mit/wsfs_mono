"""Copying one workspace's live tree into another.

Driven IN PROCESS rather than over HTTP, because there is no route to drive:
a clone reads one workspace and writes another, and the host's `authorize`
answers about one workspace at a time. So these call `create_router`'s return
value the way a consumer backend would.

What is being asserted is mostly that a clone is not a special write path. The
target's stream, its name settling, its positions and its blob references are
the ordinary ones -- so the tests below check the ordinary machinery saw the
work, not that a copy appeared.
"""

import asyncio
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from sqlmodel import Session, col, select

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    new_id,
    open_workspace,
    seen,
)
from wsfs_suede.release.backend import service
from wsfs_suede.release.backend.clone import Cloned, reachable
from wsfs_suede.release.backend.contract import Kind, Occurrence, Refusal
from wsfs_suede.release.backend.models import Type
from wsfs_suede.release.backend.tree import Held, Node
from wsfs_suede.samples.backend.app import MODELS, enrolled


@pytest.fixture
def clone(app: FastAPI):
    """The function a consumer backend would hold, off `create_router`."""
    return app.state.mounted.clone


@pytest.fixture
async def elsewhere(instance: httpx.AsyncClient) -> Api:
    """A second workspace, and a client in it. Cloning needs two."""
    return Api(instance, await open_workspace(instance), user="ada@example.com")


@pytest.fixture(autouse=True)
def unwarmed(app: FastAPI):
    """No collaboration server in this suite.

    Warming a room is three calls to a service these tests do not have, so
    every clone here asks for none -- except the one test that is about
    warming, which counts them through this.
    """
    filled: list[str] = []

    async def ensure(entry: str) -> str | None:
        filled.append(entry)
        return None

    app.state.wsfs.keeper.ensure = ensure
    return filled


@pytest.fixture
async def ada(app: FastAPI, api: Api) -> UUID:
    """The host's id for the client these tests clone on behalf of.

    Read out of the host rather than invented. A clone takes a user because
    every create it writes is attributed to one, and NOTHING IN WSFS CHECKS
    THEM -- deciding that is the consumer's, which is the whole reason this is
    not a route.
    """
    async with app.state.wsfs.database.session() as session:
        return (await enrolled(session, api.user)).id


def names(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {entry["name"]: entry for entry in entries if not entry.get("deleted")}


async def a_source_tree(api: Api) -> dict[str, str]:
    """A workspace worth copying: nesting, text, bytes, and two tombstones.

    The tombstones are the point of half of it -- a deleted file, and a live
    file inside a deleted folder, which is the case that is easy to get wrong
    because deleting a folder tombstones the folder and nothing underneath it.
    """
    src = await created(api, "src", type="folder")
    inner = await created(api, "deep", type="folder", parent=src)
    main = await created(
        api, "main.py", parent=src, content={"type": "text", "content": "print(1)"}
    )
    note = await created(
        api, "note.md", parent=inner, content={"type": "text", "content": "# hello"}
    )

    digest = await api.store(b"\x00binary\xff", "application/octet-stream")
    logo = await created(
        api,
        "logo.bin",
        content={
            "type": "binary",
            "hash": digest,
            "size": len(b"\x00binary\xff"),
            "mime": "application/octet-stream",
        },
    )

    gone = await created(api, "gone.txt")
    acknowledged(await api.delete(gone, await seen(api, gone)))

    orphaned = await created(api, "attic", type="folder")
    stranded = await created(api, "stranded.txt", parent=orphaned)
    acknowledged(await api.delete(orphaned, await seen(api, orphaned)))

    return {
        "src": src,
        "deep": inner,
        "main.py": main,
        "note.md": note,
        "logo.bin": logo,
        "gone.txt": gone,
        "attic": orphaned,
        "stranded.txt": stranded,
        "digest": digest,
    }


# -- what arrives ---------------------------------------------------------------------


async def test_copies_the_live_tree_and_leaves_the_unreachable_behind(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    _ = await a_source_tree(api)

    cloned: Cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    assert cloned.complete
    arrived = names((await elsewhere.initialize())["entries"])
    assert set(arrived) == {"src", "deep", "main.py", "note.md", "logo.bin"}

    # The shape, not just the membership: `deep` under `src`, `note.md` under
    # `deep`. A copy that flattened the tree would pass the assertion above.
    assert arrived["deep"]["parent"] == arrived["src"]["id"]
    assert arrived["main.py"]["parent"] == arrived["src"]["id"]
    assert arrived["note.md"]["parent"] == arrived["deep"]["id"]
    assert "parent" not in arrived["logo.bin"] or arrived["logo.bin"]["parent"] is None


async def test_the_copies_are_new_entries(api: Api, elsewhere: Api, clone, ada: UUID):
    source = await a_source_tree(api)

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    """An id is unique across the deployment, so a copy cannot be the
    original -- and the source workspace still holds everything it did."""
    made = {copy.entry for copy in cloned.entries}
    assert made.isdisjoint({UUID(source[name]) for name in ("src", "main.py")})
    assert set(names((await api.initialize())["entries"])) == {
        "src",
        "deep",
        "main.py",
        "note.md",
        "logo.bin",
        "stranded.txt",
    }
    """`stranded.txt` is still in the source: its folder was deleted, not it.
    That it is NOT in the target is the previous test."""


async def test_text_arrives_as_a_first_write(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    await a_source_tree(api)
    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    arrived = names((await elsewhere.initialize())["entries"])
    answer = await elsewhere.content(arrived["main.py"]["id"])
    assert answer.status_code == 200, answer.text
    assert answer.json()["content"] == "print(1)"


async def test_text_is_copied_at_the_write_the_source_had(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """A file with a history copies its CURRENT text, not its first."""
    entry = await created(api, "notes.md", content={"type": "text", "content": "one"})
    acknowledged(await api.write(entry, await content_version(api, entry), "one two three"))

    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    arrived = names((await elsewhere.initialize())["entries"])
    assert (await elsewhere.content(arrived["notes.md"]["id"])).json()["content"] == (
        "one two three"
    )


async def test_bytes_are_referenced_rather_than_copied(
    api: Api, elsewhere: Api, clone, ada: UUID, session: Session
):
    source = await a_source_tree(api)
    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    arrived = names((await elsewhere.initialize())["entries"])
    answer = await elsewhere.content(arrived["logo.bin"]["id"])
    assert answer.status_code == 200, answer.text
    assert answer.content == b"\x00binary\xff"
    assert answer.headers["X-Content-Hash"] == source["digest"]

    """Two writes, one hash. The blob store is content-addressed and shared
    across the deployment, so a clone of a workspace full of large files costs
    rows and nothing else."""
    written = session.exec(
        select(MODELS.blob_content).where(
            col(MODELS.blob_content.hash) == source["digest"]
        )
    ).all()
    assert len(written) == 2

    """And the copy is reachable through the TARGET's blob route, which scopes
    a read to a workspace whose own log names the hash."""
    assert (await elsewhere.blob(source["digest"])).status_code == 200


# -- the trail ------------------------------------------------------------------------


async def test_records_where_every_copy_came_from(
    api: Api, elsewhere: Api, clone, ada: UUID, session: Session
):
    source = await a_source_tree(api)

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    rows = session.exec(select(MODELS.cloned)).all()
    assert len(rows) == len(cloned.entries) == 5
    assert {row.target_entry_id for row in rows} == {
        copy.entry for copy in cloned.entries
    }
    assert {row.source_entry_id for row in rows} == {
        UUID(source[name]) for name in ("src", "deep", "main.py", "note.md", "logo.bin")
    }
    assert all(row.source_workspace_id == UUID(api.workspace) for row in rows)
    assert all(row.target_workspace_id == UUID(elsewhere.workspace) for row in rows)
    assert all(row.user_id == ada for row in rows)

    by_source = {row.source_entry_id: row for row in rows}
    """A folder holds no content and never did, so it names no write. A file
    names the one it was copied at -- which is the only record of the moment
    the copy describes, since the source keeps moving."""
    assert by_source[UUID(source["src"])].source_content_version is None
    assert by_source[UUID(source["main.py"])].source_content_version is not None


async def test_a_second_clone_is_a_second_set_of_rows(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """Cloning is not idempotent, and nothing here pretends it is: asking
    twice makes two copies, and each says where it came from."""
    await created(api, "one.txt")
    twice = [
        await clone(
            source=UUID(api.workspace),
            target=UUID(elsewhere.workspace),
            user=ada,
            warm=False,
        )
        for _ in range(2)
    ]
    assert {copy.entry for copy in twice[0].entries}.isdisjoint(
        {copy.entry for copy in twice[1].entries}
    )
    assert len(names((await elsewhere.initialize())["entries"])) == 2


# -- it is the ordinary write path ----------------------------------------------------


async def test_the_target_stream_announces_ordinary_creates(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """A client watching the target while a clone runs needs to know nothing
    about cloning: it sees creates, and folds them the way it always does."""
    await created(api, "src", type="folder")
    token = (await elsewhere.initialize())["token"]

    async with listening(elsewhere, token) as heard:
        await clone(
            source=UUID(api.workspace),
            target=UUID(elsewhere.workspace),
            user=ada,
            warm=False,
        )
        events = await heard.until(1)

    assert [event["type"] for event in events] == ["create"]
    assert events[0]["value"]["name"] == "src"
    assert events[0]["value"]["type"] == "folder"


async def test_a_colliding_name_settles_the_way_any_create_does(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """The target already holds `main.py`. The copy lands under the name it
    was asked for and the controller renames it, which reaches everybody as an
    ordinary name event -- there is no cloning rule about names."""
    await created(api, "main.py")
    await created(elsewhere, "main.py")

    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    assert set(names((await elsewhere.initialize())["entries"])) == {
        "main.py",
        "main (2).py",
    }


async def test_positions_are_the_target_s_own(
    api: Api, elsewhere: Api, clone, ada: UUID, session: Session
):
    """One workspace's stream, stamped by its own choke point. A clone that
    carried the source's positions over would put numbers in the target's
    sequence that its controller never issued."""
    await created(elsewhere, "already-here.txt")
    await created(api, "one.txt")
    await created(api, "two.txt")

    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    entries = MODELS.entry
    landed = sorted(
        session.exec(
            select(MODELS.name.position)
            .join(entries, col(entries.id) == col(MODELS.name.entry_id))
            .where(col(entries.workspace_id) == UUID(elsewhere.workspace))
        ).all()
    )
    assert landed == [1, 2, 3]


async def test_the_source_gains_nothing(
    api: Api, elsewhere: Api, clone, ada: UUID, session: Session
):
    await a_source_tree(api)
    before = session.exec(select(MODELS.name.id)).all()

    await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    """Every name row that existed before is still there and unchanged -- the
    source was only read."""
    after = session.exec(select(MODELS.name.id)).all()
    assert set(before) <= set(after)
    entries = MODELS.entry
    theirs = session.exec(
        select(MODELS.name.id)
        .join(entries, col(entries.id) == col(MODELS.name.entry_id))
        .where(col(entries.workspace_id) == UUID(api.workspace))
    ).all()
    assert sorted(theirs) == sorted(before)


# -- warming ---------------------------------------------------------------------------


async def test_warms_a_room_for_every_copied_file(
    api: Api, elsewhere: Api, clone, ada: UUID, unwarmed: list[str]
):
    """The path a clone should use: a room filled when the file is made costs
    nobody anything, and a room nobody filled costs the first person to open
    that file a second or two (AUDIT.md, section 2)."""
    await a_source_tree(api)

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=True,
    )

    assert sorted(unwarmed) == sorted(str(entry) for entry in cloned.files)
    """Files only. A folder has no content and no room to hold it."""
    assert len(cloned.files) == 3


async def test_a_room_that_will_not_fill_does_not_undo_the_clone(
    api: Api, elsewhere: Api, clone, ada: UUID, app: FastAPI
):
    """Warming is an optimisation over work that is already committed. A
    collaboration server having a bad minute costs the first open its cold
    price, and nothing else."""

    async def refuses(entry: str) -> str | None:
        raise RuntimeError("the collaboration server is not answering")

    app.state.wsfs.keeper.ensure = refuses
    await created(api, "one.txt")

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=True,
    )

    assert cloned.complete
    assert set(names((await elsewhere.initialize())["entries"])) == {"one.txt"}


# -- a clone the target will not take whole --------------------------------------------


async def test_what_the_target_refuses_is_reported_by_name(
    api: Api, elsewhere: Api, clone, ada: UUID, monkeypatch
):
    """A refusal is about the TARGET -- a folder at its limit, a tree already
    as deep as it may go -- so the files that DID land keep their places and
    the ones that did not are named.

    `MOST_NESTING` is what is squeezed here, because it is the one limit a
    test can reach without ten thousand rows. The SOURCE is built first, at
    the real limit -- a source that could not have been made in the first
    place would be testing nothing.
    """
    outer = await created(api, "outer", type="folder")
    middle = await created(api, "middle", type="folder", parent=outer)
    inner = await created(api, "inner", type="folder", parent=middle)
    deeper = await created(api, "deeper", type="folder", parent=inner)
    leaf = await created(api, "leaf.txt", parent=deeper)

    monkeypatch.setattr(service, "MOST_NESTING", 3)
    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    assert not cloned.complete
    """Everything the source had is in one list or the other. A file in
    neither is one whose absence the caller could not discover."""
    accounted = {copy.source for copy in cloned.entries} | {
        missing.source for missing in cloned.refused
    }
    assert accounted == {
        UUID(entry) for entry in (outer, middle, inner, deeper, leaf)
    }

    missed = {missing.name: missing.reason for missing in cloned.refused}
    assert missed == {"deeper": Refusal.TOO_DEEP, "leaf.txt": Refusal.CREATE_REFUSED}
    """`leaf.txt` was never attempted: its folder is not there to hold it, and
    saying so is not the same as saying the file was itself too deep."""

    assert set(names((await elsewhere.initialize())["entries"])) == {
        "outer",
        "middle",
        "inner",
    }


async def test_a_refused_copy_leaves_no_clone_record(
    api: Api, elsewhere: Api, clone, ada: UUID, session: Session, monkeypatch
):
    """The table says where an entry the target HOLDS came from. A row for a
    file that never arrived would name a target entry that does not exist --
    which the foreign key would refuse anyway."""
    outer = await created(api, "outer", type="folder")
    _ = await created(api, "inner", type="folder", parent=outer)

    monkeypatch.setattr(service, "MOST_NESTING", 1)
    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    rows = session.exec(select(MODELS.cloned)).all()
    assert len(rows) == len(cloned.entries) == 1
    assert rows[0].source_entry_id == UUID(outer)


async def test_a_workspace_can_be_cloned_into_itself(api: Api, clone, ada: UUID):
    """One workspace, one controller, one submission -- so this is a
    duplication in place rather than a second lock to take. The tree is read
    before anything is appended, so the copies are not themselves copied, and
    every copy collides on name and settles like any other create.
    """
    await created(api, "src", type="folder")
    await created(api, "main.py", content={"type": "text", "content": "print(1)"})

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(api.workspace),
        user=ada,
        warm=False,
    )

    assert cloned.complete and len(cloned.entries) == 2
    assert set(names((await api.initialize())["entries"])) == {
        "src",
        "src (2)",
        "main.py",
        "main (2).py",
    }


# -- the walk, on its own --------------------------------------------------------------


def node(entry_id: str, *, parent: str | None, deleted: bool = False) -> Node:
    """One tree node, with only the four things `reachable` reads filled in."""
    occurred = Occurrence(minted=None, offset=None, accepted=None)
    return Node(
        entry=MODELS.entry(id=UUID(entry_id), workspace_id=UUID(entry_id), type=Type.FILE),
        name=entry_id[:8],
        name_version=UUID(entry_id),
        name_position=1,
        parent=None if parent is None else UUID(parent),
        parent_version=UUID(entry_id),
        deleted=deleted,
        deleted_version=UUID(entry_id),
        content=Held(UUID(entry_id), 1, Kind.TEXT, occurred),
        modified=occurred,
    )


def test_reachable_puts_parents_before_children():
    root, middle, leaf = new_id(), new_id(), new_id()
    """Given to the walk child-first, which is what an unordered query gives
    it: nothing about a workspace's rows arrives in tree order."""
    ordered = reachable(
        [
            node(leaf, parent=middle),
            node(middle, parent=root),
            node(root, parent=None),
        ]
    )
    assert [str(found.id) for found in ordered] == [root, middle, leaf]


def test_reachable_drops_a_subtree_under_a_tombstone():
    """Deleting a folder tombstones the folder and not its contents, so the
    subtree is still in the logs -- and copying it would surface, at the root
    of the target, files the source cannot see."""
    root, gone, under = new_id(), new_id(), new_id()
    ordered = reachable(
        [
            node(root, parent=None),
            node(gone, parent=root, deleted=True),
            node(under, parent=gone),
        ]
    )
    assert [str(found.id) for found in ordered] == [root]


def test_reachable_drops_a_child_of_an_entry_that_is_not_there():
    """Ids are client-minted, so an entry can name a parent nobody created."""
    stray = new_id()
    assert reachable([node(stray, parent=new_id())]) == []


def test_reachable_does_not_follow_a_cycle():
    """Nothing in the contract can make one -- a reparent into an entry's own
    subtree is refused -- but a walk that trusts that is a walk that hangs."""
    first, second = new_id(), new_id()
    ordered = reachable([node(first, parent=second), node(second, parent=first)])
    assert ordered == []


# -- a clone big enough to have a shape ------------------------------------------------


async def test_a_deep_tree_arrives_whole(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """Every entry has to be created before anything that names it as a
    parent, and a query returns a workspace's rows in no order at all."""
    parent: str | None = None
    depth = 12
    for level in range(depth):
        parent = await created(api, f"level-{level}", type="folder", parent=parent)
    leaf = await created(
        api, "bottom.txt", parent=parent, content={"type": "text", "content": "deep"}
    )
    assert leaf

    cloned = await clone(
        source=UUID(api.workspace),
        target=UUID(elsewhere.workspace),
        user=ada,
        warm=False,
    )

    assert cloned.complete
    arrived = names((await elsewhere.initialize())["entries"])
    assert len(arrived) == depth + 1
    walked, at = 0, arrived["bottom.txt"]
    by_id = {entry["id"]: entry for entry in arrived.values()}
    while at.get("parent") is not None:
        at = by_id[at["parent"]]
        walked += 1
    assert walked == depth


async def test_clones_run_one_after_another_in_the_target(
    api: Api, elsewhere: Api, clone, ada: UUID
):
    """Two clones into one workspace go through its controller like anything
    else, so neither sees the other half-applied."""
    await created(api, "one.txt")
    await created(api, "two.txt")

    both = await asyncio.gather(
        *(
            clone(
                source=UUID(api.workspace),
                target=UUID(elsewhere.workspace),
                user=ada,
                warm=False,
            )
            for _ in range(2)
        )
    )

    assert all(cloned.complete for cloned in both)
    assert len(names((await elsewhere.initialize())["entries"])) == 4
