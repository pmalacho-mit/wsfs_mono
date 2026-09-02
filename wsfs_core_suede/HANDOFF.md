# Handoff: testing `wsfs-core-suede` on `main`

You are picking this up in the package's own repository. `release/` holds the
published code — what this file calls "the package". Everything else on `main`
exists to test it.

This describes the suite as it stood in the monorepo where the package was
split out, with the numbers it actually reached. Port it; do not invent a new
one.

## What this package is, for testing purposes

**The only package with no user interface and no Svelte** — which makes the
type gate easy and the test story harder than it looks. `tsc` reads the client
directly and its backend is a FastAPI app you can build in-process. It is also
the package everything else depends on, so a regression here is a regression
everywhere.

Three halves, not two, and the third is the one people miss:

| | What it is | How it is tested |
|---|---|---|
| `release/backend/` | FastAPI + SQLModel over Postgres | `pytest`, against a throwaway database |
| `release/frontend/` — the logic | outbox, queue, index, rooms | `vitest`, no browser, no server |
| `release/frontend/` — the storage | IndexedDB, `localStorage`, quota, `pagehide` | **a real browser, or nothing** — see §4 |

## The headline check

**`pytest` is green with no `LIVEBLOCKS_SECRET_KEY` and no network.** That one
sentence is the boundary this package is organised around. If a test here ever
needs a collaboration key, the `ICollaboration` seam has stopped being a seam —
find out why before making the test pass.

## 1. The gates, in order

```bash
npx tsc -p tsconfig.json          # the client; no components, so tsc suffices
npx vitest run                    # 138 passed, 17 skipped
./tests/run.sh                    # 336 tests, containerised postgres
npm run test:browser              # the storage layer -- you have to build this; see §4
```

`tests/run.sh` builds an image and brings up its own Postgres. Do not point
`pytest` at a database anything else is using: the fixtures truncate tables
between tests, which invalidates a long-running server's prepared-statement
cache and produces `InvalidCachedStatementError` in the *other* process.

The 17 skipped vitest tests and the 6 skipped pytest tests are deliberate —
see §3.

## 2. What to port

- `tests/core/*.py` — 25 files. The names are the specification: `adjudication`,
  `drafts`, `history`, `place`, `refusals`, `reconstruction`, `topology`.
- `tests/frontend/core/*.test.ts` — the client's logic against a fake server
  (`tests/frontend/fake.ts`), which is worth reading first: it is the whole
  server contract in one file, and it is how the client is tested without one.
- `tests/run.sh` + `tests/compose.yml` + `tests/Dockerfile`.
- `tools/typecheck.sh` and `tools/audit-imports.py`.

**Postgres, not SQLite.** The service depends on `REPEATABLE READ` as the first
statement of a transaction, `SELECT DISTINCT ON`, `DELETE … RETURNING`, and
`JSONB`. A suite that swaps in SQLite to go faster is testing a different
program.

## 3. The conformance suite, and the one thing worth doing differently

`tests/core/collaboration.py` is parameterised over **both** implementations of
`ICollaboration`: the in-process one, and `Liveblocks` over HTTP. The Liveblocks
half skips itself when there is no key, which is what keeps the headline check
above true.

**Run that half at least once before trusting a change to it.** It needs no
hosted account — Liveblocks open-sourced the sync engine:

```bash
npx liveblocks dev --port 1153      # needs Bun on PATH; mints its own sk_localdev
LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153 \
  pytest tests/core/collaboration.py    # 12 passed: both implementations
```

`LIVEBLOCKS_BASE_URL` is read by `api_base()` in
`release/backend/collaboration/liveblocks.py` and defaults to the hosted
service, so nothing changes for a real deployment.

**The first run of that half failed, and the test was what was wrong.** Two
cases asserted `document(room) == b""` for a created-but-empty room. The
in-process implementation returns exactly that; a real engine returns the
two-byte encoding of a document nobody has contributed to. Both decode to the
same empty document, so the assertion was failing a service that conformed
perfectly. They ask `text_of(...) == ""` now. **A conformance suite says what an
implementation must MEAN**; the moment it pins an encoding it has stopped
describing the boundary and started describing whichever implementation was
written first.

## 4. You need a browser here too, and it is not optional

It is tempting to skip this one: core has no components, so `tsc` reads it
directly and `vitest` covers the logic. **That reasoning is wrong, and the gap
it leaves is the most safety-critical code in the package.**

`release/frontend` rests on browser machinery that `environment: "node"` cannot
provide:

