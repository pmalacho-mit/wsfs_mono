# A tour of `wsfs_svelte_suede`

The user interface: an explorer on the left, open files in dock tabs beside it,
and holes where the things this package must not know about slot in.

It has never heard of Python, of a model, or of a tutor. Keeping that true is
what the three holes are for.

---

## 1. Start with `Workspace.svelte`

It is the shell, and everything else here is something it lays out or something
it hands over. Read its module script first — the three exported types are the
whole public surface:

```ts
editorFor?: (path) => Snippet<[OpenText, number]> | undefined  // what draws a file
events?: WorkspaceEvents                                // what the person did
onReady?: (shell: Shell) => void                        // the grid, and what is on it
```

**`editorFor`** is asked per path. Answer with a snippet and you draw that file
however you like; answer `undefined` and it gets this package's plain textarea,
which is bound to the room's document and correct rather than capable.

The snippet is handed the file **and the size**, because the panel's text-size
slider is the shell's and outranks whatever a consumer configured every editor
with. An editor that ignores it is one the slider does not move — which is
exactly how the browser suite caught it being dropped.

**`events`** is a `WithEvents` bus with four events — `opened`, `closed`,
`focused`, `edited`. `wsfs_pytutor_suede` subscribes to all four; nothing here
knows why.

**`onReady`** hands back a `Shell`: the dockview grid, the panel references to
position against, the snapshot taker, and the `FileOverride`. That last one is
built here because only the shell knows which files are open and what they are
showing — which is exactly what makes an open buffer win over the stored file.

A consumer adding a panel of its own does:

```ts
shell.grid.addComponentPanel(
  "panel",
  { render: mySnippet },
  { size: 340, position: { direction: "right", referencePanel: shell.beside.documents } },
);
```

`Panel.svelte` is the pass-through that makes that possible: dockview resolves
a panel by a name the view was built with, and a name a consumer invented is not
one of them, so the shell declares one generic panel that renders a snippet.

## 2. Then `open.svelte.ts`

Two classes, and the split between them is the whole of it.

**`OpenEntry`** exists the moment a tab opens, before anybody knows what the
file holds. Reading it is a round trip, and it may turn out to be bytes.

**`OpenText`** appears if and when the content arrives as text. It owns the
room, the stores, and the rescues. Six methods are worth knowing:

| | |
|---|---|
| `showing` | what the person can see: the room's text, or the editor's, or what it opened on |
| `mounted(editor)` | an editor is on screen and reporting. Returns the undo. |
| `saveVersion()` | this text becomes a version now, awaited |
| `submitVersion()` | the same write, answered synchronously with the transaction |
| `versionBeingSaved()` | the version this text was put on the server as |
| `keepWhatWasTyped()` | the tab is closing and this is not anywhere else yet |
| `rescueWhatWasTyped()` | the *page* is going, which is a different problem |

**The hard-won part is the order.** A room is joined, and only then is an
editor bound to it. A binding makes the editor say whatever the `Y.Text` says
the moment it is made — so binding a document that has not arrived does not
show an empty file, it *makes* one, and the next store writes that over the
real content. `#carryInWhatWasTypedWhileJoining` is what saves the typing that
happened in between, and it carries it in as *edits* so everybody else's copy
merges them.

**`keepWhatWasTyped` and `rescueWhatWasTyped` look alike and are not.** The
first goes through the outbox, which promises eventual delivery — right
everywhere the page is still alive. The second does not, because the outbox
hashes and writes to IndexedDB before anything reaches the network, and a
document being torn down never comes back from those awaits.

## 3. `edits.ts` — who typed, and the failure with no symptom

Every editing surface has the same problem: its change event fires for the user
typing, a peer's keystroke arriving through the shared document, a formatter, a
chat edit, and the binding seeding the surface on attach. Focus is a poor way
to tell them apart.

**This package owns the signal that is sufficient**: a change that lands while
a Yjs transaction that is *not* this surface's own binding is in flight did not
come from this person. Public, stable Yjs API, and vendor-neutral — a textarea
bound with y-textarea has the same problem and the same answer available.

Monaco's `detailedReasons` — the only signal that *names* the gesture — is a
refinement and lives in `wsfs_python_suede`.

Which half is sufficient decides what breaks when the other goes, and the
asymmetry is why the split is where it is:

- lose the Monaco half → a vaguer `did`, and nothing else;
- lose the Yjs half → **a peer typing looks like this student typing, nobody is
  ever detected as stuck, and nothing fails.**

`tests/frontend/svelte/edits.test.ts` asserts the second directly, because
nothing else would notice.

## 4. The rest, by what you would go looking for

