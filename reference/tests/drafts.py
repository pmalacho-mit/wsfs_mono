"""A write the client asks not to become the file's content.

The client that made it could not reach the others, so nobody else has the
text. Storing it AS the file would either lose it -- the next store from
somebody else would not contain it -- or have the server carry it into their
documents, where this client's own copy would arrive and say it twice.

So it is kept instead: durable, addressable, recoverable, and asserting
nothing about what anybody is looking at.
"""

from typing import Any

import httpx
from sqlmodel import Session, col, select

from conftest import Api, acknowledged, new_id, refused
from wsfs_suede.samples.backend.app import MODELS

from wsfs_suede.release.backend.contract import Refusal


def kept(response: httpx.Response) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rejected"] is False
    assert body["draft"] is True
    return body


async def a_file(api: Api, content: str = "before\n") -> tuple[str, str]:
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry, name=f"{entry}.py", transaction=born,
            content={"type": "text", "content": content},
        )
    )
    return entry, born


def reasons_for(session: Session, transaction: str) -> list[str]:
    rows = session.exec(
        select(MODELS.refused_text).where(col(MODELS.refused_text.transaction) == transaction)
    ).all()
    return [row.reason for row in rows]


async def test_a_draft_does_not_become_the_files_content(api: Api):
    entry, born = await a_file(api)
    kept(await api.write(entry, born, "before\nkept back\n", draft=True))

    assert (await api.content(entry)).json()["content"] == "before\n"


async def test_a_draft_is_readable_at_its_own_transaction(api: Api):
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nkept back\n", transaction=holding, draft=True))

    assert (await api.content(entry, holding)).json()["content"] == "before\nkept back\n"


async def test_a_draft_leaves_the_version_where_it_was(api: Api):
    entry, born = await a_file(api)
    kept(await api.write(entry, born, "before\nkept back\n", draft=True))

    held = next(
        one for one in (await api.initialize())["entries"] if one["id"] == entry
    )
    assert held["content_version"] == born


async def test_the_token_a_draft_presented_is_still_the_one_to_present(api: Api):
    """The draft took nothing from the file, so nothing rebased under it."""
    entry, born = await a_file(api)
    kept(await api.write(entry, born, "before\nkept back\n", draft=True))

    acknowledged(await api.write(entry, born, "before\nshared\n"))
    assert (await api.content(entry)).json()["content"] == "before\nshared\n"


async def test_a_draft_is_not_a_refusal_even_though_it_is_kept_beside_them(
    api: Api, session: Session
):
    """Same table, different reason, and the difference is not cosmetic: one
    says the system declined, the other says this client asked."""
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nkept back\n", transaction=holding, draft=True))

    assert reasons_for(session, holding) == [Refusal.NOT_SHARED]


async def test_a_refusal_is_still_a_refusal(api: Api, session: Session):
    entry, born = await a_file(api)
    acknowledged(await api.write(entry, born, "before\nlanded\n"))

    lost = api.transaction()
    refused(await api.write(entry, born, "before\nlost\n", transaction=lost))
    assert reasons_for(session, lost) == [Refusal.ALREADY_WRITTEN]


async def test_two_drafts_from_one_client_are_both_kept(api: Api):
    entry, born = await a_file(api)
    once, twice = api.transaction(), api.transaction()
    kept(await api.write(entry, born, "before\nonce\n", transaction=once, draft=True))
    kept(
        await api.write(
            entry, born, "before\nonce\ntwice\n",
            transaction=twice, predecessor=once, draft=True,
        )
    )

    assert (await api.content(entry, once)).json()["content"] == "before\nonce\n"
    assert (await api.content(entry, twice)).json()["content"] == "before\nonce\ntwice\n"


async def test_a_draft_never_reaches_a_watching_client(api: Api):
    """Nothing about a draft is in the stream, so nobody is told about a
    version the file does not have."""
    entry, born = await a_file(api)
    before = await api.initialize()
    kept(await api.write(entry, born, "before\nkept back\n", draft=True))

    assert (await api.initialize())["entries"] == before["entries"]


async def test_a_draft_from_one_client_is_invisible_to_another(api: Api, other: Api):
    entry, born = await a_file(api)
    kept(await api.write(entry, born, "before\nkept back\n", draft=True))

    assert (await other.content(entry)).json()["content"] == "before\n"


async def rebuilt(api: Api, entries: list[dict[str, Any]]) -> dict[str, Any]:
    response = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/reconstruction",
        json={"entries": entries},
        headers={"X-User-Email": api.user},
    )
    assert response.status_code == 200, response.text
    return {answer["id"]: answer for answer in response.json()["entries"]}


async def test_a_snapshot_naming_a_draft_is_rebuilt_from_the_server(api: Api):
    """The reason drafts exist.

    A user typing while their room is unreachable, who then asks a question
    about what is on their screen: the snapshot names work nobody else has,
    and the server must still be able to hand it back.
    """
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nonly mine\n", transaction=holding, draft=True))

    answers = await rebuilt(
        api,
        [
            {
                "id": entry,
                "name_version": born,
                "parent_version": born,
                "deleted_version": born,
                "content_version": holding,
            }
        ],
    )

    assert answers[entry]["unresolved"] == []
    assert answers[entry]["content"]["content"] == "before\nonly mine\n"


def cleared_flags(session: Session, transaction: str) -> list[bool]:
    rows = session.exec(
        select(MODELS.refused_text).where(col(MODELS.refused_text.transaction) == transaction)
    ).all()
    return [row.cleared for row in rows]


async def clear(api: Api, transactions: list[str]) -> httpx.Response:
    return await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/drafts/cleared",
        json={"transactions": transactions},
        headers={"X-User-Email": api.user},
    )


async def stranded(api: Api) -> list[dict[str, Any]]:
    response = await api.http.get(
        f"/wsfs/workspaces/{api.workspace}/drafts",
        headers={"X-User-Email": api.user},
    )
    assert response.status_code == 200, response.text
    return response.json()["drafts"]


async def test_a_draft_starts_out_uncleared(api: Api, session: Session):
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nmine\n", transaction=holding, draft=True))

    assert cleared_flags(session, holding) == [False]


async def test_a_draft_is_cleared_when_the_work_has_gone_out(api: Api, session: Session):
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nmine\n", transaction=holding, draft=True))

    assert (await clear(api, [holding])).status_code == 204
    assert cleared_flags(session, holding) == [True]


async def test_clearing_a_draft_does_not_take_it_away(api: Api):
    """It is still the record of what that client had, and a snapshot may
    still name it."""
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nmine\n", transaction=holding, draft=True))
    await clear(api, [holding])

    assert (await api.content(entry, holding)).json()["content"] == "before\nmine\n"


async def test_an_uncleared_draft_is_reported_as_still_only_here(api: Api):
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nmine\n", transaction=holding, draft=True))

    waiting = await stranded(api)
    assert [one["transaction"] for one in waiting] == [holding]
    assert waiting[0]["entry"] == entry


async def test_a_cleared_draft_is_not_reported(api: Api):
    entry, born = await a_file(api)
    holding = api.transaction()
    kept(await api.write(entry, born, "before\nmine\n", transaction=holding, draft=True))
    await clear(api, [holding])

    assert await stranded(api) == []


async def test_a_refusal_is_never_reported_as_a_stranded_draft(api: Api):
    """A refusal is the system declining, not a user's work waiting to get
    out. Same table, and they must never be shown as the same thing."""
    entry, born = await a_file(api)
    acknowledged(await api.write(entry, born, "before\nlanded\n"))
    refused(await api.write(entry, born, "before\nlost\n"))

    assert await stranded(api) == []
