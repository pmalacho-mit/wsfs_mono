"""What the server keeps of the transactions it declined.

The point of these is not that a row appears. It is that the row appears
WITHOUT being visible to any of the three things that read the logs for a
living -- the delta chain a read folds, the event stream, and the dedup scan
that decides whether an id is spent. A refusal that leaked into any one of
those would be worse than not recording it at all, so most of what is below is
about absence.
"""

from sqlmodel import Session, select

from conftest import (
    Api,
    acknowledged,
    content_version,
    created,
    listening,
    meta,
    name_version,
    new_id,
    parent_version,
    refused,
    seen,
)
from wsfs_suede.samples.backend.app import MODELS


async def lost(api: Api, other: Api, entry: str, mine: str, theirs: str = "theirs"):
    """A write of `api`'s that loses to one of `other`'s, and its transaction.

    Both present the same token; the first is applied, so the second is
    refused for exactly the ordinary reason -- a race, not a malformed
    request.
    """
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, theirs))
    transaction = api.transaction()
    refusal = refused(await api.write(entry, token, mine, transaction=transaction))
    return transaction, refusal


# -- what is kept ------------------------------------------------------------------


async def test_a_refused_write_can_be_read_back_by_its_transaction(
    api: Api, other: Api
):
    entry = await created(api, "notes.py")
    transaction, _ = await lost(api, other, entry, "the text the user actually had")

    answer = await api.content(entry, transaction)

    assert answer.status_code == 200
    assert answer.json()["content"] == "the text the user actually had"
    assert answer.json()["version"] == transaction


async def test_a_refused_write_does_not_become_the_entry_s_content(
    api: Api, other: Api
):
    entry = await created(api, "notes.py")
    transaction, _ = await lost(api, other, entry, "mine")

    assert (await api.content(entry)).json()["content"] == "theirs"
    assert await content_version(api, entry) != transaction


async def test_a_refused_write_is_not_folded_into_the_entry_s_history(
    api: Api, other: Api
):
    """The trap the separate table exists to make impossible.

    A refused delta sitting in the accepted chain would be applied by every
    read after it, so the entry would hold text nobody agreed to -- and the
    corruption would be silent and permanent.
    """
    entry = await created(api, "notes.py")
    first = await content_version(api, entry)
    acknowledged(await api.write(entry, first, "one"))
    second = await content_version(api, entry)

    await lost(api, other, entry, "never accepted", theirs="two")

    landed = await content_version(api, entry)
    assert (await api.content(entry, first)).json()["content"] == ""
    assert (await api.content(entry, second)).json()["content"] == "one"
    assert (await api.content(entry, landed)).json()["content"] == "two"


async def test_a_refused_write_reaches_no_stream(api: Api, other: Api):
    entry = await created(api, "notes.py")
    token = (await api.initialize())["token"]

    async with listening(api, token) as listener:
        acknowledged(await other.write(entry, await content_version(api, entry), "theirs"))
        transaction, _ = await lost(api, other, entry, "mine", theirs="again")
        seen_events = await listener.until(2)

    announced = [event.get("transaction") for event in seen_events]
    assert transaction not in announced


async def test_re_presenting_a_refused_transaction_is_refused_again(
    api: Api, other: Api
):
    """Dedup must not mistake a refusal for work already done.

    A retry of an APPLIED transaction is acknowledged for free, and that is
    deliberate. A retry of a REFUSED one has to be judged again -- answering
    it "already happened" would tell a client its write landed when the entry
    has never held that text.
    """
    entry = await created(api, "notes.py")
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, "theirs"))
    transaction = api.transaction()

    first = refused(await api.write(entry, token, "mine", transaction=transaction))
    again = refused(await api.write(entry, token, "mine", transaction=transaction))

    assert first["reason"] == again["reason"]
    assert (await api.content(entry)).json()["content"] == "theirs"


# -- the other four properties -----------------------------------------------------


async def test_a_refused_rename_keeps_the_name_that_was_wanted(
    api: Api, other: Api, session: Session
):
    entry = await created(api, "before.py")
    token = await name_version(api, entry)
    acknowledged(await other.rename(entry, token, "theirs.py"))

    refused(await api.rename(entry, token, "the-name-i-wanted.py"))

    kept = session.exec(select(MODELS.refused_name)).one()
    assert kept.name == "the-name-i-wanted.py"
    assert str(kept.presented) == token
    assert (await meta(api, entry))["name"] == "theirs.py"


async def test_a_refused_reparent_keeps_the_destination_that_was_wanted(
    api: Api, other: Api, session: Session
):
    folder = await created(api, "src", type="folder")
    gone = await created(api, "old", type="folder")
    entry = await created(api, "a.py")
    token = await parent_version(api, entry)
    acknowledged(await other.reparent(entry, token, gone))

    refused(await api.reparent(entry, token, folder))

    kept = session.exec(select(MODELS.refused_parent)).one()
    assert str(kept.parent_entry_id) == folder