| | Where | What it does |
|---|---|---|
| **IndexedDB** | `indexed.ts`, `reclaim.ts` | the durable outbox — the queue that survives a page load |
| `localStorage` | `stash.ts` | the last thing typed, written where writing *cannot fail* |
| `crypto.subtle` | `bytes.ts` | content digests |
| `navigator.storage` | `indexed.ts`, `reclaim.ts` | quota, persistence, eviction |
| `keepalive` fetch | `transport.ts`, `workspace.ts` | the write that must outlive the document |
| `pagehide`, `visibilitychange` | `debounce.ts`, `unsaved.ts` | flushing on the way out |

**In the monorepo, `indexed.ts` had no unit test at all.** Every line of it was
covered only by the browser suite in the sample app — `Reclaim.test.svelte`
directly, and every two-browser scenario indirectly, because each test client
calls `persistenceMechanism()`. Split this package out on its own and that
coverage vanishes silently: the gates stay green and the durable queue stops
being tested. For a package whose entire claim is *a user never loses work*,
that is the worst possible thing to leave uncovered.

Note also what a *fake* IndexedDB would not have caught: that the store still
opens after its schema version moves on, and that a payload nothing names is
actually collected rather than merely classified as collectable. Those are
questions about the real store.

### The shape to build

**A small Vite + TypeScript app, with Svelte as a dev dependency only.**

Svelte is there for the harness, not for the package. `sweater-vest-suede`
discovers `.test.svelte` files and drives a containerised Playwright, and the
*test bodies are plain TypeScript* — the `.svelte` file is a three-line shell
around an async function. Core ships no components and that does not change;
Svelte never leaves `devDependencies`.

The alternative — driving a plain TS page with Playwright directly — means
writing your own discovery, reporting and screenshots, and gives this repo a
different workflow from the other four. Not worth it for the two files of
scaffolding you would save.

```
main/
  release/            <- the package
  tests/              <- pytest + vitest, as today
  browser/            <- new: a Vite app whose only job is hosting tests
    index.html
    src/
      closet.ts       <- mounts sweater-vest's Closet
      Reclaim.test.svelte
      Stash.test.svelte
      Persistence.test.svelte
```

**Most of this already exists.** `samples/frontend/src/lib/core/` in the
monorepo holds four components covering exactly this ground — `transport` (13),
`warming` (10), `writes` (4) and `content` (3) — and `Reclaim.test.svelte`
covers the store. Port those first; they are straight TypeScript bodies with no
`vest` snippet beyond a `<pre>` for the screenshot, and their imports are the
only thing that changes.

Two of that transport file's scenarios are NOT core's and live elsewhere in the
monorepo: one asserts the tutor's `ask` is never retried, the other the same for
a study observation. Both routes belong to other packages now, so the tests sit
beside them (`lib/assistant/retry.test.svelte`, `lib/pytutor/retry.test.svelte`).
If you are setting up core alone, leave them out — but keep the property they
protect in mind, because it is core's `requests.ts` that decides it.

**What to cover there, in priority order:**

1. **`persistenceMechanism()` opens a store whose version has moved on.** A
   schema bump that hangs the open bricks every returning tab.
2. **The sweep actually collects.** Bytes stored and never named — what a tab
   dying between the payload and its row leaves behind — must be reclaimed, not
   merely classified as reclaimable.
3. **The queue survives a reload.** Write with the server unreachable, tear the
   page down, open again, and find the work still queued. This is the whole
   reason `indexed.ts` exists and nothing else asserts it.
4. **`stash.ts` on `pagehide`.** The last thing typed reaches `localStorage` in
   the same turn as the event; a page that is really going does not come back
   for a later attempt.
5. **Two tabs on one workspace.** Two clients on one database must not eat each
   other's queued work. `sweater-vest` can run two browsers at once, which is
   how the monorepo tested this.

You will need a host for anything past (2). The smallest honest one is this
package's own router on a FastAPI app over a throwaway Postgres — the same
container `tests/run.sh` already builds.

## 5. Traps that cost time in the monorepo

- **Install every dependency `--root-owned`.** Suede's default names a
  dependency after whoever asked for it, giving one folder two paths. TypeScript
  reads two paths as two nominal types, and Python builds two module objects, so
  `isinstance` starts answering `False` about an object of the class you are
  holding.
- **`clean_tables` truncates.** See §1.
- **A test that only asserts on the DOM or a return value passes happily while
  the console fills with errors.** The monorepo's fix was a `quiet()` helper
  that collects `console.error`, `error` and `unhandledrejection`, asserted on
  explicitly. It is worth porting the habit even without the browser suite.
