"""Making a workspace hold these files, at these paths, with this text.

Driven IN PROCESS, like the clone suite and for a related reason: there is no
route to drive. What is being asserted is that this is a convenience over the
ordinary write path rather than a way around it -- so the tests below check
the ordinary machinery (the stream, the tokens, the tree) saw exactly the work
that was needed, and NOTHING when nothing was.
"""

from uuid import UUID

import pytest
from fastapi import FastAPI
from sqlmodel import Session, col, func, select

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    meta,
    seen,
)
from wsfs_suede.release.backend import service
from wsfs_suede.release.backend.contract import Refusal
from wsfs_suede.release.backend.place import (
    Change,
    Placed,
    Unusable,
    folders_of,
    held_paths,
    parsed,
    segments,
)
from wsfs_suede.samples.backend.app import MODELS


@pytest.fixture
def place(app: FastAPI):
    """The function a consumer backend would hold, off `create_router`."""
    return app.state.mounted.place


@pytest.fixture(autouse=True)
def unwarmed(app: FastAPI):
    """No collaboration server in this suite -- see `tests/clone.py`."""
    settled: list[str] = []

    async def ensure(entry: str) -> str | None:
        settled.append(entry)
        return None

    app.state.wsfs.keeper.ensure = ensure
    return settled


@pytest.fixture
async def ada(app: FastAPI, api: Api) -> UUID:
    from wsfs_suede.samples.backend.app import enrolled

    async with app.state.wsfs.database.session() as session:
        return (await enrolled(session, api.user)).id


async def laid_out(api: Api) -> dict[str, str]:
    """Every live entry's path, read back through the ordinary metadata.

    Rebuilt from `parent` links rather than trusted from the return value, so
    a test that asserts on a path is asserting on the TREE and not on this
    function's own account of what it did.
    """
    entries = {
        entry["id"]: entry
        for entry in (await api.initialize())["entries"]
        if not entry.get("deleted")
    }
    paths: dict[str, str] = {}
    for entry_id, entry in entries.items():
        parts, at = [entry["name"]], entry.get("parent")
        while at is not None and at in entries:
            parts.append(entries[at]["name"])
            at = entries[at].get("parent")
        paths["/".join(reversed(parts))] = entry_id
    return paths


async def text_at(api: Api, entry_id: str) -> str:
    answer = await api.content(entry_id)
    assert answer.status_code == 200, answer.text
    return answer.json()["content"]


# -- putting files somewhere ------------------------------------------------------------


async def test_creates_the_files_and_the_folders_they_need(
    api: Api, place, ada: UUID
):
    placed: Placed = await place(
        workspace=UUID(api.workspace),
        files={
            "README.md": "# hello",
            "src/main.py": "print(1)",
            "src/deep/notes.txt": "kept",
        },
        user=ada,
        warm=False,
    )

    assert placed.complete
    assert set(await laid_out(api)) == {
        "README.md",
        "src",
        "src/main.py",
        "src/deep",
        "src/deep/notes.txt",
    }
    """The folders were never asked for by name -- they are what the paths
    needed, and they arrive as ordinary folders."""
    assert {entry.path for entry in placed.created} == {
        "README.md",
        "src",
        "src/main.py",
        "src/deep",
        "src/deep/notes.txt",
    }

    at = await laid_out(api)
    assert await text_at(api, at["src/main.py"]) == "print(1)"
    assert await text_at(api, at["src/deep/notes.txt"]) == "kept"


async def test_a_leading_slash_is_the_same_path(api: Api, place, ada: UUID):
    """`/src/main.py` and `src/main.py` plainly mean the same file, and there
    is no other file they could mean."""
    await place(
        workspace=UUID(api.workspace),
        files={"/src/main.py": "one"},
        user=ada,
        warm=False,
    )
    placed = await place(
        workspace=UUID(api.workspace),
        files={"src/main.py": "one"},
        user=ada,
        warm=False,
    )
    assert [entry.change for entry in placed.entries] == [Change.UNCHANGED]
    assert set(await laid_out(api)) == {"src", "src/main.py"}


