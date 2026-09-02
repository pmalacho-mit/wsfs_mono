# Finding your way around

Five packages, one tree. This is the map; each package has a `GUIDE.md` of its
own that walks its files in the order they make sense in.

| Start here if you want to… | Go to |
|---|---|
| understand how a file gets from a keystroke to the database | [wsfs_core_suede/GUIDE.md](../wsfs_core_suede/GUIDE.md) |
| change what a workspace looks like | [wsfs_svelte_suede/GUIDE.md](../wsfs_svelte_suede/GUIDE.md) |
| change the editor, or how a program runs | [wsfs_python_suede/GUIDE.md](../wsfs_python_suede/GUIDE.md) |
| change what the tutor is asked or shown | [wsfs_assistant_suede/GUIDE.md](../wsfs_assistant_suede/GUIDE.md) |
| change when a student is nudged, or what the study records | [wsfs_pytutor_suede/GUIDE.md](../wsfs_pytutor_suede/GUIDE.md) |

---

## The one paragraph version

A **workspace** is a tree of entries. Nothing is ever overwritten: every change
is a row appended to one of five logs, and what a file *currently* says is the
newest row in the content log for it. That is `wsfs_core_suede`, and it is both
halves — the FastAPI router and the client library that talks to it.

A **text file is also a shared document**. When somebody opens one, the server
fills a Yjs room from the file, and everyone editing it is editing the room.
Only the server carries text into a room; a client that typed the file's text
in would create a second copy of every character. That rule is in core too.

Everything above core is a way of looking at that: a Svelte shell
(`wsfs_svelte_suede`), Monaco and a Python kernel inside it
(`wsfs_python_suede`), a chat panel beside it (`wsfs_assistant_suede`), and a
tutor watching the person work (`wsfs_pytutor_suede`).

## The direction rule

```
wsfs_pytutor_suede  ──▶ wsfs_assistant_suede ──┐
        │                                      ├──▶ wsfs_svelte_suede ──▶ wsfs_core_suede
        └────────────▶ wsfs_python_suede    ───┘
```

Imports point **down** and never up. Core has never heard of an assistant;
`wsfs_svelte_suede` has never heard of Python. When you want an upward import,
you have found a missing seam in the package below, not a reason to break the
rule — and `tools/audit-imports.py` fails the build over one.

Every existing seam was created by that pressure, so the list is short and each
entry is worth knowing:

| Seam | Declared in | Filled by |
|---|---|---|
| `ICollaboration` | core, backend | core (in-process, Liveblocks) |
| `Enter` / `Provider` | core, frontend | core's `collaboration/liveblocks.ts` |
| `FileOverride` | core, frontend | the shell in `wsfs_svelte_suede` |
| `Editor` / `EditorFor` | `wsfs_svelte_suede` | its own textarea; Monaco in `wsfs_python_suede` |
| `Edits` | `wsfs_svelte_suede` | refined by Monaco in `wsfs_python_suede` |
| `ITutor` | `wsfs_assistant_suede` | `llm.Tutor`, or a test's |

## Reading the code

Three conventions, and knowing them saves a lot of guessing.

**Names say what a thing IS, not what happened to it.** A variable called
`content` holds content; one called `stored` is what was stored. If you find a
name that does not tell you what is inside it, that is a bug in the code rather
than in you — rename it.

**Comments explain WHY, never what.** The code says what it does. A comment is
there because something is surprising, was got wrong once, or costs something
that is not visible locally. Several of them name the failure they prevent; if
you are about to change the line under one, read it first.

**Capitalised sentences in comments are load-bearing rules.** `ONLY THE SERVER
CARRIES TEXT INTO A ROOM` is not emphasis, it is a rule the system's
correctness rests on — usually one somebody lost data learning. There are over
a hundred, and reading them is the fastest way to learn what this codebase is
afraid of:

```bash
grep -rn "^\s*\* [A-Z][A-Z ]\{6,\}" wsfs_*_suede
```

## Running things

```bash
./tests/run.sh                  # the backends, against a throwaway postgres
npx vitest run                  # the clients' logic, no browser
./tools/typecheck.sh            # types, for every package
python3 tools/audit-imports.py  # the direction rule
```

And the browser, which is the only thing that can answer whether a workspace
actually works:

```bash
# terminal 1 -- a sync engine, so the room suites can run at all
npx liveblocks dev --port 1153            # needs Bun on PATH; mints sk_localdev

# terminal 2 -- the database and the sample host
docker compose -f samples/compose.yml up -d --build   # or, by hand:
DB_HOST=127.0.0.1:55433 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
  LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153 \
  PYTHONPATH=.. python -m wsfs_mono.samples.backend.serve

# terminal 3 -- the app
cd samples/frontend && VITE_LIVEBLOCKS_BASE_URL=http://localhost:1153 \
  npm run dev -- --host 0.0.0.0

# terminal 4 -- the suite
cd samples/frontend && npm run test:browser -- \
  --browser chromium --silence 300 --forward 5173,1153
```

Three things about that last one, each of which has cost somebody an hour:

