"""A snapshot taken on a client, rebuilt somewhere else.

This is the whole point of recording refusals, so it is tested the way it will
actually be used: a client works with no connection, evolving a filesystem in
its own head and writing down what it was looking at at several moments along
the way. Then it reconnects, everything it did is replayed at once, and some of
it is refused. Every snapshot must still describe exactly what that user had on
screen when it was taken -- including the ones naming work the server went on
to decline.

Nothing here reads a row directly. If it can only be proved by looking in the
database then a second machine cannot do it, and a second machine doing it is
the requirement.
"""

from typing import Any

from conftest import Api, acknowledged, new_id, open_workspace


class Offline:
    """A client with no connection: it queues, and it knows what it is showing.

    The tokens are predicted rather than fetched, which is the property the
    whole design rests on -- a transaction id is the token the change it makes
    will be recorded under, so a client can compose a session's work and know
    what it is looking at without asking anybody.
    """

    def __init__(self, api: Api) -> None:
        self.api = api
        self.outbox: list[dict[str, Any]] = []
        self.showing: dict[str, dict[str, Any]] = {}
        self.content: dict[str, str] = {}
        self.names: dict[str, str] = {}

    def create(self, name: str, text: str, parent: str | None = None) -> str:
        entry, transaction = new_id(), self.api.transaction()
        self.outbox.append(
            {
                "op": "create", "transaction": transaction, "id": entry,
                "type": "file", "name": name, "parent": parent,
                "content": {"type": "text", "content": text},
            }
        )
        self.showing[entry] = {
            "id": entry,
            "name_version": transaction,
            "parent_version": transaction,
            "deleted_version": transaction,
            "content_version": transaction,
        }
        self.content[entry] = text
        self.names[entry] = name
        return entry

    def write(self, entry: str, text: str) -> str:
        transaction = self.api.transaction()
        self.outbox.append(
            {
                "op": "write", "transaction": transaction, "id": entry,
                "content_version": self.showing[entry]["content_version"],
                "content": {"type": "text", "content": text},
            }
        )
        self.showing[entry]["content_version"] = transaction
        self.content[entry] = text
        return transaction

    def rename(self, entry: str, name: str) -> str:
        transaction = self.api.transaction()
        self.outbox.append(
            {
                "op": "rename", "transaction": transaction, "id": entry,
                "name_version": self.showing[entry]["name_version"], "name": name,
            }
        )
        self.showing[entry]["name_version"] = transaction
        self.names[entry] = name
        return transaction

    def snapshot(self) -> dict[str, Any]:
        """What is on screen right now: every entry, and what it is showing.

        Deep-copied, because the point of a snapshot is that later work does
        not change what it says.
        """
        return {
            "entries": [dict(shown) for shown in self.showing.values()],
            "names": dict(self.names),
            "content": dict(self.content),
        }

    async def reconnect(self) -> dict[str, Any]:
        return await self.api.initialize(outbox=self.outbox)


async def rebuilt(api: Api, snapshot: dict[str, Any]) -> dict[str, Any]:
    """The server's answer, keyed by entry -- what a second machine would get."""
    response = await api.http.post(
        f"/wsfs/workspaces/{api.workspace}/reconstruction",
        json={"entries": snapshot["entries"]},
        headers={"X-User-Email": api.user},
    )
    assert response.status_code == 200, response.text
    return {answer["id"]: answer for answer in response.json()["entries"]}


def matches(rebuilt_entries: dict[str, Any], snapshot: dict[str, Any]) -> None:
    for entry, shown in snapshot["names"].items():
        answer = rebuilt_entries[entry]
        assert answer["unresolved"] == [], f"{entry}: {answer['unresolved']}"
        assert answer["name"] == shown, f"{entry}: {answer['name']} != {shown}"
        assert answer["content"]["content"] == snapshot["content"][entry]


async def test_every_snapshot_of_an_offline_session_is_rebuilt_after_replay(api: Api):
    """The whole shape, end to end.

    Three snapshots taken as the work goes on, none of them describing the
    same filesystem, all of them handed over at once and rebuilt afterwards.
    """
    client = Offline(api)

    first = client.create("main.py", "print('one')")
    early = client.snapshot()

    client.write(first, "print('one')\nprint('two')")
    second = client.create("helper.py", "def help(): ...")
    middle = client.snapshot()

    client.rename(first, "app.py")
    client.write(second, "def help():\n    return 42")
    client.write(first, "print('one')\nprint('two')\nprint('three')")
    late = client.snapshot()

    await client.reconnect()

    for taken in (early, middle, late):
        matches(await rebuilt(api, taken), taken)


