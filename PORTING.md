# wsfs — Splitting the monorepo into suede libraries

**Baseline:** `pmalacho-mit/wsfs_suede` @ `576b33e`, `release/` tree.
**Companions:** `SPEC.md` (what the system must do), `CONFORMANCE.md` (how to
prove it still does), and one guide per target repo.

---

## 0. Read this section first — the guides will go stale, and that is fine

You are going to keep developing while this port runs. Every file inventory in
these guides is a **snapshot of `576b33e`**, and some of it is wrong by the time
you read it. The guides are written so that being wrong about inventory does not
make them wrong about the split.

Three kinds of statement appear, and they age differently:

| Marker | Meaning | Ages? |
|---|---|---|
| **BOUNDARY** | A rule about what may depend on what | No. If a boundary changes, that is a decision, not drift. |
| **ROLE** | What a piece of code is responsible for | Rarely. Roles outlive filenames. |
| **INVENTORY** | Specific files, line counts, symbol names | **Yes.** Verify before acting. |

**When an INVENTORY item does not match what you find:**

1. Find the code by **role**, not by name. Every module in `release/` opens with
   a docstring that states its job in one sentence. Those sentences are far more
   stable than the filenames. Each guide gives you an *anchor phrase* — a
   distinctive string from that docstring — so `grep -rn "<phrase>" release/`
   finds the code wherever it went.
2. Ask whether the new code changed a **BOUNDARY**. If a new file in
   `release/backend/` imports something the guide says core must not import,
   that is a boundary decision someone made under deadline pressure. Decide it
   deliberately now.
3. Re-run the **import audit** (§5). It is mechanical, it does not care what
   files are called, and it is the thing that actually tells you whether the
   split holds.

**Do not treat these guides as a checklist to tick off.** Treat them as: here is
the boundary, here is how to prove you are on the right side of it, here is what
was on each side as of `576b33e`.

### Keeping the guides honest as you go

While the vendored `wsfs_suede` sits inside `wsfs-core-suede` (your plan — §6),
you can diff the world:

```bash
# What has moved since the baseline these guides describe?
git -C vendor/wsfs_suede log --oneline 576b33e..HEAD -- release/
git -C vendor/wsfs_suede diff  --stat  576b33e..HEAD -- release/backend release/frontend
```

Anything in that diff touching a file these guides claim for a *different*
package is the thing to look at first. Everything else is ordinary churn.

---

## 1. The package map

```
                    wsfs_suede__sqlmodel_utils_suede
                                 │
                                 ▼
                        wsfs-core-suede
                   backend/ + frontend/ (client)
                    filesystem · sync · rooms
                                 │
                                 │
                       wsfs-svelte-suede
                        frontend/ only
                       generic file UI
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
     wsfs-python-suede                    wsfs-assistant-suede
       frontend/ only                     backend/ + frontend/
      kernel + monaco                  └── wsfs_suede__pytutor_llms_suede
              │                                     │
              └──────────────────┬──────────────────┘
                                 ▼
                       wsfs-pytutor-suede
                       backend/ + frontend/
                  stuck detection · progress · study
```

`wsfs-pytutor-suede` sits at the bottom because it needs both: Monaco's edit
attribution from `wsfs-python-suede`, and the `ITutor` seam plus the chat panel
from `wsfs-assistant-suede`.

| Repo | backend/ | frontend/ | Depends on |
|---|---|---|---|
| **wsfs-core-suede** | ✔ | ✔ (client lib) | `sqlmodel_utils` only |
| **wsfs-svelte-suede** | — | ✔ (Svelte UI) | core, dockview-svelte, pierre-trees-svelte, with-events |
| **wsfs-python-suede** | maybe | ✔ | core, svelte, python-web-kernel, python-monaco |
| **wsfs-assistant-suede** | ✔ | ✔ | core, svelte, `pytutor_llms` |
| **wsfs-pytutor-suede** | ✔ | ✔ | assistant, python (→ svelte → core) |

**A note on the two pytutor names.** `wsfs_suede__pytutor_llms_suede` is a generic provider wrapper — it is what `wsfs-assistant-suede` imports to talk to a model, and it has nothing to do with tutoring. `wsfs-pytutor-suede` is the research feature. They will be confused for each other; say so in both READMEs.

