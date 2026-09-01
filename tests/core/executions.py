"""Two things a client records that change nothing.

A snapshot is a claim that the workspace looked like this. An execution is
what came out of running one of those files, against one of those snapshots.
Both are transactions -- which is what puts them in the outbox, and the outbox
is the one machine here that promises delivery.

What is worth testing is mostly what they are NOT: not entry mutations, not in
the event stream, and not keepable when the claim they make refers to nothing.
"""

from typing import Any

import httpx

from conftest import Api, acknowledged, new_id, refused


async def a_file(api: Api, content: str = "print(1)\n") -> tuple[str, dict[str, Any]]:
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


async def test_a_snapshot_keeps_every_entry_at_its_versions(api: Api):
    entry, metadata = await a_file(api)
    snapshot = await a_snapshot(api, entry, metadata)

    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/snapshots/{snapshot}",
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    kept = answer.json()["entries"]
    assert len(kept) == 1
    assert kept[0]["entry"] == entry
    """All four, because together they ARE the entry -- a snapshot that kept
    only content could not say what the file was called at the time."""
    assert kept[0]["name_version"] == metadata["name_version"]
    assert kept[0]["parent_version"] == metadata["parent_version"]
    assert kept[0]["deleted_version"] == metadata["deleted_version"]
    assert kept[0]["content_version"] == metadata["content_version"]


async def test_a_snapshot_of_a_state_that_never_was_is_refused(api: Api):
    """A claim about a state nobody was ever in is not worth keeping."""
    entry, metadata = await a_file(api)
    invented = dict(seen(entry, metadata), name_version=new_id())
    declined = refused(
        await api.submit(op="snapshot", id=entry, entries=[invented])
    )
    assert "never issued" in declined["reason"]


async def test_a_snapshot_of_nothing_is_refused(api: Api):
    entry, _ = await a_file(api)
    declined = refused(await api.submit(op="snapshot", id=entry, entries=[]))
    assert "describes nothing" in declined["reason"]


async def test_an_execution_is_kept_against_its_snapshot(api: Api):
    entry, metadata = await a_file(api)
    snapshot = await a_snapshot(api, entry, metadata)
    transaction = api.transaction()
    acknowledged(
        await api.submit(
            op="execute",
            transaction=transaction,
            id=entry,
            snapshot=snapshot,
            outputs=[{"output_type": "stream", "text": "1\n"}],
            ok=True,
        )
    )

    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/entries/{entry}/executions",
        headers={"X-User-Email": api.user},
    )
    assert answer.status_code == 200, answer.text
    runs = answer.json()["executions"]
    assert len(runs) == 1
    assert runs[0]["transaction"] == transaction
    assert runs[0]["snapshot"] == snapshot
    assert runs[0]["ok"] is True
    assert runs[0]["outputs"] == [{"output_type": "stream", "text": "1\n"}]


async def test_executions_come_back_newest_first(api: Api):
    entry, metadata = await a_file(api)
    snapshot = await a_snapshot(api, entry, metadata)
    made = []
    for said in ("one", "two", "three"):
        transaction = api.transaction()
        acknowledged(
            await api.submit(
                op="execute",
                transaction=transaction,
                id=entry,
                snapshot=snapshot,
                outputs=[{"output_type": "stream", "text": said}],
            )
        )
        made.append(transaction)

    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/entries/{entry}/executions",
        headers={"X-User-Email": api.user},
    )
    assert [one["transaction"] for one in answer.json()["executions"]] == made[::-1]


async def test_an_execution_against_no_snapshot_is_refused(api: Api):
    """Output whose subject cannot be named is not evidence of anything."""
    entry, _ = await a_file(api)
    declined = refused(
        await api.submit(op="execute", id=entry, snapshot=new_id(), outputs=[])
    )
    assert "no snapshot of that name" in declined["reason"]


async def test_an_execution_of_a_file_outside_its_snapshot_is_refused(api: Api):
    entry, metadata = await a_file(api)
    snapshot = await a_snapshot(api, entry, metadata)
    elsewhere, _ = await a_file(api)
    declined = refused(
        await api.submit(op="execute", id=elsewhere, snapshot=snapshot, outputs=[])
    )
    assert "not in that snapshot" in declined["reason"]


async def test_both_are_answered_rather_than_recorded_twice(api: Api):
    """A client whose connection dropped re-sends what it sent."""
    entry, metadata = await a_file(api)
    snapshot = await a_snapshot(api, entry, metadata)
    acknowledged(
        await api.submit(
            op="snapshot",
            transaction=snapshot,
            id=entry,
            entries=[seen(entry, metadata)],
        )
    )
    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/snapshots/{snapshot}",
        headers={"X-User-Email": api.user},
    )
    assert len(answer.json()["entries"]) == 1

    ran = api.transaction()
    for _ in range(2):
        acknowledged(
            await api.submit(
                op="execute", transaction=ran, id=entry, snapshot=snapshot, outputs=[]
            )
        )
    answer = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/entries/{entry}/executions",
        headers={"X-User-Email": api.user},
    )
    assert len(answer.json()["executions"]) == 1


async def test_neither_appears_in_the_event_stream(api: Api):
    """Neither changes any entry, so a subscriber folding an entry's history
    must not see them -- and does not, by their being in tables of their own
    rather than filtered out of the ones it reads."""
    entry, metadata = await a_file(api)
    before = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/initialize",
        json={"outbox": []},
        headers={"X-User-Email": api.user},
    )
    was = [one for one in before.json()["entries"] if one["id"] == entry][0]

    snapshot = await a_snapshot(api, entry, metadata)
    acknowledged(
        await api.submit(op="execute", id=entry, snapshot=snapshot, outputs=[])
    )

    after = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/initialize",
        json={"outbox": []},
        headers={"X-User-Email": api.user},
    )
    now = [one for one in after.json()["entries"] if one["id"] == entry][0]
    """Not one token moved: neither of these is a version of anything."""
    assert now == was
