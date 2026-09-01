# Testing `wsfs_core_suede`

> [!NOTE]
> This file describes how to set the suite up on this repository's **`main`**
> branch. What you are reading now shipped inside `release/`, so the paths
> below are `main`'s: this package's source is at `release/`, and everything
> the suite adds lives beside it.

**The headline check is that `pytest` is green with no `LIVEBLOCKS_SECRET_KEY`
and no network.** That is what says core is standalone. If a room test ever
needs a key again, the collaboration boundary has quietly stopped being a
boundary — see §3.

---

## 1. What `main` looks like

```
wsfs_core_suede/
  release/                     <- this package (backend/ + frontend/)
  sqlmodel_utils_suede/        <- its one dependency, installed at the root
  samples/backend/app.py       <- a host app, of the kind core is mounted into
  tests/                       <- the suite
  tests/frontend/              <- the client suite (vitest)
  pytest.ini
  vitest.config.ts
  tsconfig.json
```

**The dependency sits at the ROOT, not inside `release/`.** `backend/models.py`
reaches it with `from ...sqlmodel_utils_suede`, which is three levels up from
`release/backend/models.py` — the repository root on `main`, and the consumer's
root once it is installed. The `release/` directory is what makes those two
depths the same, which is why the suite must not be run from inside it.

**Install it root-owned:**

```bash
bash <(curl -fsSL https://suede.sh/install/release) \
  --repo pmalacho-mit/sqlmodel-utils-suede --root-owned --name sqlmodel_utils_suede
```

`--root-owned` matters and is not cosmetic. Suede's default names a dependency
after whoever asked for it, so two dependents get two paths to one folder —
and TypeScript reads two paths as two nominal types, while Python builds two
module objects with two SQLModel registries. Everything in this family is
installed root-owned for that reason.

## 2. Bringing the database up

The suite runs against a real Postgres, because core depends on four Postgres
behaviours it cannot be tested without: `REPEATABLE READ` set as the first
statement, `SELECT DISTINCT ON`, `DELETE … RETURNING` in one statement, and
`JSONB`. See the `AsyncDatabase` note in `backend/main.py`.

```bash
./tests/run.sh                # everything, then tear the stack down
./tests/run.sh --keep         # leave it up (much faster re-runs)
./tests/run.sh -k rooms -x    # anything else goes straight to pytest
```

Or, against a database you already have:

```bash
DB_HOST=127.0.0.1:5432 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
  python -m pytest tests -q
```

`pytest.ini` puts the import root **above** this repository:

```ini
pythonpath = .. tests samples/backend
```

so `release/`'s `from ...sqlmodel_utils_suede` resolves the way it will in a
consumer. Renaming the checkout directory breaks that; it is the one piece of
the layout that is load-bearing.

## 3. The collaboration seam, and why it is two implementations

`backend/collaboration/` ships **two** things that satisfy `ICollaboration`,
and neither is privileged:

| | What it is | When it runs |
|---|---|---|
| `InProcessCollaboration` | rooms held in this process, over `pycrdt` | always — it is the default |
| `Liveblocks` | the hosted service, over plain HTTP | only when `LIVEBLOCKS_SECRET_KEY` is set |

`tests/collaboration.py` is CONFORMANCE.md §O and is parameterised over both.
The Liveblocks half skips itself when there is no key, which is what lets the
rest of the suite run with neither a key nor a network.

**Run the Liveblocks half at least once before trusting a change to it.** It
needs no hosted account: Liveblocks open-sourced the sync engine, so
`npx liveblocks dev --port 1153` mints its own key and answers the same REST
API.

```bash
npx liveblocks dev --port 1153        # needs Bun on PATH
LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153 \
  pytest tests/collaboration.py       # 12 passed: both implementations
```

`LIVEBLOCKS_BASE_URL` is read by `api_base()` and defaults to the hosted
service, so nothing changes for a real deployment.

