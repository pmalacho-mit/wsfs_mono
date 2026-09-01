"""Fixtures, and a client that speaks the protocol rather than HTTP.

The client mints every id, so these helpers do too: an entry's id is known
before the request that creates it is sent.
"""

import asyncio
import json
import time
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from sqlalchemy import Engine, text
from sqlmodel import Session, SQLModel, create_engine

# Imported for the side effect: the host declares its own tables and builds
# the wsfs schema against them, which is what registers everything.
from wsfs_suede.samples.backend.app import create_sample_app
from wsfs_suede.release.backend.blobs import digest_of
from wsfs_suede.release.backend.minted import mint
from sqlmodel.ext.asyncio.session import AsyncSession
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.postgres.config import (
    ConfigFromEnvironment,
    config_to_url,
)
from wsfs_suede.wsfs_suede__sqlmodel_utils_suede.postgres.db import Database


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    engine = create_engine(config_to_url(ConfigFromEnvironment(), addon="psycopg"))
    yield engine
    engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def schema(engine: Engine) -> Iterator[None]:
    # a `--keep`ed stack can carry tables (and enum types) over from a prior run
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield
    SQLModel.metadata.drop_all(engine)


@pytest.fixture(autouse=True)
def clean_tables(engine: Engine) -> None:
    """Empty every table before each test, so ordering can't couple them."""
    tables = ", ".join(f'"{table.name}"' for table in SQLModel.metadata.sorted_tables)
    with engine.begin() as connection:
        connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """A synchronous session, for tests that inspect rows directly."""
    with Session(engine) as session:
        yield session


@pytest.fixture
async def reading() -> AsyncIterator[AsyncSession]:
    """The stack the backend actually runs on: Database -> asyncpg."""
    database = Database(pool="null")
    async with database.session() as session:
        yield session
    await database.disconnect()


@pytest.fixture
async def processes(tmp_path):
    """Build an independent host process over the same database."""
    built: list[Database] = []

    def build(**overrides) -> FastAPI:
        overrides.setdefault("blob_root", tmp_path / f"blobs-{len(built) + 1}")
        database = Database(pool="null")
        built.append(database)
        return create_sample_app(
            database=database,
            heartbeat_seconds=0.05,
            grace_seconds=0.2,
            **overrides,
        )

    yield build
    for database in built:
        await database.disconnect()


@pytest.fixture
def app(processes) -> FastAPI:
    return processes()


@pytest.fixture
def registry(app: FastAPI):
    return app.state.wsfs.registry


@asynccontextmanager
async def serving(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    """One process serving workspaces -- the topology the design assumes."""
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    )
    running = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            yield client
    finally:
        server.should_exit = True
        await asyncio.wait_for(running, timeout=10)