- **`--silence 300`.** The default is 120s and measures time since *any*
  browser last said anything. It gives up with `Report server timed out`, which
  reads exactly like a hang and is not one.
- **`Report server timed out` with NO test output at all means the component
  did not compile.** A component that fails to build never reports, and a
  report that never arrives is indistinguishable from a slow one. Before
  suspecting the harness, ask Vite to build the file and read the answer:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/src/lib/<X>.test.svelte`
  — 500 means the file is broken, and the body carries the parse error. This
  cost a long hunt for a duplicate `const` that `./tools/typecheck.sh` had been
  reporting all along and the script was filtering away.
- **`--component <regex>`** while you are working on one thing. A full run is
  minutes; one component is seconds.
- **`curl -X DELETE http://localhost:8099/rendezvous` between runs.** Nothing
  resets it, so a re-run against a live backend meets the previous run's agreed
  ids and quietly tests nothing.

The report lands in `fashion-show.md`, with a screenshot per test.

**Do not run `./tests/run.sh` and the browser suite at the same time.** The
backend suite's compose file creates a second docker network, and the browser
driver picks its network by looking for exactly one — so a concurrent run dies
with `Multiple networks found, and no filter was provided to select one`, which
names neither the suite nor the network that confused it.

**Do not edit source while a run is in flight.** The dev server hot-reloads the
page underneath the browser, the run loses its place, and you get
`Report server timed out` — which reads exactly like a hang.

### Rooms, and the local sync engine

Four components enter real collaboration rooms and assert that two clients
agree: `Shared` (21 scenarios, two browsers on one room), `Reach` (3), `Soak`
(2), and `Tutor` (1). `Sample` has four such scenarios among its 21. Without a
Liveblocks server they fail with `Liveblocks Authentication failed: token: 503`
and then `room did not open: never synced`.

**You do not need a hosted key.** Liveblocks open-sourced the sync engine, and
its dev server mints its own `sk_localdev`:

```bash
npx liveblocks dev --port 1153        # needs Bun on PATH
```

Point both halves at it and nothing else changes:

```bash
LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153 \
  python -m ...                       # the sample host
VITE_LIVEBLOCKS_BASE_URL=http://localhost:1153 npm run dev
npm run test:browser -- --forward 5173,1153 --component Shared \
  --browser chromium --browser firefox
```

`--forward 5173,1153` is the part that is easy to miss: the browser runs in a
container, so the sync engine has to be published on its localhost too, and
without it every room fails to open with no mention of a port.

`LIVEBLOCKS_BASE_URL` and `VITE_LIVEBLOCKS_BASE_URL` are the names the
Liveblocks CLI exports itself, so `liveblocks dev --cmd '<your command>'` sets
both for a child process and needs no configuration at all. Unset, both sides
fall back to `https://api.liveblocks.io`, which is what a run with a real key
wants. The seam is `api_base()` in `wsfs_core_suede/backend/collaboration/`
and `baseUrl()` in `samples/frontend/src/lib/harness/liveblocks.ts` — one
function each, because the token mint and the room API must never disagree
about where the server is.

**What this is worth: it finds bugs nothing else can.** `Sample`'s "typing
survives the whole page going away" failed the moment a real room existed:
`rescueWhatWasTyped` handed the text to the rescue channel on `pagehide` and
left the file marked dirty, while its sibling `keepWhatWasTyped` clears it. A
snapshot taken on the way out therefore reported work as lost that had in fact
been saved. Two spellings of one rule, and only a real room made the
disagreement visible.

**Two failures that are not about rooms.** `Tutor` needs a *model* key, not a
Liveblocks one — with none, the sample serves a tutor that says it is not wired
to a model, and the test sees the failure paragraph. And `Sample`'s "a person
editing through the real UI loses nothing" is a soak test that intermittently
times out waiting for `dirty` to clear; the round it dies on moves between
runs, so it is a timing question in the store path rather than a defect with a
single cause. Neither is fixed by a key.

## Known open failure

`Sample` › "a person editing through the real UI loses nothing, round after
round" fails about one run in five, with the file saying a line twice. The root
cause is in `docs/a-line-said-twice.md`: the client stores text the
collaboration server has not got yet, so the host carries it into the room and
the client's own copy arrives after it.

**Two different failures wear that test's name** — text arriving twice, and
text never arriving. A pass/fail count cannot tell them apart, and four
measurements were taken across the mixture before anybody classified it.
Compare the length of `got` against `wanted` before comparing any rates.

## Where to put a new thing

Ask which package could not do its job without it.

- Does the *filesystem* need it — a new transaction, a new query, a rule about
  names? **core.** If a UI could not exist and the answer would still be
  needed, it is core's.
- Does it *draw* something generic — a panel, a dialog, a tree affordance?
  **`wsfs_svelte_suede`.**
- Does it mention Python, Monaco, or pyodide? **`wsfs_python_suede`**, and
  nowhere else.
- Does it talk to a model? **`wsfs_assistant_suede`**, and only in `llm.py`.
- Does it decide something about a *student* — when to help, what to record?
  **`wsfs_pytutor_suede`.**

If two answers fit, the thing is probably two things.
