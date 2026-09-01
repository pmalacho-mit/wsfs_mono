from __future__ import annotations

from typing import final

import httpx


API = "https://api.liveblocks.io"


@final
class Liveblocks:
    """Liveblocks over plain HTTP, as the token mint already reaches it.

    Not through the published SDK: it asserts the shape of the secret before
    sending anything (disabling attempts to use a secret poxy).
    """

    def __init__(self, secret: str) -> None:
        self._headers = {"Authorization": f"Bearer {secret}"}

    async def create(self, room: str) -> None:
        await self._sent(
            "POST",
            "/v2/rooms?idempotent=true",
            json={"id": room, "defaultAccesses": ["room:write"]},
        )

    async def document(self, room: str) -> bytes:
        """A room nobody has written to yet reads as nothing, not as an error."""
        answer = await self._asked("GET", f"/v2/rooms/{room}/ydoc-binary")
        return answer.content if answer.status_code == 200 else b""

    async def send(self, room: str, update: bytes) -> None:
        await self._sent(
            "PUT",
            f"/v2/rooms/{room}/ydoc",
            content=update,
            headers={"content-type": "application/octet-stream"},
        )

    async def _asked(self, method: str, path: str, **carrying) -> httpx.Response:
        headers = {**self._headers, **carrying.pop("headers", {})}
        async with httpx.AsyncClient(timeout=20) as client:
            return await client.request(
                method, f"{API}{path}", headers=headers, **carrying
            )

    async def _sent(self, method: str, path: str, **carrying) -> None:
        answer = await self._asked(method, path, **carrying)
        if answer.status_code >= 400:
            raise RuntimeError(
                f"liveblocks {method} {path}: {answer.status_code} {answer.text}"
            )