# -- calling it twice --------------------------------------------------------------------


async def test_the_same_call_twice_writes_nothing_the_second_time(
    api: Api, place, ada: UUID, session: Session
):
    """The whole claim to being safe to run repeatedly. Not "it converges" --
    the second call takes no position, writes no row and announces no event,
    so a client with the file open does not see it flicker."""
    files = {"README.md": "# hello", "src/main.py": "print(1)"}
    kwargs = dict(workspace=UUID(api.workspace), user=ada, warm=False)

    def rows() -> int:
        """Name rows, which every create writes exactly one of."""
        return session.exec(select(func.count()).select_from(MODELS.name)).one()

    first = await place(files=files, **kwargs)
    after_first = rows()

    second = await place(files=files, **kwargs)

    assert len(first.created) == 3 and not first.unchanged
    assert {entry.path for entry in second.unchanged} == {"README.md", "src/main.py"}
    assert not second.created and not second.written
    assert rows() == after_first


async def test_changed_text_is_an_ordinary_write(api: Api, place, ada: UUID):
    kwargs = dict(workspace=UUID(api.workspace), user=ada, warm=False)
    await place(files={"notes.md": "one"}, **kwargs)
    before = (await laid_out(api))["notes.md"]
    was = await content_version(api, before)

    placed = await place(files={"notes.md": "one two"}, **kwargs)

    assert [entry.path for entry in placed.written] == ["notes.md"]
    """The SAME entry, written -- not a second file beside the first. Its
    content token moved, which is what every other client rebases onto."""
    assert (await laid_out(api))["notes.md"] == before
    assert await content_version(api, before) != was
    assert await text_at(api, before) == "one two"


async def test_it_writes_over_what_a_person_typed(api: Api, place, ada: UUID):
    """A placement presents no token, so it cannot lose a race -- it is a host
    saying "make it so". That is exactly why it is not on the wire."""
    entry = await created(api, "notes.md", content={"type": "text", "content": "mine"})
    acknowledged(await api.write(entry, await content_version(api, entry), "theirs"))

    placed = await place(
        workspace=UUID(api.workspace),
        files={"notes.md": "the host's"},
        user=ada,
        warm=False,
    )

    assert [entry.path for entry in placed.written] == ["notes.md"]
    assert await text_at(api, entry) == "the host's"


async def test_an_existing_folder_is_used_rather_than_doubled(
    api: Api, place, ada: UUID
):
    """A path names the folder that is there. Creating a second `src` beside
    it -- which is what a bare create would do, settling the name to
    `src (2)` -- would be a placement that could never be called twice."""
    folder = await created(api, "src", type="folder")

    await place(
        workspace=UUID(api.workspace),
        files={"src/main.py": "print(1)"},
        user=ada,
        warm=False,
    )

    at = await laid_out(api)
    assert set(at) == {"src", "src/main.py"}
    assert at["src"] == folder


async def test_a_deleted_folder_is_not_the_folder_a_path_means(
    api: Api, place, ada: UUID
):
    """Deleting a folder tombstones the folder and not its contents, so the
    old subtree is still in the logs. A caller naming `attic/notes.md` means
    the folder it can SEE, so a fresh one is made."""
    gone = await created(api, "attic", type="folder")
    acknowledged(await api.delete(gone, await seen(api, gone)))

    await place(
        workspace=UUID(api.workspace),
        files={"attic/notes.md": "new"},
        user=ada,
        warm=False,
    )

    at = await laid_out(api)
    assert set(at) == {"attic", "attic/notes.md"}
    assert at["attic"] != gone


# -- what the workspace will not have ----------------------------------------------------


