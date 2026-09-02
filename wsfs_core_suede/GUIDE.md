# A tour of `wsfs_core_suede`

The distributed filesystem: the server that decides, and the client that keeps
a copy. Nothing here renders, talks to a model, or knows what Python is.

Read it in the order below and each file will have been explained by the one
before it.

---

## 1. The idea, in one page

**Nothing is ever overwritten.** A workspace is a set of entries, and an entry
is pure identity — a UUID and a type. What it is *called*, where it *lives*,
whether it is *deleted* and what it *holds* are four separate append-only logs.
What a file currently says is the newest row in the content log for it.

That buys three things at once:

- **History costs nothing extra.** It is the log, read backwards.
- **The log cannot drift from the truth**, because there is no second copy of
  the truth to drift from.
- **The logs ARE the event stream.** One applied transaction takes exactly one
  *position* in the workspace's order, and which log its rows are in is which
  event it was. There is nothing else to write.

**The client mints every id.** Before it sends anything, a client chooses the
transaction's UUID — and after the server applies it, that same id is the token
the next change to that property must present. So a client knows, at mint time
and with no round trip, what token its own work will produce. That is what lets
it queue a whole session's work offline and send it later in one go.

**A retry is free.** The id is the dedup key: presenting a transaction that was
already applied returns the recorded answer instead of applying it twice.

## 2. The backend, in the order it runs

```
contract.py   the wire shapes, and the only place they are declared
models.py     the tables, built against the host's users and workspaces
     ↓
main.py       the router: one route per thing a client can ask
     ↓
controller.py one writer per workspace, serialized
     ↓
service.py    refusal() decides; approve() is the only thing that writes
     ↓
stream.py     the same rows, read back out as events
```

**Start with `service.py`.** It is the whole design in one file, and its
docstring says the thing worth carrying everywhere else: `refusal()` is
*judgement* and is pure — it reads the workspace and answers why a request
cannot be applied, or `None`. `approve()` is the *choke point* and is the only
thing that appends. Nothing about a refusal is stored, because nothing about a
refusal happened.

Then `models.py`, whose first line is the rule the whole schema turns on:
**nothing here is a module-level table.** A foreign key names its target table
in the field itself, so a table pointing at somebody else's users cannot exist
until somebody says which table that is. `build_models(user_table=…,
workspace_table=…)` creates the classes; the host owns identity and hands over
two names. That is also what lets two wsfs schemas coexist in one process.

Then `main.py`, which is long but shallow: `Backend.over(...)` binds a schema to
a database, a blob store and a collaboration service, and `create_router(...)`
returns a `Mounted` — the router, plus the work behind every route so that a
host which is *also* a consumer can call the function instead of HTTP'ing
itself.

Two members of `Mounted` are not routes at all, and the reasons are worth
reading in place: `clone` (its permission question spans two workspaces, and
`authorize` answers about one) and `place` (its destructive half is a thing a
host may mean and a browser may not).

### The supporting cast

| File | What it answers |
|---|---|
| `tree.py` | what the tree currently denotes — the newest row per property |
| `text.py` | what a file said at a version, folded from its delta chain |
| `diff.py` | the delta algebra; `delta.ts` on the client mirrors it |
| `refusals.py` | every declined transaction, kept so a client can be told why |
| `reconstruct.py` | what a client was seeing, given the tokens it names |
| `records.py` | snapshots and executions — in the outbox, outside the delta chain |
| `resolve.py` | the write a content token names |
| `history.py` | the versions of one file, newest first |
| `minted.py` | the client's clock, read out of the id it happened as |
| `clone.py` | a copy of a workspace, written as ordinary creates |
| `place.py` | "make this workspace hold these files", declaratively |
| `migrate.py` | widening the schema in place |

## 3. Rooms

A text file **is** a shared document. `keeper.py` is the part with the lock, and
`rooms.py` is the rules it applies. The one rule to hold on to:

> **Only the server carries text into a room.**

A client that read the file and typed the difference in would create *new*
characters, so when the original author's edits arrived carrying their own
identities, both copies would survive and the file would say everything twice.

`collaboration/protocol.py` is the seam — three methods — and there are two
implementations, neither privileged:

- `InProcessCollaboration`, rooms held in this process over `pycrdt`. The
  default, and what the whole suite runs against: no key, no network.
- `Liveblocks`, the hosted service over plain HTTP.

