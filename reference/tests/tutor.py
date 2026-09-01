"""The tutor: what it is asked, what it is shown, and what it says back.

Nothing here talks to a model. A tutor is one method to this package -- see
`release.backend.tutor.ITutor` -- so these hand over one that says what the
test told it to, which is the whole reason that seam exists.
"""

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Sequence

import httpx
import pytest
from fastapi import FastAPI

from conftest import Api, acknowledged, new_id, open_workspace, serving
from wsfs_suede.release.backend.tutor import ITutor, Said, Tutoring


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


async def a_file(api: Api, content: str) -> tuple[str, dict[str, Any]]:
    entry = new_id()
    acknowledged(
        await api.create(
            entry, name=f"{entry}.py", content={"type": "text", "content": content}
        )
    )
    answer = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/initialize",
        json={"outbox": []},
        headers={"X-User-Email": api.user},
    )
    metadata = [one for one in answer.json()["entries"] if one["id"] == entry][0]
    return entry, metadata


def seen(entry: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry,
        "name_version": metadata["name_version"],
        "parent_version": metadata["parent_version"],
        "deleted_version": metadata["deleted_version"],
        "content_version": metadata["content_version"],
    }


async def a_snapshot(api: Api, entry: str, metadata: dict[str, Any]) -> str:
    transaction = api.transaction()
    acknowledged(
        await api.submit(
            op="snapshot",
            transaction=transaction,
            id=entry,
            entries=[seen(entry, metadata)],
        )
    )
    return transaction


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


# -- asking ---------------------------------------------------------------------------


async def test_a_question_is_answered_on_the_stream_the_ask_names(processes):
    """The whole shape: ask, get a token, hear the answer on it."""
    tutor = Scripted("Because ", "the loop ", "never ends.")
    async with tutored(processes, tutor) as api:
        asked = await ask(api, text="why is this slow?")
        events = await heard(api, asked["token"])

    assert [one["delta"] for one in events if one["type"] == "delta"] == [
        "Because ",
        "the loop ",
        "never ends.",
    ]
    ended = events[-1]
    assert ended["type"] == "ended"
    assert ended["text"] == "Because the loop never ends."
    assert ended["failure"] is None


async def test_the_answer_is_written_down_whether_or_not_anybody_listened(processes):
    """A person who asks and closes the tab has still asked."""
    async with tutored(processes, Scripted("kept")) as api:
        asked = await ask(api, text="anyone there?")
        """Nothing attaches. The generation runs regardless, so this waits for
        the row rather than for a stream."""
        for _ in range(100):
            said = await transcript(api)
            if said["turns"] and said["turns"][0]["answer"]:
                break
            await asyncio.sleep(0.05)

        said = await transcript(api)
        assert said["turns"][0]["message"] == asked["message"]
        assert said["turns"][0]["answer"] == "kept"
        assert said["turns"][0]["model"] == "scripted"


async def test_a_model_that_falls_over_is_recorded_rather_than_dropped(processes):
    """A transcript that skips the turn where it broke reads as if nobody
    asked."""
    async with tutored(processes, Scripted("half an ", fails="the model hung up")) as api:
        asked = await ask(api, text="explain this")
        events = await heard(api, asked["token"])
        assert events[-1]["failure"] == "the model hung up"
        assert events[-1]["text"] == "half an "

        for _ in range(100):
            said = await transcript(api)
            if said["turns"] and said["turns"][0]["failure"]:
                break
            await asyncio.sleep(0.05)
        assert (await transcript(api))["turns"][0]["failure"] == "the model hung up"


async def test_asking_the_same_question_twice_asks_it_once(processes):
    """A retry is what a dropped connection produces, not a second question."""
    async with tutored(processes, Scripted("once")) as api:
        message = new_id()
        first = await ask(api, message=message, text="did that arrive?")
        second = await ask(api, message=message, text="did that arrive?")

        assert first["message"] == second["message"] == message
        """A new token, because the reason to retry is that the answer never
        came -- but only one question in the transcript."""
        assert first["token"] != second["token"]
        said = await transcript(api)
        assert [one["message"] for one in said["turns"]] == [message]