async def test_a_file_in_the_way_of_a_folder_is_reported_by_path(
    api: Api, place, ada: UUID
):
    """`src` is already a file, so nothing can go under it. The paths that
    needed it are refused BY NAME, and everything else still lands."""
    await created(api, "src", content={"type": "text", "content": "not a folder"})

    placed = await place(
        workspace=UUID(api.workspace),
        files={"src/main.py": "print(1)", "README.md": "# hello"},
        user=ada,
        warm=False,
    )

    assert not placed.complete
    assert [(gone.path, gone.reason) for gone in placed.refused] == [
        ("src/main.py", Refusal.PARENT_NOT_A_FOLDER)
    ]
    assert [entry.path for entry in placed.created] == ["README.md"]
    assert set(await laid_out(api)) == {"src", "README.md"}


async def test_a_folder_in_the_way_of_a_file_is_reported_by_path(
    api: Api, place, ada: UUID
):
    await created(api, "notes", type="folder")

    placed = await place(
        workspace=UUID(api.workspace),
        files={"notes": "text"},
        user=ada,
        warm=False,
    )

    assert [(gone.path, gone.reason) for gone in placed.refused] == [
        ("notes", Refusal.NOT_A_FILE)
    ]
    assert not placed.entries


async def test_a_refused_folder_takes_its_files_with_it(
    api: Api, place, ada: UUID, monkeypatch
):
    """One real failure, not one per file underneath it -- and the files say
    the create they DEPENDED ON was refused rather than repeating the folder's
    own complaint as though it were theirs. `a/b` is too deep; `a/b/c.txt` is
    not too deep, it is merely homeless."""
    monkeypatch.setattr(service, "MOST_NESTING", 1)

    placed = await place(
        workspace=UUID(api.workspace),
        files={"a/b/c.txt": "deep", "a/b/d.txt": "also deep", "top.txt": "fine"},
        user=ada,
        warm=False,
    )

    assert {(gone.path, gone.reason) for gone in placed.refused} == {
        ("a/b/c.txt", Refusal.CREATE_REFUSED),
        ("a/b/d.txt", Refusal.CREATE_REFUSED),
    }
    assert set(await laid_out(api)) == {"a", "top.txt"}


async def test_a_file_the_workspace_declines_says_why(
    api: Api, place, ada: UUID, monkeypatch
):
    """Its OWN reason, not its folder's. The folders here are fine -- it is
    the file at the bottom of them that is one rung too far down, and a
    caller reading this is reading it to find that out."""
    monkeypatch.setattr(service, "MOST_NESTING", 2)

    placed = await place(
        workspace=UUID(api.workspace),
        files={"a/b/c.txt": "deep", "top.txt": "fine"},
        user=ada,
        warm=False,
    )

    assert [(gone.path, gone.reason) for gone in placed.refused] == [
        ("a/b/c.txt", Refusal.TOO_DEEP)
    ]
    assert set(await laid_out(api)) == {"a", "a/b", "top.txt"}


# -- pruning ------------------------------------------------------------------------------


async def test_prune_deletes_what_the_paths_did_not_name(api: Api, place, ada: UUID):
    stale = await created(api, "old.txt", content={"type": "text", "content": "gone"})
    folder = await created(api, "attic", type="folder")
    inside = await created(api, "inside.txt", parent=folder)
    assert inside

    placed = await place(
        workspace=UUID(api.workspace),
        files={"README.md": "# hello"},
        user=ada,
        prune=True,
        warm=False,
    )

    assert placed.complete
    assert set(await laid_out(api)) == {"README.md"}
    assert {entry.path for entry in placed.deleted} == {
        "old.txt",
        "attic",
        "attic/inside.txt",
    }
    """A tombstone, not an erasure -- reconciliation depends on those, so an
    offline client learns the file went rather than that it never was."""
    assert (await meta(api, stale))["deleted"] is True