async def test_a_snapshot_naming_refused_work_still_describes_the_screen(
    api: Api, other: Api
):
    """The case the recording exists for.

    Somebody else writes the file while this client is away, so its whole
    chain of writes is refused on reconnect. The file the server ends up
    holding is not the one this user was looking at -- and the snapshot has to
    keep describing the one they were.
    """
    entry = new_id()
    born = api.transaction()
    acknowledged(
        await api.create(entry, name="shared.py", content={"type": "text", "content": "start"},
                         transaction=born)
    )

    client = Offline(api)
    client.showing[entry] = {
        "id": entry, "name_version": born, "parent_version": born,
        "deleted_version": born, "content_version": born,
    }
    client.content[entry] = "start"
    client.names[entry] = "shared.py"
    client.outbox.append(
        {
            "op": "write", "transaction": api.transaction(), "id": entry,
            "content_version": born,
            "content": {"type": "text", "content": "start\nmine"},
        }
    )
    client.showing[entry]["content_version"] = client.outbox[-1]["transaction"]
    client.content[entry] = "start\nmine"
    taken = client.snapshot()

    # While they were away.
    acknowledged(await other.write(entry, born, "start\ntheirs"))

    answers = await client.reconnect()
    assert answers["rejected"], "the write should have lost"

    rebuild = await rebuilt(api, taken)
    assert rebuild[entry]["unresolved"] == []
    assert rebuild[entry]["content"]["content"] == "start\nmine"
    # And the filesystem itself moved on without them.
    assert (await api.content(entry)).json()["content"] == "start\ntheirs"


async def test_a_snapshot_of_work_that_never_arrived_says_so(api: Api):
    """A hole has to look like a hole.

    A client can snapshot faster than it can send, so a token here may name
    work still sitting in an outbox -- or gone with the tab that held it. An
    entry with no name and an entry whose name never arrived are different
    things, and a caller rebuilding a tree has to be able to tell them apart.
    """
    entry = new_id()
    never_sent = api.transaction()

    rebuild = await rebuilt(
        api,
        {
            "entries": [
                {
                    "id": entry, "name_version": never_sent,
                    "parent_version": never_sent, "deleted_version": never_sent,
                    "content_version": never_sent,
                }
            ]
        },
    )

    answer = rebuild[entry]
    assert sorted(answer["unresolved"]) == [
        "content_version", "deleted_version", "name_version", "parent_version",
    ]
    assert answer["name"] is None
    assert answer["content"] is None


async def test_the_dependents_of_a_refused_create_are_rebuilt_too(api: Api):
    """Replay refuses a create, and everything queued behind it goes down with
    it -- `the create this depends on was refused`, without ever being judged.

    That is the path a queue comes home by, so it is the worst place to lose
    anything. Every keystroke behind the doomed create is still on screen in
    the snapshot, and still has to come back.
    """
    client = Offline(api)
    entry = client.create("orphan.py", "first")
    client.outbox[0]["parent"] = new_id()  # a folder nobody ever created
    client.write(entry, "first\nsecond")
    client.write(entry, "first\nsecond\nthird")
    taken = client.snapshot()

    answers = await client.reconnect()
    reasons = [rejection["reason"] for rejection in answers["rejected"]]
    assert reasons == [
        "no such parent",
        "the create this depends on was refused",
        "the create this depends on was refused",
    ]

    matches(await rebuilt(api, taken), taken)


async def test_a_reconstruction_cannot_reach_another_workspace(
    api: Api, instance, session
):
    """Tokens are ids, and an id from somewhere else must not resolve.

    The applied logs are scoped by joining the entry; a refusal carries its
    own workspace, because a refused create left no entry to join to. Both
    halves are checked here -- one accepted token and one refused.
    """
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(entry, name="private.py",
                         content={"type": "text", "content": "secret"}, transaction=born)
    )
    refused_write = api.transaction()
    await api.write(entry, new_id(), "also secret", transaction=refused_write)

    elsewhere = Api(instance, await open_workspace(instance), user="mallory@example.com")
    response = await elsewhere.http.post(
        f"/wsfs/workspaces/{elsewhere.workspace}/reconstruction",
        json={
            "entries": [
                {"id": entry, "name_version": born, "content_version": born},
                {"id": entry, "content_version": refused_write},
            ]
        },
        headers={"X-User-Email": elsewhere.user},
    )

    assert response.status_code == 200, response.text
    for answer in response.json()["entries"]:
        assert answer["name"] is None
        assert answer["content"] is None
        assert answer["unresolved"]
