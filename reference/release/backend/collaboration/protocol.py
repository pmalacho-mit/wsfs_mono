"""What this package needs of a collaboration service, and nothing more.

A room is one entry's shared Yjs document, addressed by the entry's id and
nothing else. That choice is the whole protocol: a room outlives every rename,
every move, and every close, because none of those change what a room is about.
A path-keyed room would have to be renamed in step with its file, by whoever
noticed first, with no lock between them.

THREE ANSWERS, and each is here because the keeper cannot get it any other way.
A room has to exist before it can be written to. What it holds is the only
authority on whether a change has already reached it -- a CRDT cannot tell that
two inserts say the same thing, so the content is asked rather than assumed.
And an update has to be deliverable without being understood, because updates
carry their own identities and merging is the service's job, not ours.

WHAT IS DELIBERATELY ABSENT is presence, awareness, cursors, permissions and
tokens. This package never mints a credential and never asks who anybody is --
minting a token for a browser is the host's, on the host's terms, exactly as
`Authorize` is. What is here is the server-side half: the three operations one
trusted process needs to keep a room in step with a file nobody in the room
can see.

Anything answering these three will do. The name says Liveblocks because that
is what is written against it and what the tests exercise; nothing in the
signatures is Liveblocks-shaped, and a y-websocket server or a Yjs document
held in this process could satisfy them.
"""

from __future__ import annotations

from typing import Protocol


class ICollaboration(Protocol):
    """The server-side half of a collaboration service.

    Async because a real one is a network away, and every method here is on
    the path a person waits on the first time they open a file.
    """

    async def create(self, room: str) -> None:
        """Make this room exist, or leave it alone if it already does.

        IDEMPOTENT, and it has to be: `Keeper` remembers that a room was
        created and that memory is the only thing standing between a restart
        and paying for this again on every file anybody opens. A memory that
        is merely usually right is fine only if being wrong is free.

        Required before `send`. Verified rather than assumed -- writing to a
        room that was never created answers ROOM_NOT_FOUND.
        """
        ...

    async def document(self, room: str) -> bytes:
        """This room's whole Yjs document, as an update.

        A ROOM NOBODY HAS WRITTEN TO ANSWERS EMPTY, not an error. That is the
        one behaviour here worth stating twice, because the difference between
        "no such room" and "a room holding nothing" is invisible from a
        client -- it is precisely the ambiguity that made seeding a race no
        browser could settle -- and an implementation that raised for the
        first would make the keeper unable to tell them apart either.

        Read TO DECIDE and read again TO BUILD, and the second read is the one
        an update is computed against. A Yjs update built on a stale document
        is dropped without a word, and a room that caught up in between
        already holds what the update was about to insert.
        """
        ...

    async def send(self, room: str, update: bytes) -> None:
        """Merge this update into the room.

        FORWARDED, NOT INTERPRETED. An update carries the identities of the
        characters in it, so applying the same one twice merges to the same
        document -- which is what lets a client cut off from this service hand
        its work over here and still have its own connection deliver it when
        that returns. Neither route has to know about the other.

        That is also the reason nothing here reads back what it just wrote to
        confirm it: an update either merged or is still on its way, and both
        of those converge to the same document.
        """
        ...
