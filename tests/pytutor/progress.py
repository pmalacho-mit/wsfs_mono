"""Whether a student has got anywhere, asked on a timer.

The route is this package's; the model behind it is the assistant's `ITutor`,
which is the whole arrangement -- one provider, one key, and a measurement that
is not part of anybody's conversation.
"""

from typing import Any

from conftest import Api
from tutors import Scripted, tutored
from assistant_client import ask, heard, transcript


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
