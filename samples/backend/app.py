"""A sample host application, of the kind wsfs is meant to be mounted into.

Everything here is the HOST's: its own users, its own workspaces, its own idea
of who may reach one. wsfs is handed two table names and a dependency, and
decides nothing else -- which is the whole point of the exercise, and the
reason this lives outside `release/`.

The test suite drives wsfs through this app rather than through a fixture of
its own, so the integration path is the one under test.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated
from uuid import UUID

import os
import time

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request
from sqlalchemy.exc import IntegrityError
from fastapi import Path as APIPath
from sqlmodel import Field, select, col
from sqlmodel.ext.asyncio.session import AsyncSession

from ...wsfs_core_suede.backend.blobs import FilesystemBlobs
from ...wsfs_core_suede.backend.collaboration import (
    ICollaboration,
    InProcessCollaboration,
    Liveblocks,
)
from ...wsfs_core_suede.backend.main import Backend, create_router
from ...wsfs_core_suede.backend.models import build_models
from ...wsfs_assistant_suede.backend import (
    ITutor,
    Said,
    build_chat_models,
    create_assistant_router,
)
from ...wsfs_pytutor_suede.backend import build_study_models, create_pytutor_router
from ...sqlmodel_utils_suede.associations import WithID
from ...sqlmodel_utils_suede.postgres.db import Database
from ...sqlmodel_utils_suede.tablenames import tablename


class Account(WithID, tablename("plural"), table=True):
    """The host's users. wsfs never reads this table -- it stores ids that
    point at it."""

    email: str = Field(index=True, unique=True, nullable=False)


class Project(WithID, tablename("plural"), table=True):
    """The host's workspaces, with whatever else a host would keep here."""

    name: str = Field(default="", nullable=False)


MODELS = build_models(user_table=Account, workspace_table=Project)
CHAT_MODELS = build_chat_models(
    core=MODELS, user_table=Account, workspace_table=Project
)
STUDY_MODELS = build_study_models(
    core=MODELS, user_table=Account, workspace_table=Project
)
"""Three schemas, built once and side by side.

Core's builder does not know the other two exist -- they take core's and point
their own foreign keys at it. That is the whole of the arrangement, and it is
the reason a host that wants only a filesystem builds only the first.
"""


async def enrolled(session: AsyncSession, email: str) -> Account:
    """This person, enrolling them if this is the first anyone has seen of them.

    RETRIED ON A COLLISION, because check-then-insert is a race and two
    requests arriving together for a person nobody has seen is the ordinary
    case at the start of a run: both read nothing, both insert, and one gets a
    unique violation. Losing that one would fail a request for a reason that
    has nothing to do with the caller.
    """
    known = (await session.exec(select(Account).where(Account.email == email))).first()
    if known is not None:
        return known
    account = Account(email=email)
    session.add(account)
    try:
        await session.commit()
    except IntegrityError:
        # Somebody else enrolled them between the read and the write, which is
        # the answer this was looking for.
        await session.rollback()
        return (
            await session.exec(select(Account).where(Account.email == email))
        ).one()
    return account


# pyright: reportUnusedFunction=false
class _Unwired(ITutor):
    """The tutor a host with no API key gets.

    Says what is true and stops. The alternative -- refusing to start -- would
    mean the whole sample, and every browser test in it, needed a paid key to
    open a file; and the alternative to THAT, pretending to answer, would put
    made-up tutoring in front of somebody learning.
    """

    @property
    def model(self) -> str:
        return "unwired"

    async def answer(self, said):
        _ = said
        yield (
            "No model is configured for this workspace, so I cannot answer "
            "properly. Set `CLAUDE_API_KEY` where the server runs and ask "
            "again."
        )


def _a_tutor() -> ITutor:
    """The real one when there is a key for it, and an honest one when not."""
    if not os.environ.get("CLAUDE_API_KEY"):
        return _Unwired()
    from ...wsfs_assistant_suede.backend.llm import Tutor

    return Tutor()


def _a_collaboration() -> ICollaboration:
    """Liveblocks when there is a key for it, and this process when not.

    THE DEFAULT IS THE LOCAL ONE, deliberately. Refusing to start without a
    paid key would mean the sample, and every test in it, needed one to open a
    file -- and rooms are filesystem behaviour, not a vendor's feature. What a
    key buys is two browsers seeing each other; what it does not buy is any of
    the server-side rules, which are the same either way.
    """
    secret = os.environ.get("LIVEBLOCKS_SECRET_KEY")
    return Liveblocks(secret) if secret else InProcessCollaboration()


