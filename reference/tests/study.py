"""The nudge study's records: episodes, offers, cooldowns, windows, activity.

WHAT IS BEING TESTED IS THAT NOTHING IS LOST QUIETLY AND NOTHING IS COUNTED
TWICE. These rows are allowed to fail to arrive -- a client posts and moves on
-- so the failure mode worth guarding against is the other one: a row that
arrives and is written down as two, or an episode whose window is recorded and
whose cooldown is not.

Read straight out of the tables rather than through a read API, because there
isn't one and there should not be: what is written here is read by whoever is
analysing the term, with the questions they have then.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlmodel import Session, select

from conftest import Api, new_id
from wsfs_suede.samples.backend.app import MODELS as models

ONSET = datetime(2026, 3, 4, 15, 30, tzinfo=timezone.utc)


def span(began: datetime, minutes: int) -> dict[str, str]:
    return {
        "began": began.isoformat(),
        "ends": (began + timedelta(minutes=minutes)).isoformat(),
    }


async def detected(api: Api, **over: Any) -> tuple[str, httpx.Response]:
    episode = over.pop("episode", None) or new_id()
    told: dict[str, Any] = {
        "episode": episode,
        "at": ONSET.isoformat(),
        "rule": "idle",
        "became": "offered",
        "detail": "no action for 180s",
        "course_event": "6.100L Lecture 3",
        "path": "/demo.py",
        "code": "print('hello'",
        "cooldown": span(ONSET, 20),
        "window": span(ONSET, 10),
    }
    told.update(over)
    return episode, await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/study/episodes",
        json=told,
        headers={"X-User-Email": api.user},
    )


async def accepted(api: Api, episode: str, **over: Any) -> httpx.Response:
    told: dict[str, Any] = {
        "offer": over.pop("offer", None) or new_id(),
        "episode": episode,
        "at": (ONSET + timedelta(seconds=6)).isoformat(),
        "course_event": "6.100L Lecture 3",
    }
    told.update(over)
    return await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/study/offers",
        json=told,
        headers={"X-User-Email": api.user},
    )


async def recorded(api: Api, episode: str, moments: list[dict[str, Any]]):
    return await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/study/activity",
        json={"episode": episode, "moments": moments},
        headers={"X-User-Email": api.user},
    )


def rows(session: Session, table: Any) -> list[Any]:
    return list(session.exec(select(table)).all())


async def test_an_episode_records_itself_its_cooldown_and_its_window(
    api: Api, session: Session
):
    """One post, three rows, all naming the same episode.

    The three are separate facts with separate lives, and they are decided in
    the same instant by the same coin -- so they arrive together or an episode
    claims a period that nothing records.
    """
    episode, response = await detected(api)
    assert response.status_code == 204, response.text

    (kept,) = rows(session, models.episode)
    assert str(kept.id) == episode
    assert kept.rule.value == "idle"
    assert kept.outcome.value == "offered"
    assert kept.course_event == "6.100L Lecture 3"
    assert kept.path == "/demo.py"
    assert kept.code == "print('hello'"
    assert kept.at == ONSET
    assert str(kept.user_id) != ""

    (cooldown,) = rows(session, models.cooldown)
    (window,) = rows(session, models.stuck_window)
    assert str(cooldown.episode_id) == episode
    assert str(window.episode_id) == episode
    assert cooldown.ends - cooldown.began == timedelta(minutes=20)
    assert window.ends - window.began == timedelta(minutes=10)


async def test_a_silent_episode_records_a_window_and_no_cooldown(
    api: Api, session: Session
):
    """The comparison the study rests on: both arms open the same window, and
    only a prompt that was SHOWN starts a cooldown."""
    _, response = await detected(api, became="silent", cooldown=None)
    assert response.status_code == 204

    (kept,) = rows(session, models.episode)
    assert kept.outcome.value == "silent"
    assert rows(session, models.cooldown) == []
    assert len(rows(session, models.stuck_window)) == 1


async def test_an_episode_the_protocol_held_back_is_still_recorded(
    api: Api, session: Session
):
    """A detection that arrived during a cooldown is a fact about a student
    being stuck. Without it, an analysis cannot tell "stuck four times, told
    once" from "stuck once"."""
    _, response = await detected(
        api,
        became="held back by the cooldown",
        cooldown=None,
        window=None,
    )
    assert response.status_code == 204

    (kept,) = rows(session, models.episode)
    assert kept.outcome.value == "held back by the cooldown"
    assert rows(session, models.cooldown) == []
    assert rows(session, models.stuck_window) == []