# -- what it is shown -----------------------------------------------------------------


async def test_an_attached_file_is_shown_in_full(processes):
    """The point of attaching one. Its name and its whole contents."""
    tutor = Scripted("read it")
    async with tutored(processes, tutor) as api:
        entry, metadata = await a_file(api, "def total(xs):\n    return sum(xs)\n")
        snapshot = await a_snapshot(api, entry, metadata)
        asked = await ask(
            api,
            text="what does this do?",
            snapshot=snapshot,
            attached=[{"entry": entry, "executions": []}],
        )
        await heard(api, asked["token"])

    said = tutor.asked[0]
    assert said[0].role == "system"
    asking = said[-1]
    assert asking.role == "user"
    assert "what does this do?" in asking.text
    assert "def total(xs):\n    return sum(xs)" in asking.text
    assert f"{entry}.py" in asking.text


async def test_an_attached_run_brings_its_output_with_it(processes):
    """A tutor asked why something failed should not have to guess at the
    traceback it was not shown."""
    tutor = Scripted("that is a NameError")
    async with tutored(processes, tutor) as api:
        entry, metadata = await a_file(api, "print(undefined_name)\n")
        snapshot = await a_snapshot(api, entry, metadata)
        execution = api.transaction()
        acknowledged(
            await api.submit(
                op="execute",
                transaction=execution,
                id=entry,
                snapshot=snapshot,
                outputs=[{"output_type": "error", "text": "NameError: undefined_name"}],
                ok=False,
            )
        )
        asked = await ask(
            api,
            text="why did it fail?",
            snapshot=snapshot,
            attached=[{"entry": entry, "executions": [execution]}],
        )
        await heard(api, asked["token"])

    asking = tutor.asked[0][-1]
    assert "NameError: undefined_name" in asking.text
    assert "raised" in asking.text


async def test_only_this_question_carries_files(processes):
    """The rule that keeps a long conversation affordable: what a past turn
    contributes is what was SAID, not the file it was said about."""
    tutor = Scripted("noted")
    async with tutored(processes, tutor) as api:
        entry, metadata = await a_file(api, "SECRET_MARKER = 1\n")
        snapshot = await a_snapshot(api, entry, metadata)

        first = await ask(
            api,
            text="first question",
            snapshot=snapshot,
            attached=[{"entry": entry, "executions": []}],
        )
        await heard(api, first["token"])

        second = await ask(api, text="second question")
        await heard(api, second["token"])

    """The first question was shown the file."""
    assert "SECRET_MARKER" in tutor.asked[0][-1].text

    """The second is shown the CONVERSATION and not the file -- including the
    first question as it was stored, which is its text and never the block
    that was built around it."""
    carried = tutor.asked[1]
    assert [one.role for one in carried] == ["system", "user", "assistant", "user"]
    assert not any("SECRET_MARKER" in one.text for one in carried)
    assert carried[1].text == "first question"
    assert carried[2].text == "noted", "and what the tutor said is carried"


async def test_a_question_with_no_snapshot_is_still_answered(processes):
    """A snapshot is a transaction and can be refused, or never sent. A tutor
    answering from the question alone beats an error."""
    tutor = Scripted("from the question alone")
    async with tutored(processes, tutor) as api:
        asked = await ask(api, text="what is a list comprehension?")
        events = await heard(api, asked["token"])

    assert events[-1]["text"] == "from the question alone"
    assert "what is a list comprehension?" == tutor.asked[0][-1].text


async def test_a_file_a_snapshot_never_named_is_reported_not_invented(processes):
    """A hole is a fact. Saying nothing about it would let the tutor answer as
    though it had read a file it never saw."""
    tutor = Scripted("cannot see it")
    async with tutored(processes, tutor) as api:
        entry, metadata = await a_file(api, "x = 1\n")
        elsewhere, _ = await a_file(api, "y = 2\n")
        snapshot = await a_snapshot(api, entry, metadata)
        asked = await ask(
            api,
            text="what about the other one?",
            snapshot=snapshot,
            attached=[{"entry": elsewhere, "executions": []}],
        )
        await heard(api, asked["token"])

    assert "could not be recovered" in tutor.asked[0][-1].text