async def test_prune_keeps_the_folders_the_paths_need(api: Api, place, ada: UUID):
    """A folder a wanted path lives in is named by that path, so it is kept.
    Deleting it because nobody asked for it BY NAME would empty the very tree
    being built."""
    await place(
        workspace=UUID(api.workspace),
        files={"src/deep/main.py": "print(1)", "spare.txt": "x"},
        user=ada,
        warm=False,
    )

    placed = await place(
        workspace=UUID(api.workspace),
        files={"src/deep/main.py": "print(1)"},
        user=ada,
        prune=True,
        warm=False,
    )

    assert set(await laid_out(api)) == {"src", "src/deep", "src/deep/main.py"}
    assert [entry.path for entry in placed.deleted] == ["spare.txt"]
    assert [entry.path for entry in placed.unchanged] == ["src/deep/main.py"]


async def test_prune_with_nothing_wanted_empties_the_workspace(
    api: Api, place, ada: UUID
):
    """"Make it look like this" where "this" is nothing. Legitimate, and the
    one call worth being sure does what it says."""
    await created(api, "one.txt")
    await created(api, "two.txt")

    placed = await place(
        workspace=UUID(api.workspace), files={}, user=ada, prune=True, warm=False
    )

    assert len(placed.deleted) == 2
    assert await laid_out(api) == {}


async def test_without_prune_nothing_is_deleted(api: Api, place, ada: UUID):
    """The default, and the reason it is the default."""
    await created(api, "keep.txt")

    placed = await place(
        workspace=UUID(api.workspace),
        files={"README.md": "# hello"},
        user=ada,
        warm=False,
    )

    assert not placed.deleted
    assert set(await laid_out(api)) == {"keep.txt", "README.md"}


# -- it is the ordinary write path --------------------------------------------------------


async def test_the_stream_announces_ordinary_events(api: Api, place, ada: UUID):
    """A client watching while this runs needs to know nothing about
    placements: it sees creates and writes, and folds them as it always does."""
    token = (await api.initialize())["token"]

    async with listening(api, token) as heard:
        await place(
            workspace=UUID(api.workspace),
            files={"src/main.py": "print(1)"},
            user=ada,
            warm=False,
        )
        events = await heard.until(2)

    assert [event["type"] for event in events] == ["create", "create"]
    assert [event["value"]["name"] for event in events] == ["src", "main.py"]


async def test_positions_are_the_workspace_s_own(
    api: Api, place, ada: UUID, session: Session
):
    await place(
        workspace=UUID(api.workspace),
        files={"src/main.py": "print(1)"},
        user=ada,
        warm=False,
    )

    entries = MODELS.entry
    landed = sorted(
        session.exec(
            select(MODELS.name.position)
            .join(entries, col(entries.id) == col(MODELS.name.entry_id))
            .where(col(entries.workspace_id) == UUID(api.workspace))
        ).all()
    )
    assert landed == [1, 2]


async def test_settles_the_room_of_every_file_it_moved(
    api: Api, place, ada: UUID, unwarmed: list[str]
):
    """Created AND written, and NOT unchanged. A room that already exists has
    to be told the file changed under it; a file nothing moved has nothing to
    say."""
    kwargs = dict(workspace=UUID(api.workspace), user=ada)
    await place(files={"a.txt": "one", "b.txt": "one"}, warm=False, **kwargs)
    unwarmed.clear()

    placed = await place(files={"a.txt": "two", "b.txt": "one"}, warm=True, **kwargs)

    assert [entry.path for entry in placed.written] == ["a.txt"]
    assert unwarmed == [str(placed.written[0].entry)]


# -- a call that cannot be satisfied at all ------------------------------------------------