async def test_the_same_episode_posted_twice_is_recorded_once(
    api: Api, session: Session
):
    """The id is the client's, so a retry -- which is what a client does when
    an answer is lost rather than the request -- costs nothing."""
    episode, first = await detected(api)
    _, again = await detected(api, episode=episode)
    assert (first.status_code, again.status_code) == (204, 204)

    assert len(rows(session, models.episode)) == 1
    assert len(rows(session, models.cooldown)) == 1
    assert len(rows(session, models.stuck_window)) == 1


async def test_an_accepted_offer_is_recorded_against_its_episode(
    api: Api, session: Session
):
    episode, _ = await detected(api)
    assert (await accepted(api, episode)).status_code == 204

    (offer,) = rows(session, models.offer)
    assert str(offer.episode_id) == episode
    assert offer.at == ONSET + timedelta(seconds=6)
    assert offer.course_event == "6.100L Lecture 3"


async def test_an_offer_for_an_episode_nobody_recorded_is_not_an_error(
    api: Api, session: Session
):
    """A client whose episode post was lost still reports the click.

    There is nothing to attach it to and nothing a student loses by it, so the
    route answers as it always does -- see the note at the top of `study.py`.
    A 500 here would be a study's bookkeeping surfacing in somebody's console.
    """
    response = await accepted(api, new_id())
    assert response.status_code == 204
    assert rows(session, models.offer) == []


async def test_activity_arrives_as_batches_of_opaque_moments(
    api: Api, session: Session
):
    """The shape belongs to whatever noticed the thing; only `at` and `kind`
    are this package's business."""
    episode, _ = await detected(api)
    moments = [
        {
            "at": (ONSET + timedelta(seconds=1)).isoformat(),
            "kind": "edit",
            "did": "typed",
            "inserted": "x = ",
            "removed": 0,
        },
        {
            "at": (ONSET + timedelta(seconds=2)).isoformat(),
            "kind": "panel active",
            "visible": ["/demo.py"],
        },
    ]
    assert (await recorded(api, episode, moments)).status_code == 204

    (batch,) = rows(session, models.activity)
    assert str(batch.episode_id) == episode
    assert [one["kind"] for one in batch.moments] == ["edit", "panel active"]
    assert batch.moments[0]["inserted"] == "x = "
    assert batch.moments[1]["visible"] == ["/demo.py"]


async def test_two_flushes_of_one_window_are_two_rows(api: Api, session: Session):
    """A batch is whatever was in the buffer when the timer went, so unlike
    everything else here it is not something the client names -- and two of
    them are two rows rather than one overwriting the other."""
    episode, _ = await detected(api)
    await recorded(api, episode, [{"at": ONSET.isoformat(), "kind": "interaction"}])
    await recorded(api, episode, [{"at": ONSET.isoformat(), "kind": "ran"}])

    kept = rows(session, models.activity)
    assert len(kept) == 2
    assert sorted(one.moments[0]["kind"] for one in kept) == ["interaction", "ran"]


async def test_an_empty_flush_writes_nothing(api: Api, session: Session):
    episode, _ = await detected(api)
    assert (await recorded(api, episode, [])).status_code == 204
    assert rows(session, models.activity) == []


async def test_the_student_is_whoever_authorised_and_not_whoever_asked(
    api: Api, other: Api, session: Session
):
    """Two people in one workspace are two students, and neither of them says
    so in the body -- the body has no field for it."""
    await detected(api)
    await detected(other)

    whose = {str(one.user_id) for one in rows(session, models.episode)}
    assert len(whose) == 2