async def test_a_refused_move_keeps_both_halves(api: Api, session: Session):
    folder = await created(api, "src", type="folder")
    entry = await created(api, "a.py")
    taken = await created(api, "taken.py", parent=folder)
    assert taken

    refused(
        await api.move(
            entry,
            name="taken.py",
            name_version=await name_version(api, entry),
            parent=folder,
            parent_version=await parent_version(api, entry),
        )
    )

    assert session.exec(select(MODELS.refused_name)).one().name == "taken.py"
    assert str(session.exec(select(MODELS.refused_parent)).one().parent_entry_id) == folder


async def test_a_refused_delete_is_recorded_as_a_deletion_that_did_not_happen(
    api: Api, other: Api, session: Session
):
    entry = await created(api, "a.py")
    was = await seen(api, entry)
    acknowledged(await other.rename(entry, was["name_version"], "renamed.py"))

    refused(await api.delete(entry, was))

    kept = session.exec(select(MODELS.refused_deletion)).one()
    assert kept.deleted is True
    assert not (await meta(api, entry)).get("deleted")


async def test_a_refused_create_keeps_all_four_and_its_content(
    api: Api, session: Session
):
    """The case with the most to lose: nothing about the entry exists anywhere
    else, so a refusal that kept nothing would erase the whole thing."""
    entry, transaction = new_id(), api.transaction()

    refused(
        await api.create(
            entry,
            name="orphan.py",
            parent=new_id(),  # a folder nobody ever created
            content={"type": "text", "content": "print('never landed')"},
            transaction=transaction,
        )
    )

    assert session.exec(select(MODELS.refused_name)).one().name == "orphan.py"
    assert session.exec(select(MODELS.refused_deletion)).one().deleted is False
    assert session.exec(select(MODELS.refused_parent)).all()

    # Stored is not the same as retrievable, and for a long time this only
    # checked the first: there is no entry row for a create that was refused,
    # so the content read used to 404 on the way past.
    assert (await api.content(entry, transaction)).json()["content"] == (
        "print('never landed')"
    )


async def test_a_write_refused_because_the_entry_was_deleted_is_still_kept(
    api: Api, session: Session
):
    """A deletion is a property, not a tombstone -- the entry row survives, so
    there is somewhere for this to hang and something to recover it onto if a
    restore ever lands."""
    entry = await created(api, "doomed.py")
    token = await content_version(api, entry)
    acknowledged(await api.delete(entry, await seen(api, entry)))

    transaction = api.transaction()
    refused(await api.write(entry, token, "typed just before it went", transaction=transaction))

    assert (await api.content(entry, transaction)).json()["content"] == (
        "typed just before it went"
    )
    assert session.exec(select(MODELS.refused_text)).one()


# -- the two kept apart ------------------------------------------------------------


async def test_a_transaction_naming_no_entry_is_counted_on_its_own(
    api: Api, session: Session
):
    """Its own table so it can be COUNTED on its own -- a workspace collecting
    these is saying something is wrong. Being able to count it is not a reason
    to throw the payload away."""
    refused(await api.rename(new_id(), new_id(), "nowhere.py"))

    counted = session.exec(select(MODELS.unknown_entry)).one()
    assert counted.reason == "no such entry"
    assert counted.op == "rename"
    assert session.exec(select(MODELS.refused_name)).one().name == "nowhere.py"


async def test_a_write_to_an_entry_whose_create_was_refused_keeps_its_text(api: Api):
    """The reason the payload matters here.

    A create refused in an earlier submission leaves an entry the server has
    never heard of -- and the writes the user goes on making to that file all
    arrive as `no such entry`. Their text is the only copy anybody has.
    """
    entry, create = new_id(), api.transaction()
    refused(
        await api.create(
            entry, name="a.py", parent=new_id(),
            content={"type": "text", "content": ""}, transaction=create,
        )
    )
    written = api.transaction()
    refused(await api.write(entry, create, "TYPED AFTER THE CREATE FAILED",
                            transaction=written))

    assert (await api.content(entry, written)).json()["content"] == (
        "TYPED AFTER THE CREATE FAILED"
    )


async def test_a_reused_transaction_id_is_counted_on_its_own(api: Api, session: Session):
    entry = await created(api, "a.py")
    spent = api.transaction()
    acknowledged(await api.rename(entry, await name_version(api, entry), "b.py",
                                  transaction=spent))

    refused(await api.write(entry, await content_version(api, entry), "x", transaction=spent))

    counted = session.exec(select(MODELS.taken_id)).one()
    assert counted.reason == "that id is already in use"
    assert (await api.content(entry, spent)).json()["content"] == "x"