**BOUNDARY — the one rule that makes all of this work:**
dependencies point **down** this list and never up. Core does not know that an
assistant exists. Svelte does not know that Python exists. If you find yourself
wanting an upward import, you have found a missing seam in core, not a reason to
break the rule.

---

## 2. What lives in core, and why the line is where it is

Core is **the distributed filesystem the spec promises, and nothing else**. The
test for membership is: *could `SPEC.md` §2–§14 be satisfied without this?* If
yes, it is not core.

**In core, and possibly surprising:**

- **Rooms and the collaboration plane.** Your call, and I agree with it. §14 of
  the spec is written as an optional plane, but the *reason* it is optional is
  that core must not require a vendor — not that Yjs document sync is a
  bolt-on. Text files in a wsfs workspace are collaborative documents; the
  seeding rule, the `base` bookkeeping and rule one ("only the host carries text
  into a room") are load-bearing filesystem behaviour, not UI. What core must
  not do is *require Liveblocks* — see §4.
- **Clone and place.** Your call, and I agree. Both go through
  `service.adjudicate` and the same choke point deliberately, which means they
  need core internals (`Submission`, `approve`, `Positions`). A downstream
  package holding those would be a second write path, which is the one thing the
  design refuses. They are core.
- **Snapshots and executions.** They are members of the closed `Submitted`
  union and travel through the outbox. Pulling them out is a wire-protocol
  change, not a packaging change. They stay.

**Not in core:**

- Anything that talks to a model.
- Anything that renders.
- Anything that knows what Python is.
- The study/telemetry instrument.

---

## 3. The three chokepoints, and the order they must be fixed in

These are shared aggregates that everything hangs off. Until they are opened up,
nothing can leave core. Do them in this order; each unblocks the next.

### 3.1 `Models` — one dataclass holding every table

**INVENTORY (`576b33e`):** `release/backend/models.py`, ~26 fields on the
`Models` dataclass, built by `build_models(user_table, workspace_table, prefix)`.

The pattern is already right — nothing is a module-level table, everything is
constructed against host-supplied names — it just needs to be **applied twice**.

**Target shape:**

```python
# core
def build_models(*, user_table, workspace_table, prefix="wsfs") -> Models: ...

# assistant, in its own package
def build_chat_models(*, core: Models, user_table, workspace_table,
                      prefix="wsfs_chat") -> ChatModels: ...

# pytutor
def build_study_models(*, core: Models, user_table, workspace_table,
                       prefix="wsfs_study") -> StudyModels: ...
```

A satellite's builder takes `core` because its foreign keys point at core's
entries and its queries scope by workspace. Core's builder must **not** know the
satellites exist.

The `_BUILT` prefix-collision guard already handles two schemas in one process;
extend it rather than replacing it.

**Verify:** `grep -n "type\[" release/backend/models.py` inside the `Models`
dataclass. Every field naming a chat, stuck, offer, cooldown, window or activity
row is a satellite table. As of `576b33e` there are eight.

### 3.2 `contract.py` — one file, three features

**INVENTORY (`576b33e`):** 952 lines. Sections are marked with `# -- ` banners:
requests, responses, entries and events, initialize (through ~line 697) are
core; `# -- the tutor` and `# -- the study` are not. (Confusingly, the `# -- the tutor` section is **assistant** shapes; the tutoring feature's shapes are under `# -- the study`, plus `Judging`/`Judged`.)

**Verify:** `grep -n "^# -- " release/backend/contract.py`.

Splitting the Python is easy. The knock-on is the generated client:
`release/frontend/generate.py` produces one `openapi.generated.json` → one
`schema.generated.d.ts`, and `release/frontend/contract.ts` re-exports from it
under short names.

**Decision to make before you start (it shapes every package):** does each repo
generate its own schema from its own FastAPI app, or does the *application*
generate one merged schema? I recommend **per-package generation**:

- each repo ships `frontend/generate.py` and its own `schema.generated.d.ts`;
- each repo's `contract.ts` re-exports only its own shapes;
- satellites import core's `contract.ts` for shared types (`Id`, `Version`,
  `Occurrence`, `Metadata`).

This keeps invariant **X1** (declared once, generated from, never hand-copied)
true per package. The cost is a small mounting harness in each repo that stands
up a FastAPI app holding only that package's router.

### 3.3 `Backend` and `Mounted` — core cannot currently be built alone

**INVENTORY (`576b33e`):** `release/backend/main.py`. `Backend.over(...)`
requires `liveblocks=` and `tutor=`. `Mounted` is a frozen dataclass with 22
fields, ten of which are satellite routes (`ask`, `hear`, `conversation`,
`detected`, `accepted`, `activity`, and the four room routes).

Rooms stay in core, so the four room fields stay. The chat fields go to the assistant; `progress` and the study fields go to pytutor.

**Target shape:**

```python
# core — no model library, no satellite adapters
backend = Backend.over(models, database, blobs,
                       heartbeat_seconds=..., grace_seconds=...,
                       max_blob_bytes=..., collaboration=...)
core = create_router(backend=backend, authorize=authorize, prefix="/wsfs")
app.include_router(core.router)

# assistant — mounts itself OVER core
chat = create_assistant_router(backend=backend, models=chat_models,
                               authorize=authorize, tutor=Tutor(...),
                               prefix="/wsfs")
app.include_router(chat.router)
```

**The correction from last time, restated because it drives every guide:** a
satellite does **not** consume `Mounted`. It consumes `Backend` + `Authorize` +
its own tables, and returns its own mounted-alike. `Mounted` is for
*application-level* consumers who want to call the work behind a route without
HTTP'ing themselves — a job that drops a file in, an assistant tool that calls
`place`. Both exports are real; they serve different callers.

**Also decide here:** the `Database` protocol you want. Core currently takes
`wsfs_suede__sqlmodel_utils_suede.postgres.db.Database` concretely. See the core
guide §4 for the shape.

---

## 4. Collaboration: keeping the vendor out of core

Core owns rooms. Core must not own Liveblocks.

The seam is already right. `release/backend/collaboration/protocol.py` defines
`ICollaboration` with exactly three methods (`create`, `document`, `send`), and
its docstring already says a y-websocket server would satisfy them. The Liveblocks
class beside it is one of possibly several implementations.

**BOUNDARY:** core ships the protocol plus **at least two** implementations, and
neither is privileged:

1. `Liveblocks` — the hosted service, over plain HTTP. Already written.
2. **A local/dev implementation** — either the open-sourced Liveblocks sync
   engine and dev server, or a plain y-websocket server, or an in-process Yjs
   document. This is what the test suite runs against by default, so that
   `pytest` needs no API key and no network.

Adding the second one is the single highest-value piece of work in the whole
port, and it is worth doing **before** anything moves. Reasons:

- It converts every room test from "integration test against a paid service"
  into an ordinary test, which is what makes the rest of the port safe to do
  quickly.
- It proves the boundary is not Liveblocks-shaped. Right now that is a claim in
  a docstring; a second implementation makes it a fact.
- Your y-websocket idea is the stronger of the two options for proving the
  boundary, because it shares no code and no API shape with Liveblocks. The
  Liveblocks dev server is the better one for fidelity. Doing both is cheap —
  the protocol is three methods.

The **client** side has the same shape, and it is currently less clean.
`release/frontend/svelte/room.svelte.ts` defines a `Provider` type (`synced`,
`watch`, `ahead`, `handedOver`, `destroy`) that is genuinely vendor-neutral —
but `release/frontend/svelte/collaborator.ts` imports `@liveblocks/client` and
`@liveblocks/yjs` directly, and `release/frontend/index.ts` re-exports
`createClient` from `@liveblocks/client`.

**BOUNDARY:** core's client exports the `Provider` and `Enter` contracts and a
default implementation; it does **not** re-export a vendor's client from
`index.ts`. That re-export is the one line most likely to keep the vendor
welded in.

---

## 5. The import audit — the thing that does not go stale

Write this early, run it in CI in every repo. It is the mechanical statement of
every BOUNDARY in these guides, and unlike the inventories, it stays true.

**Python** — assert that core imports nothing satellite:

```bash
# from wsfs-core-suede, must return nothing
grep -rn "pytutor_llms\|liveblocks\|monaco\|pyodide" backend/ \
  | grep -v "backend/collaboration/"
```

**TypeScript** — assert the dependency direction. `ts-morph` is already a
devDependency, and `typescript2mermaid-suede` is already in the repo; either can
walk the import graph and fail the build on an upward edge.

**The rule set, per repo:**

| Repo | May import | Must not import |
|---|---|---|
| core | `sqlmodel_utils`, yjs, y-protocols | any UI lib, any model lib, pyodide, monaco, dockview, svelte |
| svelte | core, dockview-svelte, pierre-trees, with-events, svelte | pyodide, monaco, any model lib |
| python | core, svelte, python-web-kernel, python-monaco | any model lib |
| assistant | core, svelte, `pytutor_llms` | pyodide, monaco |
| pytutor | assistant, python, svelte, core | any model library **directly** — it takes an `ITutor` |

**One nuance for core:** yjs on the *client* is fine — core carries text into
documents and that is filesystem behaviour. `@liveblocks/*` is not fine.

---

## 6. Sequencing, against your plan

Your plan (invent `wsfs-core-suede`, subrepo-clone the whole of `wsfs_suede`
into it, extract in place, then peel off satellite repos one at a time) is the
right shape. It keeps one working tree while the boundaries are still moving,
which is exactly when you want one working tree.

Suggested order inside that plan:

**Phase 0 — make the port safe (do this before moving any file)**
1. Land the second `ICollaboration` implementation (§4). Get the room tests
   green with no API key.
2. Write the import audit (§5) against the *current* monorepo. It will fail.
   That failure list is your real work item list, and it stays accurate as you
   develop.

**Phase 1 — open the chokepoints, still in one package**
3. Split `Models` (§3.1).
4. Split `contract.py` and `main.py` by feature — same package, separate files,
   satellite routes in their own `create_*_router(backend, authorize)`.
5. Make `Backend.over` take no satellite adapters (§3.3).
6. Introduce the `Database` protocol (core guide §4).

After phase 1, the monorepo still ships as one thing but every boundary is real.
**This is the point of no regret** — if the port stalls here, you have still
fixed the bloat.

**Phase 2 — extract, easiest first**
7. `wsfs-assistant-suede` (backend + frontend). Cleanest satellite: its backend
   imports two core modules and reads nothing back.
8. `wsfs-pytutor-suede`. Depends on assistant for the `ITutor` seam, and on
   python for edit attribution — so it can be *started* here but only
   *finished* after step 9.
9. `wsfs-python-suede`. Requires the editor-surface protocol first — see the
   svelte guide §3.
10. `wsfs-svelte-suede`. Last, because it is the biggest and because the other
    extractions tell you what its public surface needs to be.

**Why svelte last, when it is the most bloated:** its API is defined by its
consumers, and two of its consumers (assistant, python) are being extracted in
steps 7 and 9. Extracting it first means guessing at its surface and then
changing it three times.

**Phase 3 — vendored shadcn**
`release/frontend/svelte/shadcn` is ~5,230 lines as of `576b33e`, 44% of the
Svelte layer. It is a separate decision from everything above and should not be
allowed to block anything. See the svelte guide §5.

---

## 7. What each guide is for

| Guide | Covers |
|---|---|
| `PORT-wsfs-core-suede.md` | The filesystem, sync, rooms, compose; the `Database` protocol; what core exports and to whom |
| `PORT-wsfs-svelte-suede.md` | The UI library; the editor-surface protocol; the y-textarea decision; shadcn |
| `PORT-wsfs-assistant-suede.md` | Chat, snapshots-as-context, `ITutor`, the assistant panel |
| `PORT-wsfs-pytutor-suede.md` | Stuck detection, the offer, `progress`, the study instrument |
| `PORT-wsfs-python-suede.md` | Kernel adapter, Monaco surface, language services |

Each opens with its **role in one sentence**, its **boundaries**, an
**inventory with anchor phrases**, the **work to do**, and **how to know it
worked**.