| Want to change… | Look at |
|---|---|
| the tree: rows, menu, drag and drop, upload | `FileTree.svelte` (big; the menu is near the bottom) |
| what one open tab looks like | `FileView.svelte` |
| the default editor | `Textarea.svelte` + `textarea.svelte.ts` |
| the left panel's chrome | `Explorer.svelte` |
| the dock | `Documents.svelte` |
| the version history dialog | `History.svelte` |
| what a non-text file shows | `Preview.svelte` |
| dark mode, tree themes | `appearance.svelte.ts`, `app.css` |
| text size | `textsize.svelte.ts`, `shell/TextSizeSlider.svelte` |
| the header above a workspace | `shell/` |
| the room, as a component watches it | `room.svelte.ts` |
| buttons, dialogs, inputs | `shadcn/ui/` (vendored; prefer not to edit) |

`room.svelte.ts` is worth a note: the *contracts* are core's
(`Provider`, `Enter`, `Host`, `Persist`), and what is here is the reactivity —
`Room` is the protocol with runes over the few facts a component renders. Runes
are a compiler feature, which is exactly why this file is in this package and
the contracts are in core's.

## 5. Three rules an editor must follow

Any implementation of `Editor` (see `editor.ts`), including one you write:

1. **Bind to the room's document, never one of your own.** A room outlives its
   providers, so a document the editor made is thrown away with the editor,
   taking everything typed during a network lapse.
2. **Report edits before a document is bound**, with `shared: false`. The
   person is still editing; their edits just are not going anywhere yet, and
   anything counting activity has to hear them.
3. **Never diff the file into the document.** Only the server carries text into
   a room. An editor that reads the file and types the difference in creates
   new characters, and the file ends up saying everything twice.

`TextareaBinding` follows all three in about 200 lines and is the thing to
measure a second implementation against.

It is written out rather than taken from `y-textarea` or similar, and the
reason is rule 3: a general-purpose binding owns its document and reconciles by
value, which is exactly what this system must not do. What a binding here has
to do is small — carry the element's changes into the room's `Y.Text` as
*edits*, and put the document back onto the element without moving the caret —
and `become` in core already solves the half that is easy to get wrong.

## 6. `app.css`, and the two ways it goes silently wrong

Tailwind emits a utility only if it finds the class name in a file it scanned,
and it scans neither published packages nor `node_modules` by default. **A
class that was never generated does not announce itself; it just does
nothing.**

Two `@source` lines guard against that, and both have already failed once:

- `@source "../../wsfs_*_suede/frontend"` — a glob, so this file names no
  package in particular. Four packages draw things and this is one of them;
  listing the other three here would be a stylesheet reaching upwards at the
  one boundary the import audit cannot see.
- `@source "../../node_modules/streamdown-svelte/dist"` — the markdown
  renderer names its utilities in its own `theme.js`. When this path was off by
  one directory, `pointer-events-auto` was dropped from the copy and download
  buttons on every code block, the `pointer-events-none` shell around them
  swallowed every click, and the buttons were drawn, lit, enabled and
  unreachable.

Both paths are relative to **this file**, so moving `app.css` breaks them. The
only thing that catches it is the browser suite.

## 7. Running it

```bash
npx vitest run tests/frontend/svelte    # the attribution rule; no DOM needed
./tools/typecheck.sh                    # svelte-check is the real gate here
cd samples/frontend && npm run test:browser -- --component FileTree --silence 300
```

Everything visual needs the browser suite. `samples/frontend/src/lib/*.test.svelte`
are the scenarios; `FileTree.test.svelte` also lives inside this package, next
to the component it drives.

## 8. Your first change

Add something to the file tree's context menu. `entryActions` in
`FileTree.svelte` is where the list is built, `rootActions` is the workspace's
own menu, and `FileTree.test.svelte` already asserts what each one offers — so
you will find out immediately whether you got it right.

**Read `entryActions` before you assume what a menu holds.** Three menus are
built from one list of actions and each one drops some: a read-only panel keeps
only `Download`, a spoken-for file loses `Rename` and `Delete`, and **a file
loses `New file` and `New folder`** — those two are offered on a directory and
on the root strip and nowhere else, because a menu opened on `main.py` that
offers "New folder" reads as a promise to put one *inside* it. That last rule
is the one people write a broken test against: six scenarios in the sample
suite asked a *file's* menu for "Add file", which is neither the right menu nor
the right label, and every one of them failed the first time the browser suite
ran against them. The labels are matched as strings, so a rename upstream turns
this into today's behaviour rather than an error — visible, and not a crash.

For something meatier: the shell currently lays out two panels and lets a
consumer add more. Making the *arrangement* configurable — the explorer on the
right, or a second dock — is a real feature that would live entirely in
`Workspace.svelte`'s `layOut`.
