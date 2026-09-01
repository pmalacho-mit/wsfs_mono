"""Text deltas: the round trip, and the two ways it used to silently break."""

import pytest

from wsfs_suede.release.backend.diff import (
    Delta,
    DeleteOperation,
    RetainOperation,
    apply_delta,
    apply_deltas,
    diff_to_delta,
    invert_delta,
    recover_base,
    utf16_len,
)

EMOJI = "\U0001f600"


def test_a_delta_takes_before_to_after():
    delta = diff_to_delta("hello world", "hello there")
    assert apply_delta("hello world", delta) == "hello there"


def test_offsets_are_utf16_code_units_not_code_points():
    # One astral character is two UTF-16 units and one Python character: an
    # offset counted the Python way puts every later operation one short.
    delta = diff_to_delta(f"{EMOJI}ab", f"{EMOJI}ba")
    assert utf16_len(EMOJI) == 2
    assert apply_delta(f"{EMOJI}ab", delta) == f"{EMOJI}ba"
    assert delta[0] == RetainOperation(retain=2)


def test_astral_characters_survive_a_chain_of_edits():
    revisions = ["", f"a{EMOJI}b", f"a{EMOJI}{EMOJI}b", f"{EMOJI}b", ""]
    deltas: list[Delta] = [
        diff_to_delta(before, after) for before, after in zip(revisions, revisions[1:])
    ]
    for stop in range(len(deltas) + 1):
        assert apply_deltas("", deltas[:stop]) == revisions[stop]


def test_recover_base_walks_a_chain_backwards():
    revisions = ["one", "one two", "one two three", "two three"]
    deltas: list[Delta] = [
        diff_to_delta(before, after) for before, after in zip(revisions, revisions[1:])
    ]
    for stop in range(len(deltas) + 1):
        assert recover_base(revisions[-1], deltas[stop:]) == revisions[stop]


def test_inverting_twice_is_the_original():
    delta = diff_to_delta("alpha", "alphabet")
    assert invert_delta(invert_delta(delta)) == delta


def test_a_delete_that_does_not_match_the_base_is_refused():
    with pytest.raises(ValueError, match="delete mismatch"):
        apply_delta("hello", [DeleteOperation(delete="world")])


def test_a_delta_may_not_run_past_the_end_of_the_base():
    with pytest.raises(ValueError, match="past the end"):
        apply_delta("hi", [RetainOperation(retain=99)])


def test_an_unknown_operation_is_refused():
    with pytest.raises(ValueError, match="unknown delta operation"):
        apply_delta("hi", [{"rotate": 1}])  # pyright: ignore[reportArgumentType]