@pytest.fixture
async def instance(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with serving(app) as client:
        yield client


UNSAID: Any = object()
Body = dict[str, Any] | None


def new_id() -> str:
    """A v7, because that is what the shipped client mints.

    Which matters beyond realism: a transaction's client-side time is READ OUT
    OF ITS ID, so a suite minting v4s would exercise every path with that half
    of the record permanently absent. What a v4 does there is worth testing on
    purpose (`timing.py`), not by accident everywhere.
    """
    return str(mint())


def minted_elsewhere() -> str:
    """An id from a client that did not follow the recommendation."""
    return str(uuid4())


class Api:
    """One client instance: its own outbox, and every id it needs."""

    http: httpx.AsyncClient
    workspace: str
    user: str

    def __init__(self, http: httpx.AsyncClient, workspace: str, user: str) -> None:
        self.http = http
        self.workspace = workspace
        self.user = user

    def transaction(self) -> str:
        return new_id()

    @property
    def _headers(self) -> dict[str, str]:
        return {"X-User-Email": self.user}

    async def submit(self, **request: Any) -> httpx.Response:
        request.setdefault("transaction", self.transaction())
        return await self.http.post(
            f"{WSFS}/workspaces/{self.workspace}/transactions",
            json=request,
            headers=self._headers,
        )

    async def create(self, id: str, *, name: str, type: str = "file",
                     parent: str | None = None, content: Body = UNSAID, **kw):
        """A file is born with content and a folder without, so the default
        gives a file an empty one rather than making every call site say so."""
        if content is UNSAID:
            content = None if type == "folder" else {"type": "text", "content": ""}
        return await self.submit(
            op="create", id=id, type=type, name=name, parent=parent, content=content, **kw
        )

    async def rename(self, id: str, name_version: str, name: str, **kw):
        return await self.submit(
            op="rename", id=id, name_version=name_version, name=name, **kw
        )

    async def move(
        self,
        id: str,
        *,
        name: str,
        name_version: str,
        parent: str | None,
        parent_version: str,
        **kw: Any,
    ):
        return await self.submit(
            op="move", id=id, name=name, name_version=name_version,
            parent=parent, parent_version=parent_version, **kw,
        )

    async def reparent(self, id: str, parent_version: str, parent: str | None, **kw):
        return await self.submit(
            op="reparent", id=id, parent_version=parent_version, parent=parent, **kw
        )

    async def delete(self, id: str, seen: dict[str, Any], **kw):
        return await self.submit(op="delete", id=id, seen=seen, **kw)

    async def write(self, id: str, content_version: str | None, content: str, **kw):
        return await self.submit(
            op="write", id=id, content_version=content_version,
            content={"type": "text", "content": content}, **kw,
        )

    async def write_blob(self, id: str, content_version: str | None, *,
                         hash: str, size: int, mime: str, **kw):
        return await self.submit(
            op="write", id=id, content_version=content_version,
            content={"type": "binary", "hash": hash, "size": size, "mime": mime}, **kw,
        )

    async def put_blob(self, digest: str, data: bytes,
                       mime: str = "application/octet-stream") -> httpx.Response:
        return await self.http.put(
            f"{WSFS}/workspaces/{self.workspace}/blobs/{digest}",
            content=data,
            headers={"Content-Type": mime, **self._headers},
        )

    async def store(self, data: bytes, mime: str = "application/octet-stream") -> str:
        digest = digest_of(data)
        response = await self.put_blob(digest, data, mime)
        assert response.status_code == 200, response.text
        return digest

    async def blob(self, digest: str) -> httpx.Response:
        return await self.http.get(
            f"{WSFS}/workspaces/{self.workspace}/blobs/{digest}", headers=self._headers
        )

    async def initialize(self, outbox: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        response = await self.http.post(
            f"{WSFS}/workspaces/{self.workspace}/initialize",
            json={"outbox": outbox or []},
            headers=self._headers,
        )
        assert response.status_code == 200, response.text
        return response.json()

    async def content(self, id: str, version: str | None = None) -> httpx.Response:
        query = "" if version is None else f"?content={version}"
        return await self.http.get(
            f"{WSFS}/workspaces/{self.workspace}/entries/{id}/content{query}",
            headers=self._headers,
        )

    def stream(self, token: str):
        return self.http.stream("GET", f"{WSFS}/workspaces/{self.workspace}/stream?token={token}")


WSFS = "/wsfs"


async def open_workspace(http: httpx.AsyncClient) -> str:
    """The HOST's endpoint -- provisioning is not wsfs's business."""
    response = await http.post("/projects")
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
async def workspace(instance: httpx.AsyncClient) -> str:
    return await open_workspace(instance)


@pytest.fixture
async def api(instance: httpx.AsyncClient, workspace: str) -> Api:
    return Api(instance, workspace, user="ada@example.com")


@pytest.fixture
async def other(instance: httpx.AsyncClient, workspace: str) -> Api:
    """A second client in the same workspace -- another tab, or another user."""
    return Api(instance, workspace, user="grace@example.com")


def acknowledged(response: httpx.Response) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] is False
    return response.json()


def refused(response: httpx.Response) -> dict[str, Any]:
    assert response.status_code == 409, response.text
    assert response.json()["rejected"] is True
    return response.json()


async def created(api: Api, name: str | None = None, **kw) -> str:
    """The id the client minted, once the server has accepted the create."""
    entry = kw.pop("id", None) or new_id()
    acknowledged(await api.create(entry, name=name or f"entry-{entry[:8]}", **kw))
    return entry


async def meta(api: Api, entry_id: str) -> dict[str, Any]:
    entries = (await api.initialize())["entries"]
    return next(entry for entry in entries if entry["id"] == entry_id)


async def seen(api: Api, entry_id: str) -> dict[str, Any]:
    """Every token of an entry, as a delete must present them."""
    entry = await meta(api, entry_id)
    return {
        "name_version": entry["name_version"],
        "parent_version": entry["parent_version"],
        "deleted_version": entry["deleted_version"],
        "content_version": entry.get("content_version"),
    }


async def name_version(api: Api, entry_id: str) -> str:
    return (await meta(api, entry_id))["name_version"]


async def parent_version(api: Api, entry_id: str) -> str:
    return (await meta(api, entry_id))["parent_version"]


async def content_version(api: Api, entry_id: str) -> str | None:
    return (await meta(api, entry_id)).get("content_version")


class Listener:
    """Everything one SSE connection has seen, as it arrives."""

    events: list[dict[str, Any]]

    def __init__(self) -> None:
        self.events = []

    async def _drain(self, response: httpx.Response) -> None:
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                self.events.append(json.loads(line.removeprefix("data: ")))

    async def until(self, count: int, timeout: float = 5.0) -> list[dict[str, Any]]:
        deadline = time.monotonic() + timeout
        while len(self.events) < count and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert len(self.events) >= count, f"expected {count}, saw {self.events}"
        return self.events


@asynccontextmanager
async def listening(api: Api, token: str) -> AsyncGenerator[Listener]:
    listener = Listener()
    async with api.stream(token) as response:
        assert response.status_code == 200, await response.aread()
        reading = asyncio.create_task(listener._drain(response))
        await asyncio.sleep(0.1)  # let the replay drain and the subscription land
        try:
            yield listener
        finally:
            reading.cancel()
