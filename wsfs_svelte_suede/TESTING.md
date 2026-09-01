# Testing `wsfs_svelte_suede`

> [!NOTE]
> This file describes how to set the suite up on this repository's **`main`**
> branch. What you are reading now shipped inside `release/`, so the paths
> below are `main`'s: this package's source is at `release/`, and everything
> the suite adds lives beside it.

**This package ships no backend, so there is no `pytest` here.** What it has is
three gates: types, the two pieces of pure logic it owns, and a browser suite
that renders the components against a real workspace.

---

## 1. What `main` looks like

```
wsfs_svelte_suede/
  release/                     <- this package (frontend/ only)
  wsfs_core_suede/             <- installed at the root, root-owned
  dockview-svelte-suede/
  pierre-trees-svelte-suede/
  with-events-suede/
  sweater-vest-suede/          <- the browser test driver, a DEV dependency
  samples/frontend/            <- a SvelteKit app that mounts the components
  tests/frontend/              <- vitest, for what can be tested without a DOM
  tsconfig.json
  vitest.config.ts
```

**Install every dependency root-owned:**

```bash
bash <(curl -fsSL https://suede.sh/install/release) \
  --repo pmalacho-mit/wsfs_core_suede --root-owned --name wsfs_core_suede
```

`--root-owned` is not cosmetic here, and this package is where the reason first
bites. Suede's default names a dependency after whoever asked for it, so a
`TextSize` from `wsfs_svelte_suede/frontend` and one from
`wsfs_assistant_suede__wsfs_svelte_suede/frontend` are the same file under two
paths — and TypeScript reads two paths as **two nominal types**. The symptom is
`Type 'TextSize' is not assignable to type 'TextSize'`, which reads like a
compiler bug and is not.

## 2. The types are the main gate

```bash
npx tsc -p tsconfig.json
```

Most of what this package is, is components, and `tsc` does not read `.svelte`.
The real gate is therefore `svelte-check`, run from the sample app because that
is where the Svelte toolchain and the aliases live:

```bash
cd samples/frontend && npm install && npm run check
```

It should report zero errors. `pierre-trees`'s context menu had drifted behind
what the file tree expects — no `note` row, no `isNote` — which was a runtime
`TypeError` rather than only a type error, so the menu rendered nothing. It has
been fixed in the vendored copy; `bash pierre-trees-svelte-suede/.suede/core/upstream`
is how that change goes back to the library.

## 3. What vitest covers, and what it deliberately does not

```bash
npx vitest run
```

`tests/frontend/edits.test.ts` is the one worth understanding before changing
anything, because **the failure it guards against has no symptom.**

Edit attribution is two signals, and this package owns the vendor-neutral one:
a change that lands while a Yjs transaction that is not this surface's binding
is in flight did not come from the person at this keyboard. The other half —
Monaco's `detailedReasons` — lives in `wsfs_python_suede` and only refines the
gesture's name.

If the Yjs half breaks, a peer typing looks like this student typing, nobody is
ever detected as stuck, and **nothing fails**. The experiment just quietly
stops finding anything. So it is asserted directly:

- a change reported while a peer's update is being applied is refused as
  `remote` — and the test applies a real update rather than opening a local
  transaction, because Yjs marks the second as `local` and the distinction is
  the whole rule;
- a change reported inside this binding's own transaction is let through;
- this app's own writes into the shared text (`become`, say) are `programmatic`;
- an edit reported with no surface signal at all still arrives, with
  `reported: false`.

Everything else here needs a DOM and belongs in the browser suite.

## 4. The browser suite

`samples/frontend` is a SvelteKit app whose `src/lib/*.test.svelte` files are
`sweater-vest` scenarios. They render the real components against a real
backend, which is the only way to test a file tree.

```bash
docker compose -f samples/compose.yml up -d --build   # the sample backend
npm install                                           # the ROOT one: vite.config needs it
cd samples/frontend && npm install && npm run dev
npm run test:browser -- --component FileTree --browser chromium --silence 180
```

