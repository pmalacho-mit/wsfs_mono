# pyright: reportUnusedFunction=false
"""The router a host mounts OVER core's, and the work behind it.

MOUNTS OVER, DOES NOT WRAP. This package takes core's `Backend` and the host's
`Authorize` -- the same two things core's own router takes -- builds its own
tables and its own routes, and hands back its own mounted-alike. It never
consumes core's `Mounted`: that object is for an application calling the work
behind a route without HTTP'ing itself, which is a different job from adding
routes of one's own.

READS CORE, NEVER WRITES IT. Everything here reads snapshots, runs and
reconstructed text, and appends to tables this package owns. Nothing here
reaches `service`, and an assistant that ever needs to write a workspace does
it through `Mounted.place` as an ordinary application consumer.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, final
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi import Path as APIPath
from fastapi.responses import StreamingResponse

from ...sqlmodel_utils_suede.associations import now
from ...wsfs_core_suede.backend.main import (
    Authorize,
    Backend,
    sent,
)

from . import tutor as tutoring
from .contract import Answering, Asked, Asking, Transcript
from .models import ChatModels
from .tutor import ITutor, Said, Tutoring

__all__ = [
    "Asked",
    "Asking",
    "Assistant",
    "Authorize",
    "ITutor",
    "Said",
    "Transcript",
    "create_assistant_router",
]


Ask = Callable[[UUID, Asking, UUID], Awaitable[Asked]]
Hear = Callable[[UUID, str, UUID], Awaitable[StreamingResponse]]
FetchTranscript = Callable[[UUID, datetime | None, int, UUID], Awaitable[Transcript]]
"""One alias per route, in the order the routes are declared. Positional, and
the last argument is the user a request would have carried through
`authorize` -- see core's `Mounted` for the whole of that argument."""


@final
@dataclass(frozen=True)
class Assistant:
    """What a host gets back: the router, and the work behind every route.

    `include_router(assistant.router)` is the whole of mounting it. The rest is
    for a host that is also a consumer -- a job that wants a transcript without
    making an HTTP request to itself.
    """

    router: APIRouter

    ask: Ask
    hear: Hear
    conversation: FetchTranscript


MOST_TURNS = 100
"""How many turns of a transcript one read may ask for."""


def create_assistant_router(
    *,
    backend: Backend,
    models: ChatModels,
    authorize: Authorize,
    tutor: ITutor,
    prefix: str = "/wsfs",
) -> Assistant:
    """A router to include beside core's, and the work behind it.

    `prefix` defaults to core's so the chat routes sit under the same path a
    client already knows. Nothing here collides with a core route -- the paths
    below are this package's alone -- and mounting both on one prefix is what
    makes the client's base URL one string rather than two.
    """
    database = backend.database
    answering = Tutoring(tutor, now)

    router = APIRouter(prefix=prefix)

    @router.post("/workspaces/{workspace_id}/chat")
    async def ask(
        workspace_id: Annotated[UUID, APIPath()],
        request: Asking,
        user: UUID = Depends(authorize),
    ) -> Asked:
        """Put a question to the tutor, and say where to hear the answer.

        TWO CALLS, NOT ONE. Answering takes seconds and a request should not,
        so this records the question, starts the work and returns -- and the
        stream below attaches to work that is already under way. A client that
        never attaches changes nothing: the answer is written down when it
        finishes, because a person who asks and closes the tab has still
        asked.

        ASKING TWICE IS ANSWERED ONCE. The message id is the client's, so a
        retried request finds its own question already here. It still gets a
        token, because the reason to retry is usually that the first answer
        never arrived.
        """
        async with database.session() as session:
            said = await tutoring.prompt(
                session,
                models,
                backend.schema.text,
                workspace_id,
                user,
                request,
                until=now(),
            )
            if not await tutoring.already_asked(session, models, request.message):
                for row in tutoring.rows_for(models, workspace_id, user, request):
                    session.add(row)
                await session.commit()

        async def record(text: str, failure: str | None, model: str) -> None:
            """Written in a session of its own.

            The request's is long closed by the time an answer finishes -- that
            is the whole shape of this -- so the generation opens its own.
            """
            async with database.session() as writing:
                writing.add(
                    models.answered(
                        message_id=request.message,
                        workspace_id=workspace_id,
                        user_id=user,
                        text=text,
                        model=model,
                        failure=failure,
                    )
                )
                await writing.commit()

        return Asked(
            message=request.message,
            token=answering.start(said, record),
        )

    @router.get(
        "/workspaces/{workspace_id}/chat/stream",
        response_class=StreamingResponse,
        responses={
            200: {
                "model": Answering,
                "content": {"text/event-stream": {}},
                "description": (
                    "One `data:` line per delta, then one saying it ended."
                    " Declared so a client can be generated against it."
                ),
            }
        },
    )
    async def hear(
        workspace_id: Annotated[UUID, APIPath()],
        token: str,
        _: UUID = Depends(authorize),
    ) -> StreamingResponse:
        """The answer, as it is written.

        The token names a generation running in this process rather than a
        durable fact, so it is not spent by being read: a page that reloaded
        mid-answer picks the same one up again. What retires it is the answer
        being old, not somebody having heard it.
        """
        generation = answering.claim(token)
        if generation is None:
            raise HTTPException(404, "nothing is being answered under that token")

        async def written() -> AsyncIterator[str]:
            async for delta in generation.follow():
                yield sent(Answering(type="delta", delta=delta).model_dump(mode="json"))
            yield sent(
                Answering(
                    type="ended",
                    text=generation.text,
                    failure=generation.failure,
                ).model_dump(mode="json")
            )

        return StreamingResponse(
            written(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.get("/workspaces/{workspace_id}/chat")
    async def conversation(
        workspace_id: Annotated[UUID, APIPath()],
        before: datetime | None = None,
        limit: int = 10,
        user: UUID = Depends(authorize),
    ) -> Transcript:
        """This person's conversation here, newest first.

        Scoped to the caller as well as the workspace: a workspace can have
        more than one person in it, and what somebody asked a tutor is theirs.
        """
        async with database.session() as session:
            return await tutoring.transcript(
                session,
                models,
                workspace_id,
                user,
                before,
                max(1, min(limit, MOST_TURNS)),
            )

    return Assistant(
        router=router,
        ask=ask,
        hear=hear,
        conversation=conversation,
    )