async def test_a_token_spent_twice_answers_with_the_one_that_landed(api: Api):
    """A create writes all four properties at its own transaction, so that
    token names accepted content already. A refusal reusing it does not get to
    speak over what the filesystem actually holds."""
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(entry, name="a.py", content={"type": "text", "content": "born"},
                         transaction=born)
    )

    refused(await api.write(entry, await content_version(api, entry), "reused",
                            transaction=born))

    assert (await api.content(entry, born)).json()["content"] == "born"


# -- what it costs to keep ---------------------------------------------------------


async def test_a_run_of_refusals_stores_what_was_typed_not_the_whole_divergence(
    api: Api, other: Api, session: Session
):
    """The reason `predecessor` is on the wire.

    Each of these writes is a large document, and each diverges further from
    what the server accepted. Diffed against the accepted head they would each
    store the whole document; diffed against the one before them they store a
    keystroke.
    """
    document = "line\n" * 1_000
    entry = await created(api, "big.py")
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, "something else entirely"))

    previous: str | None = None
    transactions: list[str] = []
    for suffix in ["a", "ab", "abc"]:
        transaction = api.transaction()
        refused(
            await api.write(
                entry,
                token,
                document + suffix,
                transaction=transaction,
                predecessor=previous,
            )
        )
        transactions.append(transaction)
        previous = transaction

    kept = session.exec(select(MODELS.refused_text)).all()
    stored = {str(row.transaction): row for row in kept}
    assert len(stored) == 3

    first = stored[transactions[0]]
    assert first.basis is None
    for later in transactions[1:]:
        row = stored[later]
        assert row.basis is not None
        assert len(str(row.delta)) < 200

    # Small on disk, and still exactly what the user had.
    for suffix, transaction in zip(["a", "ab", "abc"], transactions):
        answer = await api.content(entry, transaction)
        assert answer.json()["content"] == document + suffix


async def test_a_chain_reads_back_with_the_cache_thrown_away(
    api: Api, other: Api, session: Session
):
    """The cache is an anchor, not the record. Deleting it costs a walk back
    down the chain and nothing else."""
    from sqlmodel import delete as sql_delete

    entry = await created(api, "big.py")
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, "elsewhere"))

    previous, transactions = None, []
    for text in ["one", "one two", "one two three"]:
        transaction = api.transaction()
        refused(
            await api.write(entry, token, text, transaction=transaction, predecessor=previous)
        )
        transactions.append(transaction)
        previous = transaction

    session.exec(sql_delete(MODELS.refused_text_cache))
    session.commit()

    for text, transaction in zip(["one", "one two", "one two three"], transactions):
        assert (await api.content(entry, transaction)).json()["content"] == text


async def test_a_predecessor_naming_nothing_is_ignored_rather_than_refused(
    api: Api, other: Api
):
    """It is a hint about storage. It may not decide anything."""
    entry = await created(api, "a.py")
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, "theirs"))

    transaction = api.transaction()
    refusal = refused(
        await api.write(entry, token, "mine", transaction=transaction, predecessor=new_id())
    )

    assert refusal["reason"] == "content was already updated"
    assert (await api.content(entry, transaction)).json()["content"] == "mine"


async def test_a_predecessor_cannot_make_a_write_land(api: Api, other: Api):
    """Naming one changes where a delta is taken from. It does not change the
    compare-and-swap, which is the whole reason it was safe to add."""
    entry = await created(api, "a.py")
    token = await content_version(api, entry)
    first = api.transaction()
    acknowledged(await other.write(entry, token, "theirs"))
    refused(await api.write(entry, token, "mine", transaction=first))

    refusal = refused(
        await api.write(entry, token, "mine again", predecessor=first)
    )

    assert refusal["reason"] == "content was already updated"
    assert (await api.content(entry)).json()["content"] == "theirs"


async def test_one_client_may_not_diff_against_another_s_refusal(
    api: Api, other: Api, session: Session
):
    """A predecessor is a claim about what THIS client sent before."""
    entry = await created(api, "a.py")
    token = await content_version(api, entry)
    acknowledged(await other.write(entry, token, "landed"))

    theirs = other.transaction()
    refused(await other.write(entry, token, "grace's", transaction=theirs))
    mine = api.transaction()
    refused(await api.write(entry, token, "ada's", transaction=mine, predecessor=theirs))

    stored = {
        str(row.transaction): row for row in session.exec(select(MODELS.refused_text)).all()
    }
    assert stored[mine].basis is None
    assert (await api.content(entry, mine)).json()["content"] == "ada's"