Three things about driving it, each of which has cost somebody an hour:

- **`--silence 180`.** The default window is 120s and is too short. It measures
  time since *any* browser last said anything, and gives up with
  `Report server timed out`, which reads exactly like a hang and is not one.
- **Run scenarios one at a time** (`--test "<regex>"`). One test dying
  desynchronises a paired run and the partner times out on a barrier a test
  later, which makes a full run's output nearly unreadable.
- **`curl -X DELETE http://localhost:8099/rendezvous` between runs.** Nothing
  resets it for you, so a re-run against a live backend meets the previous
  run's agreed ids and quietly tests nothing. **Skipping it does not look like
  skipping it**: it surfaces as `room did not open: never synced`, which reads
  exactly like a missing Liveblocks key. Clear it before you believe any
  diagnosis.
- **A room suite needs a sync engine, and a local one is free.** `npx liveblocks
  dev --port 1153` mints its own `sk_localdev`; give the host
  `LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153`,
  the dev server `VITE_LIVEBLOCKS_BASE_URL=http://localhost:1153`, and the run
  `--forward 5173,1153`. See `docs/GUIDE.md` for the whole recipe. Worth doing
  rather than skipping those tests: a real room is what exposed
  `rescueWhatWasTyped` leaving a file dirty after it had already saved it.

Do not pipe a run through `tail` — it shows nothing until the run ends, so a
hang is indistinguishable from progress. Redirect to a file and read it.

## 5. The seam this repo owns, and how to test a change to it

**`Editor` (`frontend/editor.ts`).** Three rules, and each has cost somebody a
file: bind to the room's document rather than one of your own; report edits
with `shared: false` before there is a document; never diff the file into the
document. `TextareaBinding` is this package's implementation and the thing to
test a second one against — if it passes the same scenarios, the contract is
doing its job.

**The holes are optional, and that is what to assert.** `<Workspace {workspace}
{entering} />` with no `editorFor`, no `events` and no `onReady` must render a
tree, open a file and let you type into it. A test that does exactly that is
the proof that this package is still standalone.

## 6. The boundary

```bash
python3 tools/audit-imports.py
```

Nothing here may reach for pyodide, monaco, a model library, or any of
`wsfs_python_suede` / `wsfs_assistant_suede` / `wsfs_pytutor_suede`. The audit
is the mechanical statement of that, and unlike a file inventory it does not go
stale.

## 7. The shell, and the three holes in it

`Workspace.svelte` is this package's centre: it lays out an explorer on the left
and a dock of open files beside it, and hands everything it must not know about
to somebody else.

| Hole | Shape | Filled by |
|---|---|---|
| `editorFor` | `(path) => Snippet<[OpenText, number]> \| undefined` | Monaco, in `wsfs_python_suede` |
| `events` | `WorkspaceEvents` | the stuck detector, in `wsfs_pytutor_suede` |
| `onReady` | `(shell: Shell) => void` | the chat panel, in `wsfs_assistant_suede` |

A path `editorFor` has no answer for gets `Textarea.svelte`, which is bound to
the room's document and correct rather than capable — so **a workspace of plain
documents works with no consumer at all**, and that is the thing to test when
you change the shell:

```svelte
<Workspace {workspace} {entering} />
```

No `editorFor`, no `events`, no `onReady`. If that renders a tree, opens a file
and lets you type into it, the holes are genuinely optional.

`onReady` hands back the dockview grid plus the panel references to position
against, which is how a consumer adds its own:

```ts
shell.grid.addComponentPanel("panel", { render: mine }, {
  position: { direction: "right", referencePanel: shell.beside.documents },
});
```

`Panel.svelte` exists for exactly that: dockview resolves a panel by a name the
view was built with, so the shell declares one generic panel that renders a
snippet it never looks at.

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