**One subtlety worth knowing before writing a third.** `document()` must answer
*empty bytes* for a room nobody has written to, rather than raising — the
keeper's job is telling "no such room" from "a room holding nothing", and it
cannot if the service will not answer the second. And an *empty CRDT document
is not empty bytes*: a fresh `pycrdt.Doc` encodes as two bytes, and returning
that verbatim makes an untouched room look written-to. See `NOTHING_WRITTEN` in
`inprocess.py`.

## 4. The client

```
transport.ts    HTTP and SSE. Nothing here decides anything.
     ↓
confirmed.ts    what the server has said            ─┐
outbox.ts       what this client has queued          ├─▶ effective.ts (what to draw)
     ↓                                               │
loop.ts         reconnect, replay, recover          ─┘
     ↓
workspace.ts    the object a consumer actually holds
```

**Start with `effective.ts`.** Two layers — server truth and the local queue —
and the derived view over them is what a UI draws. Everything else on the
client exists to keep one of those two layers honest.

Then `outbox.ts`: the queue, and the chaining rule. Each queued item presents
the id of the item before it, which is why a session's work can be composed
offline and sent in order.

Then `workspace.ts`, which is the public object: `connect(...)` returns it, and
every method on it is either a read of the effective view or an append to the
queue.

Worth knowing about, in roughly descending order of how often they surprise
people:

- `indexed.ts` / `outbox-store.ts` / `reclaim.ts` — the queue survives a page load, so
  it lives in IndexedDB; `reclaim` is what happens when the browser runs out of
  room for work that has not been sent.
- `warming.ts` — content pulled into the cache before anybody asks. Purely an
  optimisation, which is why every request it makes has to justify itself: a
  burst of writes to one file collapses to a single fetch of the version it
  ended on, and the whole thing is bounded so opening a workspace does not
  look like an attack.
- `stash.ts` — the last thing typed, written down somewhere that *cannot fail*,
  for the moment the page is torn down mid-write.
- `room.ts` — the room contracts, framework-free. `Provider`, `Enter`, `Host`,
  `Persist`. No vendor is named; `collaboration/liveblocks.ts` is the only file
  in the package that imports one, and `index.ts` deliberately re-exports no
  vendor's client.
- `requests.ts` — one base URL and one auth story, shared with the satellite
  packages that mount routes over the same prefix. Retries live here for that
  reason: a request is resent only when its call site says it may be —
  `GET`/`HEAD`/`PUT` by default, a `POST` only when it opts in, because asking
  the tutor twice starts answering twice.
- `override.ts` — `FileOverride`, the door every write to a file goes through.
  The *type* is here and every implementation is elsewhere: read priority is
  core's concern, but only a consumer knows it is holding a buffer somebody is
  typing into.

## 5. Things that will bite you

**`schema.generated.d.ts` is generated.** Edit `backend/contract.py`, then run
`python wsfs_core_suede/frontend/generate.py`, then commit both outputs. If the
diff shows a satellite's shape — `Asking`, `Judging`, `Detected` — something
downstream got imported into core's router, and that is the boundary failing.

**Postgres, specifically.** Four behaviours are load-bearing and no other
database has all of them: `REPEATABLE READ` set as the first statement (stream
replay), `SELECT DISTINCT ON` (newest row per entry per property), `DELETE …
RETURNING` in one statement (single-use stream tokens by construction), and
`JSONB`.

**One process per workspace.** `refuse_to_split_the_brain()` in `main.py` will
stop you starting several, and the comment there explains why session affinity
is not a fix.

## 6. What the browser suite adds

Core's own suites answer every question that does not need a person. Two do:
whether two clients editing one file converge, and whether an editor bound to a
room shows the file rather than making an empty one. Those live in
`samples/frontend` and need `LIVEBLOCKS_SECRET_KEY` — see
[docs/GUIDE.md](../docs/GUIDE.md).

`tests/core/room_routes.py` covers everything *below* that line: the routes a
browser calls, driven against `InProcessCollaboration`, with no key and no
network. If you are changing the keeper or the seeding rules, that file is the
one to extend first — it is fast, and it fails for one reason at a time.

## 7. Your first change

A good first task is adding a field to something already on the wire.

1. Add it in `backend/contract.py`.
2. `python wsfs_core_suede/frontend/generate.py`.
3. Use it in `frontend/contract.ts` if it needs a short name.
4. `./tests/run.sh -k <the area>` and `npx vitest run`.

A harder and more instructive one: add a third `ICollaboration`. It is three
methods, `tests/core/collaboration.py` is already parameterised over every
implementation, and the empty-document trap above is the one that will catch
you.