def create_sample_app(
    *,
    database: Database | None = None,
    blob_root: Path = Path("/tmp/wsfs-blobs"),
    heartbeat_seconds: float = 15.0,
    grace_seconds: float = 30.0,
    max_blob_bytes: int = 64 * 1024 * 1024,
    tutor: ITutor | None = None,
    collaboration: ICollaboration | None = None,
) -> FastAPI:
    database = database or Database()
    app = FastAPI(title="wsfs sample host")

    async def authorize(
        workspace_id: Annotated[UUID, APIPath()],
        x_user_email: Annotated[str, Header()],
    ) -> UUID:
        """The host's policy, in the one place a host would put it: who this
        caller is, and whether they may reach this workspace."""
        async with database.session() as session:
            project = await session.get(Project, workspace_id)
            if project is None:
                raise HTTPException(404, "no such workspace")
            return (await enrolled(session, x_user_email)).id

    # -- rendezvous ----------------------------------------------------------------
    #
    # TEST SCAFFOLDING, and deliberately the least capable thing that works.
    #
    # The collaboration suite runs the same tests in two browsers at once, and
    # they have to agree on things before they can be about anything: which
    # workspace they are both in, and when one of them has finished a step the
    # other is waiting on. Neither browser can be told by the other -- that is
    # what is being tested -- so they meet here.
    #
    # Set-if-absent, and whoever wins is what everybody gets. Entries age out
    # so that a later run cannot inherit an earlier run's answers; `DELETE`
    # makes that deterministic for a runner that would rather not wait.

    met: dict[str, tuple[str, float]] = {}
    MEETING_TTL = 600.0

    def _live() -> None:
        stale = [
            key for key, (_, at) in met.items() if time.monotonic() - at > MEETING_TTL
        ]
        for key in stale:
            del met[key]

    @app.put("/rendezvous/{key}")
    async def meet(key: str, body: dict[str, str]) -> dict[str, str]:
        """Propose a value. The first proposal wins and is returned to all."""
        _live()
        if key not in met:
            met[key] = (body["value"], time.monotonic())
        return {"value": met[key][0]}

    @app.get("/rendezvous/{key}")
    async def met_at(key: str) -> dict[str, str]:
        _live()
        if key not in met:
            raise HTTPException(404, "nobody has been here yet")
        return {"value": met[key][0]}

    @app.delete("/rendezvous", status_code=204)
    async def forget_meetings() -> None:
        met.clear()

    @app.get("/liveblocks/token")
    async def liveblocks_token(
        rooms: Annotated[list[str], Query()],
        x_user_email: Annotated[str, Header()],
    ) -> dict[str, str]:
        """Mint a Liveblocks token for this caller, for these rooms.

        The secret key never reaches a browser, which is the whole reason this
        route exists rather than the client holding a public key: a public key
        makes every visitor anonymous and interchangeable, and there is no way
        to say who wrote something in a room.

        WHAT A REAL HOST WOULD DO DIFFERENTLY: the rooms come from the caller
        here, so anyone enrolled can ask for a token to any room they can name.
        A host with subscriptions would derive the list from what this user is
        actually a member of and ignore what they asked for. The sample has no
        such notion, and inventing half of one would suggest this is the shape
        to copy.
        """
        secret = os.environ.get("LIVEBLOCKS_SECRET_KEY")
        if not secret:
            raise HTTPException(503, "this host was started without a Liveblocks key")

        async with database.session() as session:
            account = await enrolled(session, x_user_email)

        async with httpx.AsyncClient(timeout=20) as client:
            answer = await client.post(
                "https://api.liveblocks.io/v2/authorize-user",
                json={
                    "userId": str(account.id),
                    "userInfo": {"email": x_user_email},
                    "permissions": {room: ["room:write"] for room in rooms},
                },
                headers={"Authorization": f"Bearer {secret}"},
            )
        if answer.status_code != 200:
            raise HTTPException(answer.status_code, answer.text)
        return {"token": answer.json()["token"]}

    @app.post("/projects", status_code=201)
    async def open_project(project_id: UUID | None = None) -> dict[str, str]:
        """Open the named project, or make one when none is named.

        `= None` is load-bearing: a query parameter typed `UUID | None` with
        no default is REQUIRED by FastAPI, nullability notwithstanding -- so
        without it the half of this route that makes a project cannot be
        reached at all, and every caller gets a 422.
        """
        async with database.session() as session:
            if project_id is None:
                project = Project()
                session.add(project)
                await session.commit()
                return {"id": str(project.id)}
            else:
                project = (
                    await session.exec(
                        select(Project).where(col(Project.id) == project_id)
                    )
                ).one_or_none()
                if project is None:
                    raise HTTPException(404, "project not found")

                return {"id": str(project_id)}

    backend = Backend.over(
        MODELS,
        database,
        FilesystemBlobs(blob_root),
        heartbeat_seconds=heartbeat_seconds,
        grace_seconds=grace_seconds,
        max_blob_bytes=max_blob_bytes,
        collaboration=collaboration or _a_collaboration(),
    )

    def _rooms():
        if not hasattr(app.state, "rooms"):
            app.state.rooms = backend.keeper
        return app.state.rooms

    answering = tutor or _a_tutor()

    wsfs = create_router(backend=backend, authorize=authorize)
    assistant = create_assistant_router(
        backend=backend, models=CHAT_MODELS, authorize=authorize, tutor=answering
    )
    pytutor = create_pytutor_router(
        backend=backend, models=STUDY_MODELS, authorize=authorize, tutor=answering
    )
    """ONE TUTOR, TWO ROUTERS. The seam is the assistant's `ITutor`, so the
    model choice, the fallback, the token cap and the key live in one place and
    `/progress` costs no second wiring."""

    for mounted in (wsfs, assistant, pytutor):
        app.include_router(mounted.router)
    app.state.wsfs = backend
    app.state.mounted = wsfs
    app.state.assistant = assistant
    app.state.pytutor = pytutor
    """Both, because they answer different questions. `wsfs` is the backend --
    the schema, the registry, the keeper -- which is what the tests reach for
    and what a host shuts down. `mounted` is the work: the router, every
    route's function, and the two things that are NOT routes -- `clone` and
    `place` -- which can be reached no other way."""
    return app