**The first run of that half failed, and the test was the thing that was
wrong.** Two cases asserted `document(room) == b""` for a created-but-empty
room. `InProcessCollaboration` returns exactly that; a real engine returns the
two-byte encoding of a document nobody has contributed to. Both decode to the
same empty document — `standing_of` and `carried` open the update either way —
so the assertion failed a service that conformed perfectly. They now ask
`text_of(...) == ""`. A conformance suite says what an implementation must
MEAN; the moment it pins an encoding, it stops describing the boundary and
starts describing whichever implementation was written first.

**The behaviour to keep an eye on** is the one the protocol's docstring states
twice: `document()` must answer **empty bytes** for a room nobody has written
to, rather than raising. Any implementation that raises there passes casual
testing and breaks seeding, because the keeper's whole job is telling "no such
room" from "a room holding nothing".

There is a trap in it worth knowing before writing a third implementation: an
*empty CRDT document is not empty bytes*. A fresh `pycrdt.Doc` encodes as two
bytes, and returning that verbatim makes a room nobody has written to look
written-to. `InProcessCollaboration` compares state vectors instead — see
`NOTHING_WRITTEN` there.

`tests/room_routes.py` drives the whole of it through the routes a browser
calls, against the in-process service. It is the test that says rooms work
end to end with no key.

## 4. The client suite

```bash
npx vitest run                                     # logic only, no network
WSFS_BACKEND=http://localhost:8099 npx vitest run tests/frontend/live.test.ts
```

Six files wake up when a server is pointed at, and they are the only ones that
can say whether the generated types describe what actually arrives. They skip
rather than fail when there is none.

To bring a server up the way they expect:

```bash
docker compose -f tests/compose.yml up -d test-db
DB_HOST=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  wsfs-core-tests-test-db-1):5432 \
  PYTHONPATH="..:samples/backend" \
  python3 -c "import uvicorn; from app import create_sample_app; uvicorn.run(create_sample_app(), port=8099)"
```

## 5. Regenerating the wire

`frontend/generate.py` mounts a stub app holding only this package's router and
writes `openapi.generated.json` and `schema.generated.d.ts` beside itself.

```bash
python release/frontend/generate.py
```

Run it whenever `backend/contract.py` changes, and commit both outputs. The
`.generated` in their names is there so that a hand edit announces itself as
something the next run will discard. **If the diff shows a satellite's shape**
— `Asking`, `Judging`, `Detected` — something downstream has been imported into
core's router, and that is the boundary failing rather than a schema change.

## 6. The gates, in the order they are worth running

```bash
python tools/audit-imports.py     # the boundaries, mechanically
npx tsc -p tsconfig.json          # the client's types
npx vitest run                    # the client's logic
./tests/run.sh                    # the server
```

**The import audit is the one that does not go stale.** Inventories of which
file holds what age; "core imports nothing satellite" does not. It asserts that
nothing under `backend/` or `frontend/` reaches for a UI library, a model
library, pyodide, monaco, or a satellite package — and that `@liveblocks/*`
appears in exactly the two adapter files that are named in the audit itself.
A third one has to be argued for by editing that list.

## 7. What must NOT be in this suite

Sections A–N and O of `CONFORMANCE.md` are core's. Anything beyond that belongs
to a satellite and should be **absent** here rather than skipped: a chat test in
core's suite is core knowing that an assistant exists.

The torture suite (N1–N5) is the strongest evidence a refactor of this size did
not quietly change behaviour. **Pin the seeds.** If a seed that passed before a
change fails after it, stop and find out why before going on.

---

## Running the backend suite and the browser suite together

Don't. `./tests/run.sh`'s compose file creates a second docker network, and the
browser driver picks its network by looking for exactly one -- so a concurrent
run dies with `Multiple networks found, and no filter was provided to select
one`, which names neither the suite nor the network that confused it.

For the same reason, don't point `pytest` at a database a browser run is using:
the suite truncates every table before each test, and the long-running host's
prepared-statement cache is invalidated underneath it. That surfaces much later
as `InvalidCachedStatementError` in an unrelated request.
