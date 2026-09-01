# A tour of `wsfs_python_suede`

Making Python work inside a workspace: Monaco with language services, a Pyodide
kernel, and the filesystem each of them sees.

**This is the only package that knows Monaco or pyodide exists.** After the
split, `grep -rn "monaco\|pyodide"` across every other one returns nothing, and
`tools/audit-imports.py` fails the build if that stops being true.

It is also the smallest — about 900 lines — because almost everything it needs
already exists somewhere below it. What is here is the wiring.

---

## 1. `MonacoEditor.svelte` and `monaco.svelte.ts`

This is what `editorFor` hands the shell for a file this package draws.

**The model outlives the editor.** A tab dragged to another dock group is torn
down and rebuilt, so what a person typed lives in `MonacoModel` rather than in
whichever `IStandaloneCodeEditor` happens to be drawing it.

`MonacoModel` implements `Editor` from `wsfs_svelte_suede` — four members, and
three of them exist so the shell can keep what somebody typed when no shared
document holds it yet.

Two orderings matter and both are enforced rather than documented:

- **The shell hears about the model only once Monaco has handed over an
  editor**, because until then there is no edit stream to report. `edits`
  throws if you reach it earlier — a caller getting the order wrong is a bug,
  not a case to handle.
- **`bind` happens only once the document has arrived**, which the shell
  guarantees by not offering one before then. `MonacoBinding` makes the model
  say whatever the `Y.Text` says the moment it is constructed.

## 2. `edits.ts` — the refinement, not the mechanism

VS Code tags every model edit with what caused it: `cursor`/`type`,
`cursor`/`paste`, `applyEdits`, `setValue`, `suggest`, `Chat.applyEdits`. That
is the only signal that *names* the gesture, and the only one that works before
there is a shared document at all.

It is also the fragile half, knowingly: **`detailedReasons` is on the runtime
event and absent from Monaco's public typings.** It is read defensively and its
absence is survivable — `reported: false` says the gesture was inferred.

The sufficient half — the Yjs transaction origin — is in
`wsfs_svelte_suede/frontend/edits.ts`, and `UserEdits` here extends the `Edits`
class from there. Read that file's section on the asymmetry before changing
either.

The three tables at the top (`AT_THE_CARET`, `OFFERED`, `AN_ASSISTANT`) are
VS Code's own source strings. The set is closed, so an unrecognised one is
treated as programmatic: better to drop an edit that was the user's than to
attribute one that was not.

## 3. `adapters/` — what Python and the editor can see

Two files, both small, both with a property that is easy to break.

**`kernel.ts`** — the kernel's view of the workspace. **Everything is answered
synchronously**, from state the client already holds: stream events prefetch
content as they arrive, and an open file is answered by its document. Python
*blocks* while these are answered, so a change that makes any of them await a
network request wedges the kernel — and the symptom is a program that never
finishes rather than an error.

**`files.ts`** — the editor's file provider. It wants paths and text and
nothing else, which is most of what makes it a good seam: the editor never
learns that entries have ids, tokens or a queue behind them. Only appearances
and disappearances are announced; content changes reach the editor through the
document it holds open.

Both go through **`FileOverride`**, and that is the mechanism rather than a
convenience. Core deliberately does not decide who else to trust, because an
editor holding a buffer somebody is typing into knows something the filesystem
does not. This package is that consumer, and the override is what makes *what
Python reads is what the editor shows* true rather than merely intended. The
shell builds it; see `Shell.override`.

## 4. `kernel.ts` and `Runner.svelte`

**A kernel is expensive and single-use.** Starting one is seconds of Pyodide
coming up, and a program that ran and left globals behind is not a clean place
to run the next one — so `WarmPool` keeps a warm one ready and never hands the
same one out twice.

`Runner.svelte` is the terminal: it runs the file, streams output, and appends
a `Run` to `file.runs`. `outputs` is opaque above this package — core stores
whatever a kernel produced without reading it, so a kernel learning a new kind
of output changes nothing above it — and `produced()` here is the one place
that narrows it back.

## 5. Does this package need a backend?

Not today, and the answer is worth re-deriving rather than assuming.
Everything Python-related on the server is language-agnostic by design:
`ExecutionRow.outputs` is opaque JSONB precisely so that a server parsing it
would have to change every time a kernel learned a new output, and
`/executions` says nothing about Python.

Revisit if a server-side runner, server-resolved packages, or hosted language
services arrive. Any of those gets a `backend/` here that mounts over core the
way `wsfs_assistant_suede` does — taking `Backend` + `Authorize`, never
reaching into `service`.

## 6. Svelte-bound, deliberately

`python-monaco-suede` ships Svelte bindings and no others, and this package
inherits that rather than choosing it. So everything here that is **not**
Svelte-bound — the adapters, the edit refinement, the kernel pool — is kept free
of it, so it survives that changing. Only `MonacoEditor.svelte` and
`Runner.svelte` are components.

## 7. Running it

```bash
npx vitest run tests/frontend/python
cd samples/frontend && npm run test:browser -- --component Runner --silence 300
```

The editor cannot be tested without a browser. Two things about driving that
suite here specifically:

- the **first** test in a run boots Pyodide, which is why `--silence` has to be
  generous;
- **do not warm two browser containers at once.** Preparing one builds its
  image, and two `playwright install --with-deps` builds plus two `runc
  create`s in flight is the state a Docker daemon has died in.

## 8. Your first change

Add an output kind the terminal can draw. `Runner.svelte` renders through
`snippets.output.any` from `python-web-kernel-suede`; a new one shows up there,
and `Runner.test.svelte` in the sample drives real runs against a real kernel.

For something harder: `detailedReasons` will vanish from Monaco eventually.
Writing the test that proves attribution still works without it — an edit with
the field absent, still attributed via the Yjs origin — is the single most
valuable thing anyone could add to this package.