# -- reading it back ------------------------------------------------------------------


async def test_the_transcript_pages_backwards_from_newest(processes):
    """What the panel does on load, and again when somebody scrolls up."""
    async with tutored(processes, Scripted("ok")) as api:
        for i in range(5):
            asked = await ask(api, text=f"question {i}")
            await heard(api, asked["token"])

        newest = await transcript(api, limit=2)
        assert [one["text"] for one in newest["turns"]] == ["question 4", "question 3"]
        assert newest["more"] is True

        older = await transcript(
            api, limit=2, before=newest["turns"][-1]["at"]["accepted"]
        )
        assert [one["text"] for one in older["turns"]] == ["question 2", "question 1"]
        assert older["more"] is True

        oldest = await transcript(
            api, limit=2, before=older["turns"][-1]["at"]["accepted"]
        )
        assert [one["text"] for one in oldest["turns"]] == ["question 0"]
        assert oldest["more"] is False


async def test_one_persons_conversation_is_their_own(processes):
    """A workspace can have more than one person in it, and what somebody
    asked a tutor is theirs."""
    async with tutored(processes, Scripted("ok")) as api:
        mine = await ask(api, text="mine")
        await heard(api, mine["token"])

        grace = Api(api.http, api.workspace, user="grace@example.com")
        theirs = await ask(grace, text="theirs")
        await heard(grace, theirs["token"])

        assert [one["text"] for one in (await transcript(api))["turns"]] == ["mine"]
        assert [one["text"] for one in (await transcript(grace))["turns"]] == ["theirs"]


async def test_a_read_back_turn_says_what_went_with_it(processes):
    """So a transcript loaded on a fresh page draws the same attachments the
    panel drew when the question was asked."""
    async with tutored(processes, Scripted("ok")) as api:
        entry, metadata = await a_file(api, "print(1)\n")
        snapshot = await a_snapshot(api, entry, metadata)
        execution = api.transaction()
        acknowledged(
            await api.submit(
                op="execute",
                transaction=execution,
                id=entry,
                snapshot=snapshot,
                outputs=[{"output_type": "stream", "text": "1\n"}],
                ok=True,
            )
        )
        asked = await ask(
            api,
            text="what ran?",
            snapshot=snapshot,
            attached=[{"entry": entry, "executions": [execution]}],
        )
        await heard(api, asked["token"])

        turn = (await transcript(api))["turns"][0]
        assert turn["snapshot"] == snapshot
        assert len(turn["attached"]) == 1
        assert turn["attached"][0]["entry"] == entry
        assert [one["transaction"] for one in turn["attached"][0]["executions"]] == [
            execution
        ]
        assert turn["attached"][0]["executions"][0]["outputs"] == [
            {"output_type": "stream", "text": "1\n"}
        ]


async def test_a_file_attached_with_nothing_run_is_still_attached(processes):
    """The null execution is what records that -- see `ChatAttachmentRow`."""
    async with tutored(processes, Scripted("ok")) as api:
        entry, metadata = await a_file(api, "x = 1\n")
        snapshot = await a_snapshot(api, entry, metadata)
        asked = await ask(
            api,
            text="just the file",
            snapshot=snapshot,
            attached=[{"entry": entry, "executions": []}],
        )
        await heard(api, asked["token"])

        turn = (await transcript(api))["turns"][0]
        assert [one["entry"] for one in turn["attached"]] == [entry]
        assert turn["attached"][0]["executions"] == []


async def test_a_token_nobody_minted_is_not_a_stream(processes):
    async with tutored(processes, Scripted("ok")) as api:
        answer = await api.http.get(
            f"/wsfs/workspaces/{api.workspace}/chat/stream",
            params={"token": "made-up"},
            headers={"X-User-Email": api.user},
        )
        assert answer.status_code == 404, answer.text


