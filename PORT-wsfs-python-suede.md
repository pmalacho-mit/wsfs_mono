# wsfs-python-suede

**Role:** making Python work inside a wsfs workspace — the kernel's view of the
filesystem, running a file and recording what came out, and a Monaco editing
surface with language services.

**Baseline:** `wsfs_suede` @ `576b33e`. Read `PORTING.md` §0 before acting on any
inventory here.

---

## 1. Boundaries

**BOUNDARY — depends on:** `wsfs-core-suede`, `wsfs-svelte-suede`,
`wsfs_suede.python-web-kernel-suede`, `wsfs_suede.python-monaco-suede`.

**BOUNDARY — must not depend on:** any model library, `wsfs-assistant-suede`,
`wsfs-pytutor-suede`.

**BOUNDARY — `wsfs-pytutor-suede` depends on this repo, not the reverse.** Its
stuck detector consumes the Monaco edit attribution this repo supplies (§5.1).
That makes the `Edit` refinement public API here, not an internal detail.

**BOUNDARY — this is the only repo that knows Monaco or pyodide exist.** After
the port, `grep -rn "monaco\|pyodide" ` across every other repo returns nothing.
That is the single check that says this extraction worked.

**BOUNDARY — Svelte-specific for now, deliberately.** `python-monaco-suede` is
Svelte-bound and you have decided to live with that; in future it becomes that
library's responsibility to ship bindings for other UI libraries. Write that
decision into this repo's README so the constraint is visible rather than
inferred. It also means: keep everything that is *not* Svelte-bound — the kernel
filesystem adapter, the execution recording — free of Svelte, so it survives that
future change.

---

## 2. Does this repo need a `backend/`?

Probably not, and it is worth checking rather than assuming.

Everything Python-related in the server today is *language-agnostic by design*:
`ExecutionRow.outputs` is opaque JSONB precisely so that *"a server that parsed
it would have to be changed every time a kernel learned a new kind of output."*
The `Execute` transaction and the `/executions` route are core protocol and say
nothing about Python.

So the default answer is **frontend only**. Revisit if you later want:

- a server-side Python runner (not pyodide-in-the-browser);
- packages resolved or cached server-side;
- language services hosted rather than `browser-basedpyright` in the browser.

If any of those arrive, they get a `backend/` here — mounting over core the same
way the assistant does (`PORTING.md` §3.3), never reaching into `service`.

---

## 3. Inventory as of `576b33e`

| Role | File | Anchor phrase |
|---|---|---|
| The kernel's view of the workspace | `frontend/adapters/kernel.ts` (~109) | `The kernel's view of the workspace` |
| Adapter shared types | `frontend/adapters/index.ts` | — |
| Monaco edit attribution | `frontend/svelte/edits.ts` (~430), **the `detailedReasons` half** | `What the person at this keyboard did` |
| Running a file | `frontend/svelte/Runner.svelte` (~234), **the invoke half** | *(check docstring)* |
| Monaco surface + language services | wherever `Workspace.svelte` / `FileView.svelte` wire `python-monaco-suede` | `python-monaco-suede` |

**INVENTORY caveat:** as of `576b33e` there is no single "Monaco surface" file —
the wiring lives inside `Workspace.svelte` (~1,451 lines) and `FileView.svelte`
(~215). Extracting it *is* the work, and it depends on the `EditorSurface`
protocol existing first (svelte guide §3.1). Find the wiring by grepping for
`python-monaco-suede` rather than by looking for a file with a promising name.

`frontend/adapters/files.ts` (the editor's file provider) is **not** obviously
this repo's — check what it actually serves. If it is generic file-provider
plumbing it belongs in `wsfs-svelte-suede`; if it exists to feed Monaco's model
service it belongs here.

---

## 4. The kernel adapter is already clean — keep it that way

`adapters/kernel.ts` is small, Svelte-free, and imports only
`python-web-kernel-suede` types plus core's `Metadata`, `Path` and `Workspace`.
It moves as-is.

Two properties in it are load-bearing and easy to break in a move:

1. **Everything is answered synchronously from state the client already holds.**
   *"Python blocks while these are answered"* — stream events prefetch content as
   they arrive, and an open file is answered by its document. A port that makes
   any of these await a network request wedges the kernel. Core's
   `content.prefetch` exists for exactly this; keep the call sites.

2. **`FileOverride` is how the open buffer wins.** Spec §13.12: core deliberately
   does not decide who else to trust, because *"an editor holding a buffer
   somebody is typing into knows something this does not, and it is the consumer
   that knows it has one."* This adapter is that consumer. The override is not a
   convenience — it is the mechanism that makes *"what Python reads is what the
   editor shows"* true.

**Work item:** `FileOverride` is currently exported from core's `index.ts` (via
`./adapters`). Decide where the type lives. It is core's concept (the read-flow
priority seam) with this repo's implementation, so: **type in core, implementation
here.**

---

## 5. The Monaco surface

This is the main piece of work, and it is blocked on `wsfs-svelte-suede` §3.1
defining `EditorSurface`.

Once it exists, this repo ships:

```ts
export const pythonSurface: SurfaceFor = (entry) =>
  entry.name.endsWith(".py") ? monacoSurface(entry) : undefined;
