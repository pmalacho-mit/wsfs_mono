# pyright: reportUnusedFunction=false
"""The router a host mounts over core's, and the work behind it.

MOUNTS OVER, DOES NOT WRAP -- the same arrangement `wsfs_assistant_suede` uses,
for the same reason. This package takes core's `Backend`, the host's
`Authorize`, its own tables and an `ITutor`, and hands back its own
mounted-alike.

WHY AN `ITutor` RATHER THAN A PROVIDER. `/progress` is a model call, and giving
this package its own wiring would mean a second copy of the model choice, the
fallback, the token cap and the key handling. The host builds ONE tutor and
hands it to both routers instead -- see `wsfs_assistant_suede.llm`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, final
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi import Path as APIPath

from ...wsfs_assistant_suede.backend.tutor import ITutor
from ...wsfs_core_suede.backend.main import Authorize, Backend

from . import progress as judging
from . import study as studying
from .contract import Accepted, Detected, Judged, Judging, Recorded
from .models import StudyModels

__all__ = ["Pytutor", "create_pytutor_router"]


Judge = Callable[[UUID, Judging, UUID], Awaitable[Judged]]
RecordDetection = Callable[[UUID, Detected, UUID], Awaitable[None]]
RecordAcceptance = Callable[[UUID, Accepted, UUID], Awaitable[None]]
RecordActivity = Callable[[UUID, Recorded, UUID], Awaitable[None]]
"""One alias per route, in the order the routes are declared. Positional, and
the last argument is the user a request would have carried through
`authorize` -- see core's `Mounted` for the whole of that argument."""


@final
@dataclass(frozen=True)
class Pytutor:
    """What a host gets back: the router, and the work behind every route."""

    router: APIRouter

    progress: Judge
    detected: RecordDetection
    accepted: RecordAcceptance
    activity: RecordActivity


def create_pytutor_router(
    *,
    backend: Backend,
    models: StudyModels,
    authorize: Authorize,
    tutor: ITutor,
    prefix: str = "/wsfs",
) -> Pytutor:
    """A router to include beside core's, and the work behind it.

    `prefix` defaults to core's so these routes sit under the path a client
    already knows; nothing here collides with a core or assistant route.
    """
    database = backend.database

    router = APIRouter(prefix=prefix)

    @router.post("/workspaces/{workspace_id}/progress")
    async def progress(
        workspace_id: Annotated[UUID, APIPath()],
        request: Judging,
        _: UUID = Depends(authorize),
    ) -> Judged:
        """Whether a student has got anywhere since a few minutes ago.

        NOT A QUESTION, and not part of anybody's conversation: no transcript
        goes in and no turn comes out. It is one measurement, asked on a timer
        by the client that is watching somebody work -- which is why it does
        not stream, does not take a message id, and is not recorded. What is
        recorded is the episode, and only if the answer is no.

        Answered synchronously because the caller has nobody waiting on it.
        """
        progressing, why = await judging.judged(
            tutor, request.goal, request.before, request.after
        )
        return Judged(progressing=progressing, why=why)

    # -- the study ---------------------------------------------------------------------

    #
    # Where the nudge protocol writes down what it saw. Three routes, all
    # write-only, all answering 204 whether or not there was anything to
    # write -- see `study.py` for why this is the one part of wsfs allowed to
    # lose a row.
    #
    # UNDER A WORKSPACE like every core route, so `authorize` answers the one
    # question it answers: may this caller reach this workspace. The student
    # is whoever that says, never whoever the body claims.

    @router.post("/workspaces/{workspace_id}/study/episodes", status_code=204)
    async def stuck_episode(
        workspace_id: Annotated[UUID, APIPath()],
        told: Detected,
        user: UUID = Depends(authorize),
    ) -> None:
        """A student was detected as stuck, and what the protocol did about it."""
        async with database.session() as session:
            await studying.detected(session, models, workspace_id, user, told)

    @router.post("/workspaces/{workspace_id}/study/offers", status_code=204)
    async def stuck_offer(
        workspace_id: Annotated[UUID, APIPath()],
        told: Accepted,
        user: UUID = Depends(authorize),
    ) -> None:
        """A student took a prompt that was offered to them."""
        async with database.session() as session:
            await studying.accepted(session, models, workspace_id, user, told)

    @router.post("/workspaces/{workspace_id}/study/activity", status_code=204)
    async def stuck_activity(
        workspace_id: Annotated[UUID, APIPath()],
        told: Recorded,
        user: UUID = Depends(authorize),
    ) -> None:
        """A batch of what a student did inside a post-episode window."""
        async with database.session() as session:
            await studying.recorded(session, models, workspace_id, user, told)

    return Pytutor(
        router=router,
        progress=progress,
        detected=stuck_episode,
        accepted=stuck_offer,
        activity=stuck_activity,
    )
