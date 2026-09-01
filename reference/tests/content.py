"""Content: what an entry holds, and how text is rebuilt from its deltas."""

from sqlmodel import Session, delete, select

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    name_version,
    new_id,
)
from wsfs_suede.samples.backend.app import MODELS

REVISIONS = ["one", "one two", "one two three", "two three"]


async def written(api: Api, name: str, revisions: list[str]) -> tuple[str, list[str]]:
    """An entry carrying each revision, and the content token each landed at.

    The first revision is the content the entry is born with, so its token is
    the create's own transaction id; every later one is the write's. The chain
    is built without ever asking the server what the last one produced.
    """
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry, name=name, transaction=born,
            content={"type": "text", "content": revisions[0]},
        )
    )
    tokens = [born]
    for revision in revisions[1:]:
        writing = api.transaction()
        acknowledged(await api.write(entry, tokens[-1], revision, transaction=writing))
        tokens.append(writing)
    return entry, tokens


async def test_every_past_revision_is_still_readable(api: Api):
    entry, tokens = await written(api, "notes.txt", REVISIONS)

    for revision, token in zip(REVISIONS, tokens):
        assert (await api.content(entry, token)).json() == {
            "type": "text",
            "content": revision,
            "version": token,
        }


async def test_an_entry_is_born_holding_the_content_it_was_created_with(api: Api):
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry, name="notes.txt", transaction=born,
            content={"type": "text", "content": "from birth"},
        )
    )

    assert await content_version(api, entry) == born
    assert (await api.content(entry)).json()["content"] == "from birth"


async def test_the_content_token_is_the_transaction_that_wrote_it(api: Api):
    entry, tokens = await written(api, "notes.txt", REVISIONS)

    assert await content_version(api, entry) == tokens[-1]


async def test_history_is_stored_as_deltas_not_as_copies(api: Api, session: Session):
    await written(api, "notes.txt", ["a" * 500, "a" * 500 + "!"])

    deltas = session.exec(select(MODELS.text_content.delta)).all()
    assert len(deltas) == 2
    # The second revision repeats none of the 500 characters the first stored.
    assert [{"retain": 500}, {"insert": "!"}] in deltas


async def test_the_cache_is_derived_so_losing_it_costs_only_time(api: Api, session: Session):
    entry, tokens = await written(api, "notes.txt", REVISIONS)

    session.exec(delete(MODELS.text_cache))
    session.commit()

    for revision, token in zip(REVISIONS, tokens):
        assert (await api.content(entry, token)).json()["content"] == revision


async def test_the_cache_anchors_the_newest_write(api: Api, session: Session):
    _, tokens = await written(api, "notes.txt", REVISIONS)

    cached = session.exec(select(MODELS.text_cache)).one()
    assert (str(cached.content_id), cached.content) == (tokens[-1], REVISIONS[-1])


async def test_a_binary_write_does_not_break_the_text_chain(api: Api):
    entry, tokens = await written(api, "mixed", ["before"])
    digest = await api.store(b"\x00\x01\x02", mime="application/x-thing")
    binary = api.transaction()
    acknowledged(
        await api.write_blob(entry, tokens[-1], hash=digest, size=3,
                             mime="application/x-thing", transaction=binary)
    )
    acknowledged(await api.write(entry, binary, "after"))

    assert (await api.content(entry)).json()["content"] == "after"


async def test_an_entry_can_be_born_binary(api: Api):
    payload = b"\x89PNG\r\n\x1a\n"
    digest = await api.store(payload, mime="image/png")
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry, name="logo.png", transaction=born,
            content={"type": "binary", "hash": digest, "size": len(payload), "mime": "image/png"},
        )
    )

    response = await api.content(entry)
    assert response.content == payload
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-hash"] == digest
    assert response.headers["etag"] == born


async def test_the_kind_is_whichever_log_holds_the_newest_write(api: Api):
    entry, tokens = await written(api, "mixed", ["text first"])
    digest = await api.store(b"bytes", mime="application/octet-stream")
    acknowledged(
        await api.write_blob(entry, tokens[-1], hash=digest, size=5,
                             mime="application/octet-stream")
    )

    assert (await api.content(entry, tokens[-1])).json()["type"] == "text"
    assert (await api.content(entry)).content == b"bytes"


async def test_a_folder_holds_no_content(api: Api):
    folder = await created(api, "src", type="folder")

    assert (await api.content(folder)).status_code == 404
    assert await content_version(api, folder) is None


async def test_a_content_token_from_another_entry_fetches_nothing(api: Api):
    _, tokens = await written(api, "a.txt", ["mine"])
    neighbour = await created(api, "b.txt")

    assert (await api.content(neighbour, tokens[-1])).status_code == 404


async def test_a_rename_between_writes_does_not_displace_the_delta_chain(api: Api):
    entry, tokens = await written(api, "notes.txt", ["before"])
    acknowledged(await api.rename(entry, await name_version(api, entry), "renamed.txt"))
    acknowledged(await api.write(entry, tokens[-1], "after"))

    # A rename touches no content log at all, so the text chain is untouched
    # by it -- there is no carried-forward pointer to place a delta against.
    assert (await api.content(entry, tokens[-1])).json()["content"] == "before"
    assert (await api.content(entry)).json()["content"] == "after"