async def test_an_answer_can_be_heard_twice(processes):
    """The token is not spent by being read: a page that reloaded mid-answer
    picks the same one up again."""
    async with tutored(processes, Scripted("said ", "once")) as api:
        asked = await ask(api, text="say it")
        first = await heard(api, asked["token"])
        second = await heard(api, asked["token"])
        assert first[-1]["text"] == second[-1]["text"] == "said once"


async def test_the_answer_is_flushed_as_it_is_written(processes):
    """A tutor is a conversation, so the first words have to arrive first.

    The claim is about TIME, which is why this is not simply "three deltas
    came out": a server that collected the whole answer and sent it at the end
    would produce exactly the same three. So the tutor pauses between them and
    this measures when each one lands -- the first must arrive while the last
    is still being written.
    """
    pause = 0.3
    async with tutored(processes, Scripted("one ", "two ", "three", pause=pause)) as api:
        asked = await ask(api, text="say three things slowly")

        arrivals: list[tuple[float, str]] = []
        started = time.monotonic()
        async with api.http.stream(
            "GET",
            f"/wsfs/workspaces/{api.workspace}/chat/stream",
            params={"token": asked["token"]},
            headers={"X-User-Email": api.user},
            timeout=20.0,
        ) as answer:
            async for line in answer.aiter_lines():
                if not line.startswith("data: "):
                    continue
                said = json.loads(line[len("data: ") :])
                arrivals.append((time.monotonic() - started, said["type"]))
                if said["type"] == "ended":
                    break

    deltas = [at for at, kind in arrivals if kind == "delta"]
    assert len(deltas) == 3, arrivals
    ended = arrivals[-1][0]

    """The first is out before the last was even produced."""
    assert deltas[0] < ended - pause, f"first at {deltas[0]:.2f}s, ended {ended:.2f}s"
    """And they are spread out rather than arriving together."""
    assert deltas[-1] - deltas[0] > pause, arrivals


# -- has this moved? ------------------------------------------------------------------


async def judge(api: Api, **request: Any) -> dict[str, Any]:
    answer = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/progress",
        json=request,
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


async def test_progress_is_read_from_the_first_word(processes):
    """A sentence explaining why there is NO progress contains "no", and half
    the ways of saying it contain "yes" too -- so the verdict is the first
    word and the rest is the reason."""
    async with tutored(processes, Scripted("NO\n", "Nothing has changed since.")) as api:
        said = await judge(api, goal="print hello twice", before="x=1", after="x=1")
        assert said["progressing"] is False
        assert said["why"] == "Nothing has changed since."

    async with tutored(processes, Scripted("YES\n", "They added the loop.")) as api:
        said = await judge(api, goal="print hello twice", before="x=1", after="for i in ...")
        assert said["progressing"] is True
        assert said["why"] == "They added the loop."


async def test_a_progress_check_carries_no_conversation(processes):
    """The whole difference between this and a question. Something said an
    hour ago must not decide what this minute looks like."""
    tutor = Scripted("NO\n", "same")
    async with tutored(processes, tutor) as api:
        asked = await ask(api, text="remember this sentence")
        await heard(api, asked["token"])
        await judge(api, goal="a goal", before="a", after="b")

    said = tutor.asked[-1]
    assert [one.role for one in said] == ["system", "user"], said
    assert "remember this sentence" not in said[-1].text
    """And it IS shown both versions, and the goal."""
    assert "a goal" in said[-1].text
    assert "\na\n" in said[-1].text and "\nb\n" in said[-1].text


async def test_a_progress_check_records_nothing(processes):
    """It is a measurement, not a turn. The transcript must not grow one."""
    async with tutored(processes, Scripted("NO\n", "same")) as api:
        await judge(api, goal="a goal", before="a", after="b")
        assert (await transcript(api))["turns"] == []
