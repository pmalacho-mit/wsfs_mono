# wsfs-core-suede

**Role:** the distributed filesystem `SPEC.md` describes — server authority,
client sync, and the collaboration plane that makes text files shared documents.
Nothing that renders, nothing that talks to a model, nothing that knows what
Python is.

**Baseline:** `wsfs_suede` @ `576b33e`. Read `PORTING.md` §0 before acting on any
inventory here.

---

## 1. Boundaries

**BOUNDARY — depends on:** `wsfs_suede__sqlmodel_utils_suede`, and on the client
side `yjs` / `y-protocols` / `y-indexeddb` and `uuid`. Nothing else.

**BOUNDARY — must not depend on:** any UI library (svelte, dockview, pierre,
shadcn, bits-ui, tailwind), any model library (`pytutor_llms`, `ai`), pyodide,
monaco, `@liveblocks/*` outside a single named adapter module, or any of the
satellite repos.

**BOUNDARY — does not know that satellites exist.** No conditional import, no
optional feature flag, no `if TYPE_CHECKING` reference to a chat table. If core
needs to be extended, it exports a seam; it does not import downward.

**BOUNDARY — one write path.** `service.adjudicate` plus the choke point is the
only way a positioned row reaches storage. Anything that needs to write a
workspace lives in core or goes through the ordinary door. This is why `clone`
and `place` are here (§5).

---

## 2. Inventory as of `576b33e`

Everything under `release/backend/` **except** `tutor.py`, `llm.py`, `study.py`,
and the tutor/study sections of `contract.py` and `models.py`.

Everything under `release/frontend/` **except** `svelte/` and `adapters/`.

### Backend, by role

Anchor phrases are for `grep -rn "<phrase>" release/` when a filename has moved.

| Role | File @ `576b33e` | Anchor phrase |
|---|---|---|
| Wire shapes, single source | `contract.py` | `the only place they are declared` |
| Tables of record | `models.py` | `NOTHING HERE IS A MODULE-LEVEL TABLE` |
| Judgement + choke point | `service.py` | `Adjudication, and the one path every applied mutation takes` |
| Current-state queries | `tree.py` | `What the tree currently denotes` |
| Events from the logs | `stream.py` | `The event stream, which is the logs themselves` |
| Per-workspace serialization | `controller.py` | `Per-workspace controller (the actor pattern)` |
| Text reconstruction | `text.py` | `reconstructed from its chain of deltas` |
| Delta algebra | `diff.py` | `Text history as Yjs-shaped deltas` |
| Client clock from the id | `minted.py` | `read out of the id it happened as` |
| Refusal store | `refusals.py` | `Every transaction that was declined, kept` |
| Version listing | `history.py` | *(check the module docstring)* |
| What a client was seeing | `reconstruct.py` | *(check the module docstring)* |
| Snapshots + executions | `records.py` | *(check the module docstring)* |
| Content token → write | `resolve.py` | `The write a content token names` |
| Room keeping | `keeper.py` | *(check the module docstring)* |
| Room/file gap rules | `rooms.py` | `What a shared room owes the file underneath it` |
| Collaboration seam | `collaboration/protocol.py` | `What this package needs of a collaboration service` |
| Blob seam + fs impl | `blobs/` | — |
| Workspace copy | `clone.py` | `A CLONE IS A COPY, not a share` |
| Declarative file placement | `place.py` | `Making a workspace hold these files` |
| Router + units of work | `main.py` | `The router a host mounts` |
| Schema migration | `migrate.py` | — |

### Frontend (client library), by role

| Role | File @ `576b33e` |
|---|---|
| Generated wire types | `schema.generated.d.ts`, `contract.ts` |
| Server-truth replica | `confirmed.ts` |
| The queue | `outbox.ts` |
| Derived optimistic view | `effective.ts` |
| What moved, and who moved it | `changes.ts` |
| One write per entry in flight | `writes.ts` |
| Reconnect / recovery | `loop.ts` |
| HTTP + SSE | `transport.ts` |
| The public object | `workspace.ts` |
| Paths over an id-addressed tree | `paths.ts` |
| Content cache by token | `content.ts` |
| Bytes by hash | `bytes.ts`, `indexed.ts`, `kept.ts`, `reclaim.ts` |
| Delta algebra (mirror of `diff.py`) | `delta.ts` |
| Ids | `identity.ts`, `minted.ts` |
| Room speaking rule | `rooms.ts` |
| Version history merge | `history.ts` |
| Per-key debounce | `debounce.ts` |
| Public surface | `index.ts` |

**INVENTORY caveat:** `release/frontend/svelte/room.svelte.ts` (~887 lines) is
filed under `svelte/` but is **not** UI. It holds the `Provider`/`Enter`/`Host`
contracts and the room-joining protocol. See §6 — most of it belongs in core.

---

## 3. What to move out before anything else

Three things currently sit in core's tree and must leave. All three are small.

