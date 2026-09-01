# Testing `wsfs_python_suede`

> [!NOTE]
> This file describes how to set the suite up on this repository's **`main`**
> branch. What you are reading now shipped inside `release/`, so the paths
> below are `main`'s: this package's source is at `release/`, and everything
> the suite adds lives beside it.

**One check says whether this extraction worked, and it is a grep:**

```bash
grep -rn "monaco\|pyodide" <every other wsfs package>   # returns nothing
```

This is the only repository in the family that knows either exists. Everything
below is about keeping that true while the things it wires up go on working.

---

## 1. What `main` looks like

```
wsfs_python_suede/
  release/                     <- this package (frontend/ only)
  wsfs_core_suede/             <- root-owned, like every dependency here
  wsfs_svelte_suede/
  python-monaco-suede/
  python-web-kernel-suede/
  samples/frontend/            <- a SvelteKit app that mounts the editor
  tests/frontend/              <- vitest
  tsconfig.json
  vitest.config.ts
```

Install every dependency with `--root-owned`. Suede's default names a
dependency after whoever asked for it, which gives one folder two paths — and
TypeScript reads two paths as two nominal types, so a `SharedTextFile` from
`wsfs_svelte_suede` stops being assignable to the one this package's `Runner`
declares.

## 2. Does this repo need a backend?

Not today, and the answer is worth re-deriving rather than assuming. Everything
Python-related on the server is language-agnostic by design: `ExecutionRow.outputs`
is opaque JSONB precisely so that a server parsing it would have to change every
time a kernel learned a new kind of output, and `/executions` says nothing about
Python. So: **frontend only.**

Revisit if a server-side runner, server-resolved packages, or hosted language
services ever arrive. Any of those gets a `backend/` here that mounts over core
the way `wsfs_assistant_suede` does — taking `Backend` + `Authorize`, never
reaching into `service`.

## 3. The gates

```bash
npx tsc -p tsconfig.json                              # the non-component types
npx vitest run                                        # the adapters
cd samples/frontend && npm install && npm run check   # svelte-check, the real one
```

`tests/frontend/adapters.test.ts` covers the kernel's and the editor's views of
the workspace. Two properties in `adapters/kernel.ts` are load-bearing and easy
to break in a refactor that looks harmless:

1. **Everything is answered synchronously**, from state the client already
   holds. Python blocks while these are answered — stream events prefetch
   content as they arrive, and an open file is answered by its document. A
   change that makes any of them await a network request wedges the kernel, and
   the symptom is a program that never finishes rather than an error.
2. **`FileOverride` is how the open buffer wins.** Core deliberately does not
   decide who else to trust, because an editor holding a buffer somebody is
   typing into knows something the filesystem does not. This adapter is that
   consumer, and the override is what makes *what Python reads is what the
   editor shows* true rather than merely intended.

## 4. The Monaco half of edit attribution

`frontend/edits.ts` reads `detailedReasons`, which is on the runtime event and
**absent from Monaco's public typings**. It is read defensively for that reason,
and its absence is survivable: `reported: false` says the gesture was inferred.

Two tests are worth having, and the second is the one people forget:

- a peer's edit arriving through the shared document does not look like this
  person's — that one lives in `wsfs_svelte_suede`, because the rule does;
- **an edit with `detailedReasons` absent still attributes correctly**, via the
  Yjs origin. The day a Monaco upgrade drops that field, this is the test that
  says so. Without it the failure is silent: a vaguer `did`, and nothing else.

## 5. The browser suite

The editor cannot be tested without a browser, so `samples/frontend` is where
the real coverage is.

```bash
docker compose -f samples/compose.yml up -d --build
npm install && cd samples/frontend && npm install && npm run dev
npm run test:browser -- --component Runner --browser chromium --silence 180
```

`--silence 180` because the default 120s window is too short for this suite,
and it gives up with `Report server timed out`, which reads like a hang and is
not one. Run scenarios one at a time (`--test "<regex>"`) and
`curl -X DELETE http://localhost:8099/rendezvous` between runs.

**Do not warm two browser containers at once.** Preparing one builds its image,
and two `playwright install --with-deps` builds plus two `runc create`s in
flight is the state a Docker daemon has died in twice. Warm serially; the image
is what you are protecting, and it is cached.

## 6. The Monaco surface

`MonacoSurface.svelte` is this package's answer to `wsfs_svelte_suede`'s
`EditorSurface`, and the protocol is what lets everything above it stay
ignorant of Monaco. Three rules apply to it as to any surface:

- bind to the ROOM's `Y.Doc`, never one of its own — a room outlives its
  providers, and a document the surface made is thrown away with the surface;
- report edits with `shared: false` before a document is bound;
- never diff the file into the document.

Bound only once the document has been RECEIVED, which the caller guarantees:
`MonacoBinding` makes the model say whatever the `Y.Text` says the moment it is
constructed, so binding an unsynchronised document does not show an empty file,
it makes one — and the next store writes that over the real content.

## 7. The boundary

```bash
python3 tools/audit-imports.py
```

This package may not import a model library, `wsfs_assistant_suede` or
`wsfs_pytutor_suede`. It may — and does — import Monaco and pyodide, and it is
the only one that may.
