# Handoff: testing `wsfs-python-suede` on `main`

You are picking this up in the package's own repository. `release/` holds the
published code; everything else on `main` exists to test it.

**The smallest of the five, and the one with the heaviest dependencies.** No
backend. Its job is to fill the editor-shaped hole `wsfs_svelte_suede` leaves,
using Monaco, and to run Python in the browser with pyodide. Both of those are
large, slow and real — which shapes the whole suite.

## What can be tested without a browser

| | How |
|---|---|
| `frontend/edits.ts` — Monaco's `detailedReasons` half of edit attribution | `vitest`, 6 tests |
| everything else — the editor binding, the runner, the problem header | a real browser, or nothing |

Six unit tests is not an oversight. Almost everything this package does is
"Monaco behaves correctly when driven", and there is no honest way to assert
that without Monaco.

## 1. The gates, in order

```bash
npx svelte-check --tsconfig ./tsconfig.json    # from a consumer app; see §2
npx vitest run                                 # 6 passed
npm run test:browser -- --component Runner --browser chromium --silence 300
```

## 2. You need a consumer app

Same shape as `wsfs_svelte_suede` — a SvelteKit app importing `release/frontend`
plus `sweater-vest-suede` as a dev dependency. This package's components also
need `wsfs_svelte_suede`'s shell to sit in, and a host for files, so the app
ends up being the same app.

Browser components the monorepo covered:

| Component | | What it is really asking |
|---|---|---|
| `Runner` | 3 | pyodide starts, runs, and reports a failure as a failure |
| `edits` | 1 | Monaco's gesture names survive the trip |

`Runner` takes ~15–18s because pyodide is genuinely that slow to start. Do not
tune the timeout down; raise `--silence` instead.

## 3. The seam this package owns, and why the split is where it is

Edit attribution has two signals, and they are not equal:

- **Vendor-neutral** — a change that lands while a Yjs transaction that is not
  this editor's binding is in flight did not come from the person at this
  keyboard. Public, stable Yjs API. **Sufficient on its own.** It lives in
  `wsfs_svelte_suede`.
- **Monaco's `detailedReasons`** — the only signal that *names* the gesture
  (typing, paste, undo, an assistant's completion). Absent from Monaco's public
  typings. **A refinement.** It lives here.

Which half is sufficient decides what breaks when the other goes, and that
asymmetry is the entire reason the split falls where it does. A test here should
assert the refinement *adds* a name and never *gates* attribution: with the
Monaco half removed, edits must still be attributed, with `reported: false`.

## 4. Type identity, and the one install flag that matters

**Install every dependency `--root-owned`.** Suede's default names a dependency
after whoever asked for it, which gives one folder two paths — and TypeScript
reads two paths as two nominal types. The failure is the memorable one:

```
Type 'OpenText' is not assignable to type 'OpenText'.
```

This package sits two layers up (it depends on core *and* svelte, and pytutor
depends on it), so it is the most exposed of the five to that mistake.

## 5. Traps that cost time in the monorepo

- **The text-size slider must reach the editor.** `editorFor` hands back a
  snippet taking `[file: OpenText, size: number]`. An implementation that
  ignores the second argument compiles, renders, and silently does nothing when
  a person drags the slider — which is exactly what happened, and only the
  browser suite noticed.
- **`Report server timed out` with no test output means the component did not
  compile.** Ask Vite:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/src/lib/<X>.test.svelte`.
- **Do not filter your type gate by directory** — the monorepo's did, and a
  file that would not parse reported as clean.
- **pyodide needs the network on first run.** If the suite must work offline,
  vendor the wheel rather than skipping the tests.
