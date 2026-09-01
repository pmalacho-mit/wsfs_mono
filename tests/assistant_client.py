"""Driving the chat routes over HTTP, for whoever needs to.

Here rather than in the assistant's own suite because `wsfs_pytutor_suede`'s
tests reach the assistant too -- the progress check must prove it carries no
conversation, which means putting a conversation there first. One spelling of
each request, so the two suites cannot disagree about what one looks like.
"""

import json
from typing import Any

from conftest import Api, new_id


async def ask(api: Api, **request: Any) -> dict[str, Any]:
    request.setdefault("message", new_id())
    answer = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/chat",
        json=request,
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


async def heard(api: Api, token: str) -> list[dict[str, Any]]:
    """Everything the stream says, until it says it ended."""
    events: list[dict[str, Any]] = []
    async with api.http.stream(
        "GET",
        f"/wsfs/workspaces/{api.workspace}/chat/stream",
        params={"token": token},
        headers={"X-User-Email": api.user},
        timeout=20.0,
    ) as answer:
        assert answer.status_code == 200, await answer.aread()
        async for line in answer.aiter_lines():
            if not line.startswith("data: "):
                continue
            events.append(json.loads(line[len("data: ") :]))
            if events[-1]["type"] == "ended":
                break
    return events


async def transcript(api: Api, **params: Any) -> dict[str, Any]:
    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/chat",
        params=params,
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    return answer.json()
