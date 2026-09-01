"""Tutors a test wrote, for the two suites that need one.

Nothing in either suite talks to a model. A tutor is one method -- see
`wsfs_assistant_suede.backend.tutor.ITutor` -- so these hand over one that says
what the test told it to, which is the whole reason that seam exists. Shared
rather than copied because the assistant's suite and the tutoring feature's
suite are asking the same thing of it.
"""

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator, Sequence

from fastapi import FastAPI

from conftest import Api, open_workspace, serving
from wsfs_mono.wsfs_assistant_suede.backend.tutor import ITutor, Said


class Scripted(ITutor):
    """Says what it was told to, one delta at a time, and remembers the ask."""

    def __init__(
        self, *deltas: str, fails: str | None = None, pause: float = 0.0
    ) -> None:
        self.deltas = deltas or ("hello",)
        self.fails = fails
        self.pause = pause
        """Seconds between deltas, for a test about WHEN they arrive."""
        self.asked: list[Sequence[Said]] = []

    @property
    def model(self) -> str:
        return "scripted"

    async def answer(self, said: Sequence[Said]) -> AsyncIterator[str]:
        self.asked.append(list(said))
        for delta in self.deltas:
            if self.pause:
                await asyncio.sleep(self.pause)
            yield delta
        if self.fails is not None:
            raise RuntimeError(self.fails)


@asynccontextmanager
async def tutored(processes, tutor: ITutor) -> AsyncIterator[Api]:
    """A host whose tutor the test wrote, and one client onto it."""
    app: FastAPI = processes(tutor=tutor)
    async with serving(app) as http:
        workspace = await open_workspace(http)
        yield Api(http, workspace, user="ada@example.com")
