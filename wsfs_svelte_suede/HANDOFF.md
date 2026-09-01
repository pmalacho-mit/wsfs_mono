# Handoff: testing `wsfs-svelte-suede` on `main`

You are picking this up in the package's own repository. `release/` holds the
published code; everything else on `main` exists to test it.

**This is the package where the browser suite is most of the suite.** It is
almost entirely components, so the gates that need no browser can only tell you
the types line up — not that a workspace works.

Core needs a browser too, for a different reason (its storage layer), so if you
are setting up several of these repos it is worth reading
`wsfs_core_suede/HANDOFF.md` §4 alongside this one and deciding whether the two
share a host app.

## What can be tested without a browser, and what cannot

| | How |
|---|---|
| `frontend/edits.ts` — the vendor-neutral half of edit attribution | `vitest`, 13 tests |
| everything else — tree, dock, file view, history, text size, the shell | a real browser, or nothing |

There is no backend in this package. Anything it needs from a server it needs
through core's client object.

## 1. The gates, in order

```bash
npx svelte-check --tsconfig ./tsconfig.json    # from a consumer app; see §2
npx vitest run                                 # 13 passed
npm run test:browser -- --browser chromium --silence 300 --forward 5173,1153
```

`tsc` alone cannot check this package: it does not read `.svelte`, and running
it here reports every component import as a missing module. The type gate has
to run from an app that has the Svelte toolchain and the path aliases — which
is the same app the browser suite needs, so build it once.

## 2. You need a consumer app, and that is the real work

The browser suite drives components as a person does, which means something has
to mount them. In the monorepo that was `samples/frontend` — a SvelteKit app
that imports the package and hosts one `.test.svelte` per behaviour.

Minimum to reproduce:

- a SvelteKit app importing `release/frontend`
- `sweater-vest-suede` as a dev dependency (it drives a containerised Playwright
  and writes a Markdown report with a screenshot per test)
- a host to talk to. The tree, the dock and the file view all move real files,
  so they need core's backend running. In the monorepo that was
  `samples/backend`; the smallest honest version is core's router mounted on a
  FastAPI app over a throwaway Postgres.

**Port `FileTree.test.svelte` and `shell/TextSizeSlider.test.svelte` from this
package's own `frontend/`** — they already live beside the components and are
the model for the rest.

The components the monorepo covered, and their counts when last run:

| Component | |
|---|---|
| `FileTree` | 7 |
| `TextSize` | 6 |
| `Workspace` (the shell's layout) | 3 |
| `History` · `Versions` | 3 each |
| `Reclaim` · `edits` · `inview` | 2 · 1 · 1 |

## 3. Rooms, and why you want a sync engine

Several behaviours are only true when a real collaboration room exists — two
clients converging, a room that opens after the person has already typed, text
handed over when a tab closes. Without a sync engine those tests fail with
`Liveblocks Authentication failed: token: 503` and then `room did not open:
never synced`.

**You do not need a hosted key.** Liveblocks open-sourced the sync engine:

```bash
npx liveblocks dev --port 1153        # needs Bun on PATH; mints sk_localdev
```

Then give the host `LIVEBLOCKS_SECRET_KEY=sk_localdev` and
`LIVEBLOCKS_BASE_URL=http://localhost:1153`, the dev server
`VITE_LIVEBLOCKS_BASE_URL=http://localhost:1153`, and the run
`--forward 5173,1153`.

**`--forward` is the step people miss.** The browser runs in a container, so the
sync engine has to be published on *its* localhost too. Without it every room
fails to open and nothing mentions a port.

This is worth doing rather than skipping. In the monorepo, wiring a local sync
engine turned 27 unrunnable scenarios green **and immediately exposed a real
defect** that no keyless run could have shown — `rescueWhatWasTyped()` handed
text to the rescue channel on `pagehide` but left the file marked dirty, so a
snapshot taken on the way out reported saved work as lost.

## 4. The seam this package owns

`frontend/editor.ts` is short on purpose. Every member exists because the shell
must be able to keep what somebody typed when there is no shared document to
keep it in. Three rules, each of which has cost somebody a file:

1. **Bind to the room's document, never one of your own.** A room outlives its
   providers; a document the editor created is thrown away with the editor,
   taking everything typed during a network lapse.
2. **Report edits with `shared: false` before there is a document.** The person
   is still editing; anything counting activity has to hear them.
3. **Never diff the file into the document.** Only the server carries text into
   a room. An editor that reads the file and types the difference creates new
   characters, and the file ends up saying everything twice.

A test for a new editor implementation should assert those three directly.
`TextareaBinding` is the reference implementation — deliberately the least
capable thing that is correct.

## 5. Traps that cost time in the monorepo

- **`Report server timed out` with no test output at all means the component did
  not compile.** A component that fails to build never reports, and that is
  indistinguishable from a hang. Ask Vite directly:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/src/lib/<X>.test.svelte`
  — 500 means broken, and the body carries the parse error.
- **Do not filter your type gate by directory.** The monorepo's `typecheck.sh`
  reported only errors under `wsfs_*_suede/`, so a `.test.svelte` that would not
  parse reported as clean — costing a green typecheck, a green unit run, and a
  browser suite that timed out saying nothing.
- **`curl -X DELETE <host>/rendezvous` between runs**, if you port the paired
  two-browser tests. Nothing resets it, and a stale rendezvous surfaces as
  `room did not open: never synced`, which reads exactly like missing auth.
- **Do not edit source while a run is in flight** — HMR reloads the page under
  the browser and the run loses its place.
- **Tailwind does not scan `node_modules` or sibling packages.** `app.css` needs
  `@source` lines for this package's `frontend/` and for any dependency that
  names classes in its own JS. A missing one is silent: the class is simply
  never generated. This is how the copy button on every code block became
  unclickable — drawn, lit, enabled, and swallowing clicks.
