"""Text history as Yjs-shaped deltas.

Storing every revision of every file whole is the wasteful option; storing the
edit between revisions is not. These are the four operations that make that
trade reversible: build a delta, apply it forwards, invert it, and walk a chain
of them backwards to any older revision.

Offsets are UTF-16 code units, as Yjs counts them -- which is why everything
here works on the utf-16-le encoding rather than on Python's code points. The
two agree until the first emoji, and then they disagree silently.
"""

from collections.abc import Iterable
from typing import Required, TypedDict

from fast_diff_match_patch import diff


class InsertOperation(TypedDict):
    insert: Required[str]


class RetainOperation(TypedDict):
    retain: Required[int]


class DeleteOperation(TypedDict):
    delete: Required[str]
    """Yjs carries a length here; the removed text is kept instead, because
    that is what makes a delta invertible and therefore a delta chain walkable
    in both directions."""


type YjsDeltaOp = InsertOperation | RetainOperation | DeleteOperation
type Delta = list[YjsDeltaOp]

UTF16 = "utf-16-le"
BYTES_PER_UNIT = 2


def _units(text: str) -> bytes:
    return text.encode(UTF16)


def _text(units: bytes) -> str:
    return units.decode(UTF16)


def utf16_len(text: str) -> int:
    return len(_units(text)) // BYTES_PER_UNIT


class _Base:
    """A cursor over the text a delta is being applied to, in UTF-16 units."""

    _units: bytes
    _at: int

    def __init__(self, text: str) -> None:
        self._units = _units(text)
        self._at = 0

    def take(self, count: int) -> bytes:
        return self._units[self._at : self._advance(count)]

    def drop(self, removed: str, *, validate: bool) -> None:
        was = self._units[self._at : self._advance(utf16_len(removed))]
        if validate and was != _units(removed):
            raise ValueError(
                f"delete mismatch: expected {removed!r}, found {_text(was)!r}"
            )

    def rest(self) -> bytes:
        return self._units[self._at :]

    def _advance(self, units: int) -> int:
        if units < 0:
            raise ValueError("delta offsets must be non-negative")
        end = self._at + units * BYTES_PER_UNIT
        if end > len(self._units):
            raise ValueError("delta runs past the end of the base text")
        self._at = end
        return end


def _appended(op: YjsDeltaOp, base: _Base, *, validate: bool) -> bytes:
    if "retain" in op:
        return base.take(op["retain"])
    if "insert" in op:
        return _units(op["insert"])
    if "delete" in op:
        base.drop(op["delete"], validate=validate)
        return b""
    raise ValueError(f"unknown delta operation: {op!r}")  # pyright: ignore[reportUnreachable]


def apply_delta(base: str, delta: Delta, *, validate: bool = True) -> str:
    """`base` with `delta` applied. Base left unconsumed by the delta is kept."""
    cursor = _Base(base)
    out = bytearray()
    for op in delta:
        out += _appended(op, cursor, validate=validate)
    out += cursor.rest()
    return _text(bytes(out))


def apply_deltas(base: str, deltas: Iterable[Delta], *, validate: bool = True) -> str:
    for delta in deltas:
        base = apply_delta(base, delta, validate=validate)
    return base


def _merged(delta: Delta, op: YjsDeltaOp) -> Delta:
    """Runs of the same operation are one operation."""
    kind, *_ = op
    if delta and kind in delta[-1]:
        delta[-1][kind] += op[kind]
    else:
        delta.append(op)
    return delta


_AS_OPERATION = {
    "=": lambda text: RetainOperation(retain=utf16_len(text)),
    "-": lambda text: DeleteOperation(delete=text),
    "+": lambda text: InsertOperation(insert=text),
}


def diff_to_delta(before: str, after: str, *, cleanup: str = "Efficiency") -> Delta:
    """The delta taking `before` to `after`. cleanup: Semantic | Efficiency | No"""
    parts: list[tuple[str, str]] = diff(
        before, after, counts_only=False, cleanup=cleanup
    )
    delta: Delta = []
    for tag, text in parts:
        if text:
            delta = _merged(delta, _AS_OPERATION[tag](text))
    return delta


def invert_delta(delta: Delta) -> Delta:
    """The delta undoing `delta` -- inserts become deletes, and vice versa."""
    inverted: Delta = []
    for op in delta:
        if "retain" in op:
            inverted.append(RetainOperation(retain=op["retain"]))
        elif "insert" in op:
            inverted.append(DeleteOperation(delete=op["insert"]))
        elif "delete" in op:
            inverted.append(InsertOperation(insert=op["delete"]))
        else:
            raise ValueError(f"unknown delta operation: {op!r}")
    return inverted


def recover_base(
    current: str, deltas_oldest_to_newest: Iterable[Delta], *, validate: bool = True
) -> str:
    """The text `current` was reached from, by undoing those deltas in reverse."""
    return apply_deltas(
        current,
        (invert_delta(delta) for delta in reversed(list(deltas_oldest_to_newest))),
        validate=validate,
    )