```

and the composition root does:

```svelte
<WorkspacePane {workspace} surfaceFor={[pythonSurface, defaultTextSurface]} />
```

### 5.1 The `edits.ts` split — what this repo takes

Svelte guide §3.2 splits edit attribution into two signals. This repo takes the
Monaco-specific one:

- **`detailedReasons`** — VS Code tags every model edit with what caused it
  (`cursor`/`type`, `cursor`/`paste`, `applyEdits`, `setValue`, `suggest`,
  `Chat.applyEdits`). It is *"the only signal that names the gesture, and it works
  before there is any shared document at all."*
- It is also the fragile half: **the field is on the runtime event but absent
  from the public typings**, so it is read defensively and its absence must stay
  survivable. Keep the defensive read and the comment explaining it. A port that
  "cleans this up" with a type assertion will break on a Monaco upgrade and the
  failure will be silent — edits attributed to nobody.

The Yjs-transaction-origin signal stays in the shared layer. This repo's surface
*refines* attribution; it does not own it.

### 5.2 Language services

`browser-basedpyright`, `monaco-languageclient`, `vscode-languageserver-protocol`
and the `@codingame/monaco-vscode-*` overrides are all in the root
`package.json` as of `576b33e`. They all come here. They are the largest single
dependency cluster in the project and moving them out is most of the reason this
repo exists.

**Watch for:** Vite configuration. `vite-plugin-static-copy` and the
`@codingame/esbuild-import-meta-url-plugin` are in the root config to make Monaco
and its extensions load. That configuration has to travel with the dependency, or
this repo will work in the monorepo and fail everywhere else. Ship the required
Vite config as documented, copy-pasteable setup rather than assuming a consumer
will reconstruct it.

---

## 6. Splitting `Runner.svelte`

Running a file is two things:

| Half | Belongs to | Why |
|---|---|---|
| Invoke a kernel, collect outputs | here | pyodide-specific |
| Take a snapshot, record an execution against it, display runs | `wsfs-svelte-suede` | core protocol, kernel-agnostic |

The seam is already in core and is already right:

```ts
workspace.snapshot(entries)                            // → Submitting
workspace.executed(entry, snapshot, outputs, ok)       // outputs: unknown[]
```

`executed` takes opaque `outputs` — it does not know what a kernel is. So the
generic half can render a run history for *any* kernel, and this repo supplies
the kernel.

**One behaviour not to lose:** core reduces outputs to plain JSON *before* they
are queued (spec §13.15), because a queued transaction is written down and
structured clone refuses class instances, proxies and functions — *"one
unstorable output turns into 'your work is not being saved'."* That reduction is
in core's `workspace.ts` and stays there. This repo must not pre-empt it with its
own serialisation, and must not pass kernel objects around expecting them to
survive.

---

## 7. Sequencing

Extract after the assistant, before svelte (`PORTING.md` §6, step 9) — and
before `wsfs-pytutor-suede` can be finished, since pytutor consumes §5.1 —
but note the ordering tension: this repo is blocked on `EditorSurface`, which is
svelte's to define.

Resolve it by doing the *protocol* early and the *extraction* late:

1. **Phase 1 (in the monorepo):** define `EditorSurface` and split `edits.ts`.
   Both are small and both unblock two repos.
2. **Step 9:** move the kernel adapter, the Monaco surface, the language service
   dependencies and the Vite config out.
3. **Step 10:** svelte follows, and by then its extension points have a real
   consumer proving they work.

---

## 8. How to know it worked

1. **Import audit clean** (`PORTING.md` §5).
2. **`grep -rn "monaco\|pyodide\|basedpyright" ` in every other repo returns
   nothing.** The headline check.
3. **A workspace opens, renders and edits text with this repo not installed** —
   using `wsfs-svelte-suede`'s default surface. That is the same check as svelte
   guide §8.2, from the other side.
4. **With this repo installed, `.py` files open in Monaco with language services,
   and everything else still opens in the default surface.**
5. **Edit attribution still distinguishes the person from a peer** — with *and
   without* `detailedReasons` present, since that field can vanish on an upgrade.
6. **Python reads what the editor shows** — the `FileOverride` path, tested with
   an unsaved buffer.
7. **A run records an execution against a snapshot, and the run history renders**
   — proving §6's split held.
8. **This repo's Vite config, copy-pasted into a bare consumer app, loads Monaco.**
   The one that is easy to skip and expensive to discover later.
