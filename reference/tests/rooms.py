"""What a shared room owes its file, and the updates that settle it.

The room's DOCUMENT holds the text and nothing else. Where that text stands --
which stored version it descends from -- is bookkeeping this host keeps for
itself, because putting it in the document would mean a write to the
collaboration server every time anybody saved, for every client that heard.
"""

from pycrdt import Doc, Text

from wsfs_suede.release.backend.rooms import (
    Carry,
    Change,
    Held,
    Rebase,
    Seed,
    Settled,
    Standing,
    carried,
    plan,
    seeded,
    standing_of,
)

BORN = "01a02361-dad9-755a-ba88-e651f1ad637a"
WROTE = "01a02361-e423-71aa-ad9b-f4bd66c1aeb1"


def a_room(text: str = "") -> bytes:
    doc = Doc()
    doc["content"] = Text(text)
    return doc.get_update()


def reading(update: bytes) -> str:
    """A browser's view of an update, through the name the client uses."""
    doc = Doc()
    doc["content"] = Text()
    doc.apply_update(update)
    return str(doc["content"])


def applied(*updates: bytes) -> str:
    doc = Doc()
    doc["content"] = Text()
    for update in updates:
        doc.apply_update(update)
    return str(doc["content"])


# -- what a room owes ------------------------------------------------------------------


def test_a_room_nobody_has_filled_is_seeded():
    assert plan(Standing(text="", base=None), Held("hello\n", BORN)) == Seed(
        text="hello\n", version=BORN
    )


def test_an_empty_file_is_seeded_once_and_then_left_alone():
    # Emptiness is not the question -- a file is allowed to be empty, and a room
    # judged by its text would be re-seeded for as long as it stayed that way.
    assert plan(Standing(text="", base=BORN), Held("", BORN)) == Settled()


def test_a_room_standing_where_the_file_stands_owes_nothing():
    assert plan(Standing(text="hello\n", base=WROTE), Held("hello\n", WROTE)) == Settled()


def test_a_room_that_already_says_what_the_file_says_only_moves_the_version():
    # A member wrote the file from this room, so the text is already here and
    # carrying it in would say it twice.
    assert plan(
        Standing(text="hello\nmine\n", base=BORN), Held("hello\nmine\n", WROTE)
    ) == Rebase(version=WROTE)


def test_a_room_left_behind_carries_the_gap():
    assert plan(Standing(text="hello\n", base=BORN), Held("hello\nmore\n", WROTE)) == Carry(
        since=BORN, version=WROTE
    )


def test_unstored_work_in_the_room_does_not_make_it_behind():
    # The room holding more than the file is the ordinary state of somebody
    # typing. Only the tokens decide.
    assert plan(Standing(text="hello\ntyping", base=WROTE), Held("hello\n", WROTE)) == Settled()


# -- reading a room --------------------------------------------------------------------


def test_a_room_reads_back_as_what_was_put_in_it():
    assert standing_of(a_room("hello\n"), BORN) == Standing(text="hello\n", base=BORN)


def test_where_a_room_stands_comes_from_this_host_and_not_from_the_room():
    assert standing_of(a_room("hello\n"), None).base is None


def test_a_room_with_no_document_at_all_reads_as_empty():
    assert standing_of(b"", None) == Standing(text="", base=None)


# -- seeding ---------------------------------------------------------------------------


def test_a_seed_carries_the_text():
    assert reading(seeded("hello\n")) == "hello\n"


def test_seeding_twice_does_not_say_it_twice():
    once = seeded("hello\n")
    assert applied(once, once) == "hello\n"


# -- carrying an outside write ---------------------------------------------------------


def test_a_carried_write_reaches_the_room():
    live = a_room("hello\n")
    update = carried(live, Change(before="hello\n", after="hello\nfrom a script\n"))
    assert applied(live, update) == "hello\nfrom a script\n"


def test_a_carried_write_lands_once_however_often_it_arrives():
    live = a_room("hello\n")
    update = carried(live, Change(before="hello\n", after="hello\nfrom a script\n"))
    assert applied(live, update, update).count("from a script") == 1


def test_carrying_keeps_work_the_file_has_never_seen():
    # The diff is between two STORED versions, so it describes only what the
    # other writer did. Diffing from the room instead would call this user's
    # unstored typing text to delete.
    typing = Doc()
    typing["content"] = Text()
    typing.apply_update(a_room("hello\n"))
    typing["content"] += "still typing"

    typing.apply_update(
        carried(typing.get_update(), Change(before="hello\n", after="hello\nfrom a script\n"))
    )

    said = str(typing["content"])
    assert "still typing" in said
    assert said.count("from a script") == 1


def a_typing_room(base_text: str, typed: str, at: int) -> Doc:
    doc = Doc()
    doc["content"] = Text()
    doc.apply_update(a_room(base_text))
    doc["content"].insert(at, typed)
    return doc


def test_a_change_lands_where_it_belongs_after_someone_typed_above_it():
    doc = a_typing_room("one\ntwo\nthree\n", typed="zero\n", at=0)
    doc.apply_update(
        carried(doc.get_update(), Change(before="one\ntwo\nthree\n", after="one\nTWO\nthree\n"))
    )
    assert str(doc["content"]) == "zero\none\nTWO\nthree\n"


def test_a_change_lands_where_it_belongs_after_someone_typed_below_it():
    doc = a_typing_room("one\ntwo\nthree\n", typed="four\n", at=len("one\ntwo\nthree\n"))
    doc.apply_update(
        carried(doc.get_update(), Change(before="one\ntwo\nthree\n", after="ONE\ntwo\nthree\n"))
    )
    assert str(doc["content"]) == "ONE\ntwo\nthree\nfour\n"


def test_a_deletion_is_carried_too():
    doc = a_typing_room("one\ntwo\nthree\n", typed="zero\n", at=0)
    doc.apply_update(
        carried(doc.get_update(), Change(before="one\ntwo\nthree\n", after="one\nthree\n"))
    )
    assert str(doc["content"]) == "zero\none\nthree\n"


def test_a_removal_bigger_than_what_is_left_does_not_take_the_room_down():
    """A removal counts characters in the version it was written against, and
    the room has drifted from that version -- so the same span is a different
    length here.

    Adding the old length to a moved position walks off the end of the live
    text, and pycrdt PANICS rather than raising: "couldn't remove 65 elements,
    only 49 were removed". That took the room's whole settle with it, which is
    a 500 on the one call every client makes when it opens a file.
    """
    before = "".join(f"line {at}\n" for at in range(20))
    after = "line 0\n"

    """The room has meanwhile lost most of what the writer was deleting."""
    live = a_room("line 0\nline 1\n")
    update = carried(live, Change(before=before, after=after))
    held = applied(live, update)
    assert "line 0" in held


def test_a_removal_takes_the_region_rather_than_a_count():
    """Somebody else inserted inside the span being deleted. Removing a fixed
    number of characters would eat their text or stop short of the region;
    moving both ends removes what the writer actually removed."""
    live = Doc()
    live["content"] = Text()
    live.apply_update(a_room("one\ntwo\nthree\n"))
    live["content"].insert(len("one\ntwo\n"), "mine\n")

    update = carried(
        live.get_update(),
        Change(before="one\ntwo\nthree\n", after="one\nthree\n"),
    )
    live.apply_update(update)
    held = str(live["content"])
    assert "two" not in held
    assert "mine" in held, "somebody else's line was inside the deleted span"
    assert "one" in held and "three" in held