1. **`tutor.py` (~700) + `llm.py` (~88)** → `wsfs-assistant-suede`.
2. **`study.py` (~162)** → `wsfs-pytutor-suede`.
3. **`contract.py` `# -- the tutor` and `# -- the study` sections** (~255 lines
   as of `576b33e`) and the matching `models.py` sections (~261 lines) → the same
   two places.

Find them: `grep -n "^# -- " release/backend/contract.py release/backend/models.py`.

Core's own `main.py` currently imports `tutor` and `study` and holds their
routes. As of `576b33e` that is roughly lines 1084–1307 of a 1423-line file —
**verify by role, not by number**: the tutor routes are the ones handling
`/chat`, `/chat/stream` and `/progress`; the study routes are the three under
`/study/`.

---

## 4. The `Database` protocol

You want core to accept any database that provides what the design needs, with
today's `Database` shipped as a compliant implementation. Here is what the code
actually asks for, read out of the call sites.

### What core uses today

```python
async with database.session() as session: ...   # everywhere
await session.exec(statement)                    # sqlmodel select
await session.get(Model, pk)
session.add(row) / session.add_all(rows)
await session.flush() / await session.commit()
await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
(await session.connection()).execute(delete(...).returning(...))
```

Plus, in `migrate.py` and setup, engine-level metadata creation.

### The honest shape

```python
class Session(Protocol):
    async def exec(self, statement, /): ...
    async def get(self, model, primary_key, /): ...
    def add(self, row, /) -> None: ...
    def add_all(self, rows, /) -> None: ...
    async def flush(self) -> None: ...
    async def commit(self) -> None: ...
    async def connection(self, *, execution_options: Mapping | None = None): ...

class Database(Protocol):
    def session(self) -> AsyncContextManager[Session]: ...
```

### Be honest about what this protocol does and does not buy

It buys **testability and ownership** — a host brings its own engine, pooling,
lifecycle and migrations, and core stops assuming it owns the connection. That
is worth having on its own.

It does **not** buy database portability, and the guide should not pretend
otherwise. Core depends on Postgres semantics in at least four places, and every
one is load-bearing:

| Dependency | Where | Why it cannot be relaxed |
|---|---|---|
| `REPEATABLE READ`, set as the first statement | stream replay | Spec §8.4. Read-committed splits a create across logs and silently loses entries. |
| `SELECT DISTINCT ON` | current-state queries | Newest-row-per-entry per property. Rewritable as a window function, at a cost. |
| `DELETE … RETURNING` in one statement | stream token claim | Spec §8.2. Single-use *by construction*. Two statements is a race. |
| `JSONB` | deltas, execution outputs | |

**Recommendation:** name the protocol `AsyncDatabase` and document it as *"the
session lifecycle is yours; the SQL dialect is still Postgres."* Put the four
dependencies above in the protocol's docstring so nobody discovers them by
writing a SQLite adapter and watching the stream tests fail in an interesting
way. If genuine dialect portability is ever wanted, that is a separate piece of
work with its own design note, and `DISTINCT ON` is where it starts.

---

## 5. Clone and place stay — and here is the seam they need

You decided these are core. Agreed, and the reason is worth writing down in the
repo, because the next person will reasonably ask why a "convenience" is in the
kernel:

> They go through the ordinary door. Every file a clone writes is an ordinary
> `Create`, adjudicated by `service.adjudicate` and stamped by the same choke
> point — so the target's stream announces a clone as a run of ordinary create
> events and every rule about names, nesting and CAS applies unchanged. A
> downstream package doing this would need `Submission`, `approve` and
> `Positions`, which is a second write path, which is the one thing the design
> refuses.

**Work item:** because they are core but *host-facing*, they are the main
consumers of the in-process API. Make sure `Mounted.clone` and `Mounted.place`
survive the `Mounted` slimming in `PORTING.md` §3.3 — the ten fields that leave
are the chat, `progress` and study ones, not these.

`place`'s `prune` deletes. Keep its docstring's warning prominent wherever it
ends up; it is the one core entry point that destroys without presenting a
token.

---

## 6. Rooms in core — the real work

Rooms are core, and the server side is in good shape. The client side is not,
and this is where most of core's port effort goes.

### 6.1 Server: add a second `ICollaboration`

See `PORTING.md` §4. The protocol is three methods. Ship:

- `collaboration/liveblocks.py` — exists, unchanged.
- `collaboration/local.py` (or similar) — the dev implementation. Either the
  open-sourced Liveblocks sync engine/dev server, or a y-websocket server, or an
  in-process `pycrdt` document store. `rooms.py` already imports `pycrdt`, so
  the in-process option needs no new dependency and is the fastest route to a
  green test suite with no API key.

**One behaviour to get right, and it is the subtle one:** `document()` must
return **empty bytes for a room nobody has written to**, not an error. The
protocol docstring calls this out and explains why — the ambiguity between "no
such room" and "a room holding nothing" is precisely what made seeding a race no
browser could settle. Any new implementation that raises here will pass casual
testing and break seeding.

