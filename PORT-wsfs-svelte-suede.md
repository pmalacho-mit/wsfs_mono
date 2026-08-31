# wsfs-svelte-suede

**Role:** a Svelte user interface for a wsfs workspace — file tree, file view,
history, layout shell, and a collaborative text-editing surface. Frontend only.

**Baseline:** `wsfs_suede` @ `576b33e`. Read `PORTING.md` §0 before acting on any
inventory here.

---

## 1. Boundaries

**BOUNDARY — depends on:** `wsfs-core-suede`, `wsfs_suede.dockview-svelte-suede`,
`wsfs_suede.pierre-trees-svelte-suede`, `wsfs_suede.with-events-suede`, `svelte`,
`yjs`.

**BOUNDARY — must not depend on:** pyodide, monaco, `python-web-kernel`,
`python-monaco`, any model library, `wsfs-assistant-suede`, `wsfs-pytutor-suede`,
`wsfs-python-suede`.

**BOUNDARY — no backend.** This repo ships `frontend/` only. If a component
needs something from a server, it needs it from core's client object
(`Workspace`), not from a route this repo invented.

**BOUNDARY — knows nothing about Python.** This is the boundary the current code
breaks hardest (§3), and the one that most changes the shape of this repo.

---

## 2. Inventory as of `576b33e`

`release/frontend/svelte/`, ~11,801 lines, minus the assistant panel.

| Group | Lines | Goes to |
|---|---|---|
| `shadcn/` (vendored UI kit + ai-elements) | 5,230 | §5 — separate decision |
| Top-level components (`Workspace.svelte`, `FileTree`, `FileView`, `History`, `Runner`, `Layout`, `Preview`, `ProblemHeader`, `app.css`, …) | 5,128 | here, mostly |
| `assistant/` | 1,183 | `wsfs-assistant-suede` |
| `shell/` | small | here |
| `room.svelte.ts` (~887, counted above) | | **core** — see core guide §6.2 |
| `edits.ts` (~430, counted above) | | §3 — split |
| `collaborator.ts` (~121) | | core adapter + test harness |

**INVENTORY caveat, and it is a big one:** the two largest files in this tree —
`Workspace.svelte` (~1,451) and `room.svelte.ts` (~887) — are not what their
location suggests. `room.svelte.ts` is mostly protocol, not UI (→ core).
`Workspace.svelte` is an *application shell* that wires everything together,
including Monaco, the kernel, the assistant panel and the nudge. It is the file
that will need the most decomposition, and it is the one most likely to have
changed since `576b33e`.

Anchor phrases:

| Role | File @ `576b33e` | Anchor phrase |
|---|---|---|
| Editor edit attribution | `edits.ts` | `What the person at this keyboard did` |
| Room joining (→ core) | `room.svelte.ts` | `Joining one file's shared document` |
| Two-browser test harness | `collaborator.ts` | `One participant, as a test can drive one` |

---

## 3. The editor-surface protocol — the central piece of work

Right now the Svelte layer is welded to Monaco. `edits.ts` imports
`python-monaco-suede` and reads VS Code's `detailedReasons`. You want Monaco to
live in `wsfs-python-suede`, and you want this repo to ship a plain
collaborative text surface instead (your y-textarea idea).

That means this repo must define **what an editing surface is**, and ship one
implementation, while `wsfs-python-suede` ships another.

### 3.1 What the protocol has to carry

Read out of what the current code actually consumes:

```ts
export type EditorSurface = {
  /** Bind this surface to the shared document for an entry. */
  attach: (doc: Y.Doc, text: Y.Text) => () => void;
  /** Show content with no shared document yet (offline, or pre-sync). */
  seed: (content: string) => void;
  /** Edits made BY THE PERSON AT THIS KEYBOARD. See 3.2. */
  edits: Observable<Edit>;
  focus: () => void;
  destroy: () => void;
};
```

Plus a registration point so a consumer can say "for files matching this, use
this surface":

```ts
export type SurfaceFor = (entry: Metadata) => EditorSurface;
```

`wsfs-python-suede` registers a Monaco surface for `.py`; this repo's textarea
surface is the default for everything else.

