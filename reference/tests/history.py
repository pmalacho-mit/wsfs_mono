"""What one file has said, and who is allowed to be told.

The list a user reads when work seems to have gone. Three kinds of thing go
into it and they come from two tables: what the workspace accepted, and what
this user asked and did not get -- either because the system declined it, or
because they kept it having reached nobody.

THE ONE RULE THAT IS NOT ABOUT ORDERING: a draft is work that reached nobody,
so its author is the only person who has ever seen it. Another user's history
of the same file must not contain it.
"""

from typing import Any

import httpx

from conftest import Api, acknowledged, new_id, refused

from wsfs_suede.release.backend.contract import Refusal


async def a_file(api: Api, content: str = "one\n") -> tuple[str, str]:
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry,
            name=f"{entry}.py",
            transaction=born,
            content={"type": "text", "content": content},
        )
    )
    return entry, born


async def history(
    api: Api, entry: str, **query: Any
) -> tuple[list[dict[str, Any]], bool]:
    answer: httpx.Response = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/entries/{entry}/history",
        params=query,
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    body = answer.json()
    return body["versions"], body["more"]


async def test_a_files_versions_come_back_newest_first(api: Api):
    entry, born = await a_file(api)
    at = born
    for said in ("two\n", "three\n"):
        transaction = api.transaction()
        acknowledged(await api.write(entry, at, said, transaction=transaction))
        at = transaction

    versions, more = await history(api, entry)
    assert [one["standing"] for one in versions] == ["applied"] * 3
    assert [one["size"] for one in versions] == [6, 4, 4]
    assert more is False


async def test_the_size_is_the_files_rather_than_the_rows(api: Api):
    """A text row stores a delta, so measuring what it holds would report the
    size of an edit script rather than of the file."""
    entry, born = await a_file(api, "a" * 500 + "\n")
    acknowledged(await api.write(entry, born, "a" * 500 + "b\n"))

    versions, _ = await history(api, entry)
    assert [one["size"] for one in versions] == [502, 501]


async def test_my_drafts_and_refusals_are_here_and_told_apart(api: Api):
    entry, born = await a_file(api)
    kept = api.transaction()
    acknowledged(await api.write(entry, born, "kept\n", transaction=kept, draft=True))

    """Moved on by somebody, and then written against where it used to be --
    a token that was REAL and is no longer current, which is an ordinary
    conflict rather than a client reasoning from a state that never was."""
    moved = api.transaction()
    acknowledged(await api.write(entry, born, "two\n", transaction=moved))
    declined = refused(await api.write(entry, born, "stale\n"))
    assert declined["reason"] == Refusal.ALREADY_WRITTEN

    versions, _ = await history(api, entry)
    standing = {one["transaction"]: one["standing"] for one in versions}
    assert standing[kept] == "draft"
    assert standing[born] == "applied"
    assert "refused" in standing.values()

    """A draft's reason is always the same one and is already its standing;
    a refusal's is the thing worth reading."""
    for one in versions:
        assert (one["why"] is None) == (one["standing"] != "refused")


async def test_another_users_draft_is_not_in_my_history(api: Api, other: Api):
    """The whole of the access rule. A draft reached nobody, so nobody else
    may be shown it -- while what the workspace ACCEPTED belongs to everyone,
    because accepting it is what sharing means."""
    entry, born = await a_file(api)

    mine = api.transaction()
    acknowledged(await api.write(entry, born, "mine\n", transaction=mine, draft=True))
    theirs = other.transaction()
    acknowledged(
        await other.write(entry, born, "theirs\n", transaction=theirs, draft=True)
    )

    ours, _ = await history(api, entry)
    named = [one["transaction"] for one in ours]
    assert mine in named
    assert theirs not in named

    yours, _ = await history(other, entry)
    named = [one["transaction"] for one in yours]
    assert theirs in named
    assert mine not in named

    """And the accepted version is in both."""
    assert born in [one["transaction"] for one in ours]
    assert born in [one["transaction"] for one in yours]


async def test_paging_by_before_shows_each_version_once(api: Api):
    entry, born = await a_file(api)
    at = born
    for said in ("two\n", "three\n", "four\n", "five\n"):
        transaction = api.transaction()
        acknowledged(await api.write(entry, at, said, transaction=transaction))
        at = transaction

    first, more = await history(api, entry, limit=2)
    assert more is True
    assert len(first) == 2

    second, more = await history(
        api, entry, limit=2, before=first[-1]["at"]["accepted"]
    )
    assert len(second) == 2
    assert more is True

    third, more = await history(
        api, entry, limit=2, before=second[-1]["at"]["accepted"]
    )
    assert more is False

    seen = [one["transaction"] for one in (*first, *second, *third)]
    assert len(seen) == len(set(seen)), "a version was shown twice"
    assert len(seen) == 5


async def test_more_is_honest_at_the_boundary(api: Api):
    """Exactly as many as asked for, and no others: `more` must not claim a
    page that is not there just because the page was full."""
    entry, _ = await a_file(api)
    versions, more = await history(api, entry, limit=1)
    assert len(versions) == 1
    assert more is False


async def test_an_entry_from_another_workspace_is_not_readable(
    api: Api, instance: httpx.AsyncClient
):
    """`authorize` answers for the WORKSPACE, and an entry is named by an id a
    caller can guess -- so the entry has to be checked to belong to the
    workspace the door was opened for."""
    entry, _ = await a_file(api)
    elsewhere = (
        await instance.post("/projects", headers={"X-User-Email": api.user})
    ).json()["id"]

    answer = await instance.get(
        f"/wsfs/workspaces/{elsewhere}/entries/{entry}/history",
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200
    assert answer.json()["versions"] == []
