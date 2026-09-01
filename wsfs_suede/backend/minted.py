"""When a transaction happened on the client, read out of the id it happened as.

A UUIDv7 carries, in its first 48 bits, the Unix epoch MILLISECONDS at which it
was minted -- and this client mints a transaction's id at the moment the user
acts, before anything is sent. So "when did this happen on the client" is
already on the wire, in the primary key, and storing it in a column beside that
key would be storing the same fact twice. Nothing here writes anything.

WHAT A v7 DOES NOT CARRY IS A TIMEZONE. Its timestamp is an INSTANT, counted
from the epoch, and an instant is the same number in Cupertino and in Berlin.
That is the property you want for ordering and for storage, and it is exactly
the wrong one for "show me the time on the clock I was looking at": a user who
works in Los Angeles on Monday and London on Tuesday produces two ids that say
nothing about which was which. The offset has to be carried alongside, which is
why `Transacted.offset` exists and why it rides on each transaction rather than
on the connection -- see the note there.

The instant is CLIENT-REPORTED, and a client's clock is its own. A skewed one
mints ids that claim a time nobody experienced, and a hostile one can claim any
time at all. Nothing here trusts it: `Occurrence.accepted` is the server's own
clock, and it is the one to reconcile against when the two disagree.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

VERSION = 7

EPOCH = datetime.fromtimestamp(0, UTC)

MILLISECONDS_BEGIN_AT = 80
"""How far a v7's 48-bit timestamp sits above the low end of the 128."""

_RAND_A = 12
_RAND_B = 62


def minted_at(identifier: UUID) -> datetime | None:
    """The instant a UUIDv7 was minted, in UTC -- or None if it is not one.

    None rather than an exception, and not for tidiness: the contract PREFERS
    v7 and does not require it, so an id minted some other way is a client
    saying nothing about when it acted rather than a client misbehaving. A
    caller gets "unknown", which is what it is.

    An id whose timestamp is outside the range a datetime can express reads as
    unknown too. That is reachable from a broken clock and from a hostile
    client alike -- 48 bits of milliseconds reach the year 10889, and
    `datetime` stops at 9999 -- and neither is worth refusing a transaction
    over, because the id's job is to be unique, not to be believed.
    """
    if identifier.version != VERSION:
        return None
    try:
        return EPOCH + timedelta(milliseconds=identifier.int >> MILLISECONDS_BEGIN_AT)
    except (OverflowError, OSError, ValueError):
        return None


def mint(at: datetime | None = None) -> UUID:
    """A v7 of our own, for the one transaction no client minted.

    The controller issues exactly one kind of transaction itself -- the rename
    that settles a colliding create -- and it used to mint a v4 for it. A v7
    costs the same and means that transaction answers "when did this happen"
    like every other one, with the only clock that saw it: this process's.

    No sequence counter, unlike the client's minter, which needs one because it
    leans on ids minted within a millisecond staying in order. Nothing here
    does: a transaction's place in a workspace is its position, and the choke
    point hands those out.
    """
    milliseconds = ((at or datetime.now(UTC)) - EPOCH) // timedelta(milliseconds=1)
    return UUID(
        int=(milliseconds << MILLISECONDS_BEGIN_AT)
        | (VERSION << (MILLISECONDS_BEGIN_AT - 4))
        | (secrets.randbits(_RAND_A) << (_RAND_B + 2))
        | (0b10 << _RAND_B)
        | secrets.randbits(_RAND_B)
    )