### 3.2 `edits.ts` is two things and must be split

This file is 430 lines of genuinely hard-won logic, and it is the piece most
likely to be broken by a careless split. Its docstring explains the problem:
`onDidChangeModelContent` fires for the user typing, a peer's keystroke arriving
through y-monaco, a formatter, a chat edit, and the binding seeding the model —
and focus is a poor way to tell them apart.

It uses **two** signals:

1. **`detailedReasons`** — VS Code's tag for what caused the edit. *Monaco-specific.
   Fragile (absent from public typings, read defensively).*
2. **The Yjs transaction origin** — a model change occurring inside a Yjs
   transaction that is not this binding's did not come from this person.
   *Vendor-neutral, public stable Yjs API.*

**Split along that line:**

- The **`Edit` shape** and the **Yjs-transaction-origin rule** are surface-agnostic.
  They belong here (or arguably in core, since core owns the room). A textarea
  surface bound with y-textarea has exactly the same problem and exactly the
  same second signal available.
- The **`detailedReasons` reading** is Monaco's. It goes to `wsfs-python-suede`
  as a refinement its surface supplies.

Note the file's own remark that signal 2 *"catches remote edits even if the
first signal ever goes away."* That is the design saying the split is safe: the
vendor-neutral half is sufficient on its own, and the Monaco half is an
improvement, not a requirement.

**Who consumes this:** `wsfs-pytutor-suede`'s stuck detector, through
`wsfs-python-suede`'s Monaco refinement. The `Edit` type is
therefore public API of this repo, and its shape is a boundary, not an
implementation detail. See the pytutor guide §3.

### 3.3 The default surface

You want something y-textarea-shaped: a plain text-editing element bound to a
`Y.Text` so files are collaboratively editable without an IDE.

Notes on doing it well:

- **Bind to the room's `Y.Doc`, not to a document the surface owns.** Core's
  room contract is explicit that the document is the room's and is handed in,
  *"because a room outlives its providers — that is what makes a network lapse
  survivable."* A surface that creates its own doc throws away everything typed
  during a lapse.
- **Emit `Edit` with `shared: false` before the provider has synced.** The
  current Monaco code does exactly this — *"the person is still editing, their
  edits just are not going anywhere yet"* — and pytutor's detector depends on
  hearing those.
- **Do not diff the file into the document.** Spec §13.14 and core's rule one:
  only the server carries text into a room. A surface that reads the file and
  types the difference in creates new characters and the file says everything
  twice. The surface renders the document; it never writes the file's text into it.
- **Handle non-text files.** Core's `RoomStanding.base` is null for a file that
  is not text a room can hold. The surface has to show *something* then, and
  `Preview.svelte` may already be the answer.

Whether you vendor, fork or reimplement y-textarea is a scope call. The three
rules above are the part that matters; a naive binding will violate the first
and third.

---

## 4. Decomposing `Workspace.svelte`

**INVENTORY (`576b33e`):** ~1,451 lines, and it imports the assistant, the
kernel, Monaco and the nudge. It is the single biggest obstacle to a clean split,
and it is *also* the file you are most likely to have edited since — so treat
this section as a shape to aim at rather than a set of line references.

The pattern that makes it splittable: **`Workspace.svelte` becomes a composition
root that this repo provides a skeleton for and consumers slot into.**

```svelte
<!-- wsfs-svelte-suede -->
<WorkspacePane
  {workspace}
  surfaceFor={mySurfaces}     <!-- python-suede supplies Monaco -->
  panels={[...]}              <!-- assistant-suede supplies a panel -->
  onEdit={...}                <!-- pytutor subscribes -->
/>
```

Three extension points, matching the three consumers:

| Extension point | Consumed by | Carries |
|---|---|---|
| `surfaceFor` | `wsfs-python-suede` | Monaco for `.py` |
| `panels` (dockview) | `wsfs-assistant-suede` | the chat panel |
| `edits` / `runs` observables | `wsfs-pytutor-suede` (via python) | stuck detection input |

`release/frontend/svelte/shell/WorkspacePane.svelte` already exists (~80 lines as
of `576b33e`) and may be the right place to grow this. Check it first.

