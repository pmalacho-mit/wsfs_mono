> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# wsfs-svelte-suede

**A Svelte user interface for a wsfs workspace.** File tree, file view,
history, layout shell, and a collaborative text-editing surface. Frontend only:
if a component needs something from a server it needs it from core's client
object, not from a route this package invented.

**It knows nothing about Python.** That is the boundary this package is
organised around, and it is why the pieces that used to be welded to Monaco are
now holes.

## The shell, and the three holes in it

`Workspace.svelte` lays out an explorer on the left and a dock of open files
beside it. Everything it must not know about arrives through one of three:

| Hole | Shape | Filled by |
|---|---|---|
| `editorFor` | `(path) => Snippet<[OpenText, number]> \| undefined` | Monaco, in `wsfs_python_suede` |
| `events` | `WorkspaceEvents` | the stuck detector, in `wsfs_pytutor_suede` |
| `onReady` | `(shell: Shell) => void` | the chat panel, in `wsfs_assistant_suede` |

A path `editorFor` has no answer for gets this package's own textarea, so
`<Workspace {workspace} {entering} />` on its own is a working workspace of
plain documents. `onReady` hands back the dockview grid and the panel
references to position against, which is how a consumer puts its own panel
beside these.

## What an editor is

`frontend/editor.ts`, and it is short on purpose — every member exists because
the shell has to be able to keep what somebody typed when there is no shared
document to keep it in. Three rules, each of which has cost somebody a file:

1. **Bind to the room's document, never one of your own.** A room outlives its
   providers, so a document the editor created is thrown away with the editor,
   taking everything typed during a network lapse.
2. **Report edits with `shared: false` before there is a document.** The person
   is still editing; their edits just are not going anywhere yet, and anything
   counting activity has to hear them.
3. **Never diff the file into the document.** Only the server carries text into
   a room. An editor that reads the file and types the difference in creates
   new characters, and the file ends up saying everything twice.

`TextareaBinding` is this package's implementation: a plain text area bound to
the room's `Y.Text`, deliberately the least capable thing that is correct.

## Who edited, and how it is decided

`frontend/edits.ts` owns the **vendor-neutral** half of edit attribution: a
change that lands while a Yjs transaction that is not this editor's binding is
in flight did not come from the person at this keyboard. Public, stable Yjs
API, and sufficient on its own.

Monaco's `detailedReasons` — the only signal that *names* the gesture — is a
refinement and lives in `wsfs_python_suede`. Which half is sufficient decides
what breaks when the other goes, and the asymmetry is the whole reason the
split is where it is. See `edits.ts` and [TESTING.md](./TESTING.md) §3.

## Reading it

[GUIDE.md](./GUIDE.md) walks the files in the order they make sense in.

## Testing

See [TESTING.md](./TESTING.md).

**Setting the suite up in this repo's own `main` branch?**
[HANDOFF.md](./HANDOFF.md) is written for that: what to port, what needs a
consumer app, and the traps that cost time the first time round.