async def test_an_impossible_call_raises_before_writing_anything(
    api: Api, place, ada: UUID
):
    """A path asked to be both a file and the folder above one. Reporting it
    would mean half-applying a call that describes no workspace, so it raises
    -- and it raises before the controller is taken, so `keep.txt` is
    untouched rather than written and then complained about."""
    await created(api, "keep.txt")

    with pytest.raises(Unusable):
        await place(
            workspace=UUID(api.workspace),
            files={"a": "a file", "a/b.txt": "under it", "keep.txt": "rewritten"},
            user=ada,
            warm=False,
        )

    assert set(await laid_out(api)) == {"keep.txt"}
    assert await text_at(api, (await laid_out(api))["keep.txt"]) == ""


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/",
        "src//main.py",
        "src/../main.py",
        "src/./main.py",
        "bad\x00name.txt",
        "back\\slash.txt",
        " untrimmed.txt",
    ],
)
def test_a_path_that_cannot_be_a_path(path: str):
    """A path segment and an entry name are the same thing, and `service`
    holds the one definition of what a name may be."""
    with pytest.raises(Unusable):
        _ = segments(path)


def test_one_path_spelled_two_ways_is_a_call_that_says_two_things():
    with pytest.raises(Unusable):
        _ = parsed({"src/main.py": "one", "/src/main.py": "two"})


NFC = "caf\u00e9"
"""`caf\u00e9` with a precomposed e-acute -- one codepoint, what a Linux client sends."""

NFD = "cafe\u0301"
"""The same word as `e` plus a combining acute -- two codepoints, what macOS sends."""


def test_paths_are_normalised_the_way_a_name_arriving_over_the_wire_is():
    """A macOS caller's NFD and a Linux caller's NFC have to find the same
    folder, and this is the only place that sees both spellings.

    Written as ESCAPES rather than as literals. The two spellings look
    identical in a source file, so a reader cannot tell this test from one
    that compares a string to itself -- and neither could the person who
    breaks it.
    """
    assert NFC != NFD
    assert segments(f"{NFD}/notes.md") == segments(f"{NFC}/notes.md")
    assert segments(f"{NFD}/notes.md") == (NFC, "notes.md")


def test_folders_are_ordered_shallowest_first():
    """Not tidiness: a folder cannot be created before the folder it goes in."""
    wanted = [("a", "b", "c", "d.txt"), ("a", "e.txt"), ("a", "b", "f.txt")]
    assert folders_of(wanted) == [("a",), ("a", "b"), ("a", "b", "c")]


# -- the walk, on its own ------------------------------------------------------------------


def node(name: str, *, parent: UUID | None, deleted: bool = False):
    from wsfs_suede.release.backend.contract import Kind, Occurrence
    from wsfs_suede.release.backend.minted import mint
    from wsfs_suede.release.backend.models import Type
    from wsfs_suede.release.backend.tree import Held, Node

    entry_id = mint()
    occurred = Occurrence(minted=None, offset=None, accepted=None)
    return Node(
        entry=MODELS.entry(id=entry_id, workspace_id=entry_id, type=Type.FILE),
        name=name,
        name_version=entry_id,
        name_position=1,
        parent=parent,
        parent_version=entry_id,
        deleted=deleted,
        deleted_version=entry_id,
        content=Held(entry_id, 1, Kind.TEXT, occurred),
        modified=occurred,
    )


def test_held_paths_walks_down_from_the_root():
    root = node("src", parent=None)
    inner = node("deep", parent=root.id)
    leaf = node("notes.md", parent=inner.id)
    """Given in no order at all, which is what an unordered query gives it."""
    walked = held_paths([leaf, root, inner])
    assert walked == {
        ("src",): root,
        ("src", "deep"): inner,
        ("src", "deep", "notes.md"): leaf,
    }


def test_held_paths_never_reaches_below_a_tombstone():
    """An entry under a deleted folder is still in the logs and has no path --
    which is what makes a fresh folder the right answer for that name."""
    gone = node("attic", parent=None, deleted=True)
    inside = node("notes.md", parent=gone.id)
    assert held_paths([gone, inside]) == {}


def test_held_paths_ignores_an_entry_whose_parent_is_not_there():
    """Ids are client-minted, so an entry can name a parent nobody created."""
    from wsfs_suede.release.backend.minted import mint

    assert held_paths([node("stray.txt", parent=mint())]) == {}