**`Runner.svelte`** (~234 lines) is the awkward one: running a file is a Python
concept, but "record an execution against a snapshot" is core protocol
(`Executed`, `/executions`). Split it: the *record-and-display* half is generic
and stays here; the *invoke a kernel* half is `wsfs-python-suede`. The seam is
core's `workspace.executed(entry, snapshot, outputs, ok)`, which is already
kernel-agnostic — it takes opaque `outputs`.

---

## 5. Vendored shadcn — decide separately, do not let it block

`release/frontend/svelte/shadcn/` is ~5,230 lines: `ui/` (button, dialog, select,
…) and `ai-elements/` (conversation, message, prompt-input, response).

Three options:

| Option | Cost | Note |
|---|---|---|
| Keep vendored here | Zero now | 44% of this repo is somebody else's components |
| `wsfs-shadcn-suede` | One more repo | Honest, and `ai-elements/` is only used by the assistant |
| Real `shadcn-svelte` dependency | Real work | `shadcn-svelte` is already in `package.json` — check what is actually customised before assuming a fork is needed |

**Observation worth acting on:** `ai-elements/` (conversation, message,
prompt-input, response) is chat UI. Its only consumer is
`release/frontend/svelte/assistant/`. If shadcn stays vendored, `ai-elements/`
should move to `wsfs-assistant-suede` with its consumer, and `ui/` stays here.
That alone takes a meaningful bite out of this repo and needs no dependency
decision.

**Recommendation:** split `ui/` from `ai-elements/` along consumer lines now;
defer the vendor-vs-dependency question entirely. It blocks nothing.

---

## 6. `collaborator.ts` and the two-browser suite

**INVENTORY (`576b33e`):** ~121 lines, imports `@liveblocks/client`,
`@liveblocks/yjs`, `y-indexeddb`.

Its docstring is clear that the protocol itself moved into `room.svelte.ts` and
what is left is *"everything a scenario needs and a widget does not: the identity
to connect as, a network that can be taken away and given back."* That is a
**test harness**, and it should follow the protocol into core — where the room
tests live and where the second `ICollaboration` implementation makes it runnable
without a key.

What stays here is whatever drives the *component* in a two-browser scenario. Its
own docstring already argues for keeping the harness separate from
`Workspace.svelte` — *"a monaco instance in the middle would only make a failure
harder to place"* — which, pleasingly, is also the argument for the surface
protocol in §3.

---

## 7. Sequencing within this repo

Extract this repo **last** (`PORTING.md` §6, step 10). Its public surface is
defined by three consumers, two of which are being extracted before it.

Inside the repo, once you start:

1. Push `room.svelte.ts` and `collaborator.ts` down to core. Biggest single
   reduction, and it unblocks core's room work.
2. Split `edits.ts` (§3.2) and define `EditorSurface` (§3.1). Everything else
   depends on this existing.
3. Split `shadcn/ui` from `shadcn/ai-elements` (§5).
4. Move `assistant/` out.
5. Build the default text surface (§3.3).
6. Decompose `Workspace.svelte` into a composition root with three extension
   points (§4).

Steps 1–4 are moves. Steps 5–6 are new work, and 6 is the one that will take
longest and want the most iteration with real consumers.

---

## 8. How to know it worked

1. **Import audit clean** (`PORTING.md` §5): no pyodide, no monaco, no model
   library, no upward import.
2. **A workspace opens, renders a tree, and edits a text file collaboratively —
   with no Python anywhere.** This is the headline check. Two browser contexts
   against the default surface, converging.
3. **`CONFORMANCE.md` §O7** — with `shared()` true, path-addressed `write`
   throws locally and `shares` does not — passes against the default surface,
   not just against Monaco.
4. **A file that is not text** renders without the surface trying to bind a room
   to it.
5. **The `Edit` stream fires with `shared: false`** before the provider syncs.
   pytutor depends on this and it is easy to lose in a rewrite.
6. **`wsfs-python-suede` can register a Monaco surface** without this repo
   changing. That is the proof the protocol in §3 is real rather than
   Monaco-shaped with the names filed off.