**Conformance:** run `CONFORMANCE.md` §O against every implementation. O1
(an empty file's room is not re-seeded) is the one that catches this.

### 6.2 Client: extract the room protocol out of `svelte/`

**INVENTORY (`576b33e`):** `release/frontend/svelte/room.svelte.ts` (~887 lines)
and `release/frontend/svelte/collaborator.ts` (~121 lines).

`room.svelte.ts` contains, mixed together:

- the **`Provider` contract** — `synced`, `watch`, `ahead`, `handedOver`,
  `destroy`. Vendor-neutral by construction. **Core.**
- the **`Enter` and `Host` contracts** and the room-joining protocol. **Core.**
- the **`Persist` seam** (y-indexeddb-shaped, "the rung below the room"). **Core.**
- Svelte reactivity (`.svelte.ts` — runes). **Svelte, or removable.**

`collaborator.ts` imports `@liveblocks/client` and `@liveblocks/yjs` directly.
`release/frontend/index.ts` re-exports `createClient` from `@liveblocks/client`.

**Work:**

1. Move the contracts and the protocol into core's client, framework-free
   (`frontend/room.ts`). If the runes are load-bearing for the widget, leave a
   thin reactive wrapper behind in `wsfs-svelte-suede`.
2. Ship a **default `Enter` implementation** in core against a vendor-neutral
   provider — y-websocket is the obvious pairing with a y-websocket server on
   the backend, and it is the one that proves the boundary.
3. Ship the Liveblocks `Enter` as a named adapter module, not as a default.
4. **Delete the `createClient` re-export from `index.ts`.** It is one line, and
   it is the line most likely to keep the vendor welded in — a consumer that
   imports `createClient` from `wsfs-core-suede` has taken a dependency nobody
   declared.

**Verify:** `grep -rn "@liveblocks" frontend/` returns hits in exactly one file.

### 6.3 Client: `speaking` is already right

`release/frontend/rooms.ts` reduced to a single exported rule
(`speaking({attached, behind})`). Its docstring records everything that used to
be there and why it is not. Leave it alone; it is the shape the rest of the room
code should be aiming at.

---

## 7. What core exports, and to whom

Two audiences, two exports — this is `PORTING.md` §3.3 restated in concrete
terms.

### To a satellite package (assistant, pytutor)

```python
from wsfs_core import Backend, Authorize, build_models, Models
```

The satellite builds its own tables against `Models`, its own router against
`Backend` + `Authorize`, and mounts both. It never sees `Mounted`.

**Also export, because satellites genuinely need them:**

| Symbol | Needed by | For |
|---|---|---|
| `reconstruct.reconstructed` | assistant | what the user was seeing at a snapshot |
| `records.entries_in`, `records.executions_of` | assistant | snapshot contents, run output |
| `Text` / `text.at` | assistant | file contents at a version |
| `minted.minted_at` | both | the client clock from an id |
| `Occurrence`, `Versions`, `Executed`, `Id` types | both | shared wire vocabulary |

**BOUNDARY:** these are **public API** the moment a satellite imports them. They
get docstrings that say so, and they appear in `SPEC.md` §16.3 as part of what a
port must supply. Do not let a satellite reach past them into `service` or
`tree` internals.

### To an application (the host)

```python
mounted = create_router(backend=backend, authorize=authorize, prefix="/wsfs")
app.include_router(mounted.router)
mounted.place(workspace=..., files={...}, user=...)   # no HTTP round trip
```

`Mounted` keeps: `router`, `clone`, `place`, `initialize`, `transact`, `store`,
`fetch_blob`, `content`, `history`, `executions`, `snapshot`, `drafts`,
`clear_drafts`, `reconstruction`, `stream`, and the four room functions.
It loses: `ask`, `hear`, `conversation`, `detected`, `accepted`, `activity`.

### To a client consumer

`release/frontend/index.ts` is already an explicit, well-commented public
surface. Two changes:

- remove the `createClient` re-export (§6.2);
- add the room contracts pulled up from `svelte/`.

Everything else stays as it is. The `provider` / `filesystem` adapter exports
(`./adapters/files`, `./adapters/kernel`) leave with their packages — see the
svelte and python guides.

---

## 8. How to know it worked

1. **Import audit clean** (`PORTING.md` §5), Python and TypeScript.
2. **`pytest` green with no `LIVEBLOCKS_SECRET` and no network**, against the
   local `ICollaboration`. This is the headline check; it means core is
   genuinely standalone.
3. **`CONFORMANCE.md` sections A–N green**, plus §O against both collaboration
   implementations. Sections beyond that belong to satellites and should be
   *absent* from core's suite, not skipped.
4. **`grep -rn "@liveblocks" frontend/`** → one file.
5. **The torture suite (N1–N5) still passes.** It found the stranding gap that
   produced the submission pump; it is the strongest evidence you have that a
   refactor of this size did not quietly change behaviour. If any seed that
   passed at `576b33e` fails after the split, stop and find out why before
   moving on. Pin the seeds.
6. **`SPEC.md` §15 invariants** hold. S1–S16 and C1–C11 are all core's. X1–X4
   are cross-cutting and are the ones a split most easily breaks — X2 ("which
   logs does this operation write is one function") and X3 ("one definition of a
   valid name") must be exported from core, not reimplemented anywhere.
