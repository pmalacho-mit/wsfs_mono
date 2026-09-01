"""Per-workspace controller (the actor pattern).

One controller per workspace per process. All writes -- transactional requests
AND Initialize -- flow through submit(), which serializes them and fans
committed events out to subscribed streams. Reads (Content, blobs) bypass it
entirely; MVCC handles them.

Initialize's one-consistent-view guarantee comes from that exclusion, not from
an isolation level.

TOPOLOGY: "one controller per workspace" is only true within a process, and
stream positions are counted in that process's memory -- so exactly one
process may serve a workspace's writes, and nothing here enforces it. That is
deliberately the operator's promise (ARCHITECTURE.md invariant 11): the
database holds no lock, no lease and no connection on a workspace's behalf,
which is what makes a live workspace cost nothing to keep.

What keeps a second writer from changing the MEANING of a stream, rather than
merely making it ugly, is that events are grouped by the transaction that
caused them rather than by the position they landed at.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Awaitable
from contextlib import asynccontextmanager
from typing import Callable, TypeVar, final
from uuid import UUID

from .stream import Emitted, Positions, Stream
from ...wsfs_suede__sqlmodel_utils_suede.postgres.db import Database

T = TypeVar("T")

# fn owns its own db session, commits inside, and returns its result plus the
# events that commit produced.
SubmitFn = Callable[[], Awaitable[tuple[T, list[Emitted]]]]


@final
class WorkspaceController:
    def __init__(self, workspace_id: UUID, positions: Positions) -> None:
        self.workspace_id = workspace_id
        self.positions = positions
        self._serial = asyncio.Lock()  # the queue: one write at a time
        self.streams: set[asyncio.Queue[Emitted]] = set()

    async def submit(self, fn: SubmitFn[T]) -> T:
        async with self._serial:
            result, events = await fn()
            # Fan out inside the lock, so stream queues observe events in
            # commit order by construction rather than by protocol.
            for event in events:
                for queue in list(self.streams):
                    queue.put_nowait(event)
            return result


@final
class ControllerRegistry:
    """Owns controller lifecycle. One lock guards get-or-create AND release,
    with release re-checking the count inside the lock -- closing the race
    where a count hits zero, teardown starts, and a new stream grabs a dying
    controller.

    Release is grace-delayed: the client sync loop turns every network blip
    into a disconnect/reconnect pair, and count-to-zero-destroy would rebuild
    the controller (and re-read its position) on each one.
    """

    def __init__(
        self, database: Database, stream: Stream, *, grace_seconds: float = 30.0
    ) -> None:
        self._database = database
        self._stream = stream
        self.grace_seconds = grace_seconds
        self._controllers: dict[UUID, WorkspaceController] = {}
        self._counts: dict[UUID, int] = {}
        self._pending: dict[UUID, asyncio.Task[None]] = {}
        self._seeding: dict[UUID, asyncio.Lock] = {}
        self._issued: dict[UUID, int] = {}
        self._lock = asyncio.Lock()

    # -- access -----------------------------------------------------------

    @asynccontextmanager
    async def visiting(self, workspace_id: UUID) -> AsyncGenerator[WorkspaceController]:
        """Access for one mutation or Initialize, held for its duration.

        Held, not transient, because the controller carries the workspace's
        position counter: retiring it while a submission is in flight would
        let its successor re-seed from rows that have not committed yet, and
        hand out a position that is about to be taken.
        """
        controller = await self._enter(workspace_id)
        try:
            yield controller
        finally:
            await self._leave(workspace_id)

    async def acquire_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> WorkspaceController:
        controller = await self._enter(workspace_id)
        async with self._lock:
            controller.streams.add(queue)
        return controller

    async def release_stream(
        self, workspace_id: UUID, queue: asyncio.Queue[Emitted]
    ) -> None:
        async with self._lock:
            controller = self._controllers.get(workspace_id)
            if controller is not None:
                controller.streams.discard(queue)
        await self._leave(workspace_id)

    async def _enter(self, workspace_id: UUID) -> WorkspaceController:
        async with self._lock:
            existing = self._controllers.get(workspace_id)
            if existing is not None:
                return self._counted(workspace_id, existing)
            seeding = self._seeding.setdefault(workspace_id, asyncio.Lock())
        # Seeding reads the database, and the registry-wide lock is not held
        # across it: one workspace waking up must not stall every other
        # workspace's first request behind its round trip. The per-workspace
        # lock is what keeps two arrivals from seeding one workspace twice.
        async with seeding:
            async with self._lock:
                existing = self._controllers.get(workspace_id)
                if existing is not None:
                    return self._counted(workspace_id, existing)
            committed = await self._committed(workspace_id)
            async with self._lock:
                controller = self._controllers.get(workspace_id)
                if controller is None:
                    controller = self._seeded(workspace_id, committed)
                return self._counted(workspace_id, controller)

    def _counted(
        self, workspace_id: UUID, controller: WorkspaceController
    ) -> WorkspaceController:
        """Claim the controller, under `self._lock`. Nothing awaits in here,
        which is what makes "found it" and "counted it" one step -- a retire
        cannot slip between them."""
        self._counts[workspace_id] = self._counts.get(workspace_id, 0) + 1
        returned_within_grace = self._pending.pop(workspace_id, None)
        if returned_within_grace:
            _ = returned_within_grace.cancel()
        return controller

    async def _leave(self, workspace_id: UUID) -> None:
        async with self._lock:
            self._counts[workspace_id] = max(0, self._counts.get(workspace_id, 0) - 1)
            self._schedule_release_if_idle(workspace_id)

    # -- lifecycle ----------------------------------------------------------

    async def _committed(self, workspace_id: UUID) -> int:
        async with self._database.session() as session:
            return await self._stream.high_water(session, workspace_id)

    def _seeded(self, workspace_id: UUID, committed: int) -> WorkspaceController:
        """A controller starting above everything this workspace has used.

        The logs are the truth, and a fresh process has nothing else to read.
        But they can UNDERSTATE it: a submission that rolled back consumed a
        position no committed row carries, and a successor reading only the
        logs would hand that number out a second time. So this process also
        remembers the last position each of its own controllers issued, past
        the controller itself, and takes it as a floor. One integer per
        workspace it has ever served -- the cheapest thing in the registry.

        Read under the lock, at the moment of installation rather than at the
        moment the database was read, so a controller that lived and retired
        while this one was being seeded still raises the floor.
        """
        controller = WorkspaceController(
            workspace_id, Positions(max(committed, self._issued.get(workspace_id, 0)))
        )
        self._controllers[workspace_id] = controller
        return controller

    def _schedule_release_if_idle(self, workspace_id: UUID) -> None:
        idle = self._counts.get(workspace_id, 0) == 0
        if idle and workspace_id not in self._pending:
            self._pending[workspace_id] = asyncio.get_running_loop().create_task(
                self._release_later(workspace_id)
            )

    async def _release_later(self, workspace_id: UUID) -> None:
        try:
            await asyncio.sleep(self.grace_seconds)
        except asyncio.CancelledError:
            return
        async with self._lock:
            _ = self._pending.pop(workspace_id, None)
            if self._counts.get(workspace_id, 0) == 0:  # re-check INSIDE the lock
                self._retire(workspace_id)

    def _retire(self, workspace_id: UUID) -> None:
        """The controller goes; the last position it issued stays.

        Everything else is rebuilt from the logs by whoever takes the
        workspace on next, which is what makes a kill -9 and a clean shutdown
        the same event for a workspace. Why the position survives is in
        `_seeded`.
        """
        _ = self._counts.pop(workspace_id, None)
        _ = self._seeding.pop(workspace_id, None)
        retiring = self._controllers.pop(workspace_id, None)
        if retiring is not None:
            self._issued[workspace_id] = max(
                retiring.positions.at, self._issued.get(workspace_id, 0)
            )

    async def shutdown(self) -> None:
        async with self._lock:
            for pending in self._pending.values():
                _ = pending.cancel()
            self._pending.clear()
            for workspace_id in list(self._controllers):
                self._retire(workspace_id)

    # -- introspection (tests, ops) ------------------------------------------

    def live(self, workspace_id: UUID) -> WorkspaceController | None:
        return self._controllers.get(workspace_id)

    def count(self, workspace_id: UUID) -> int:
        return self._counts.get(workspace_id, 0)
