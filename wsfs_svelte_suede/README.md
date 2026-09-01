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

## The three extension points

| Hole | Filled by | Carries |
|---|---|---|
| `surfaceFor` | `wsfs_python_suede` | Monaco for `.py` |
| `beneath` / `above` on `FileView` | python, pytutor | a terminal, a problem statement |
| `Edits` | `wsfs_pytutor_suede`, through python | who is typing, and what |

## What an editing surface is

`frontend/surface.ts`, and it is short on purpose — every member exists because
something in a file view asks it. Three rules, each of which has cost somebody a
file:

1. **Bind to the room's document, never one of your own.** A room outlives its
   providers, so a document the surface created is thrown away with the surface,
   taking everything typed during a network lapse.
2. **Report edits with `shared: false` before there is a document.** The person
   is still editing; their edits just are not going anywhere yet, and anything
   counting activity has to hear them.
3. **Never diff the file into the document.** Only the server carries text into
   a room. A surface that reads the file and types the difference in creates new
   characters, and the file ends up saying everything twice.

`TextareaSurface` is this package's implementation: a plain text area bound to
the room's `Y.Text`, deliberately the least capable thing that is correct.

## Who edited, and how it is decided

`frontend/edits.ts` owns the **vendor-neutral** half of edit attribution: a
change that lands while a Yjs transaction that is not this surface's binding is
in flight did not come from the person at this keyboard. Public, stable Yjs
API, and sufficient on its own.

Monaco's `detailedReasons` — the only signal that *names* the gesture — is a
refinement and lives in `wsfs_python_suede`. Which half is sufficient decides
what breaks when the other goes, and the asymmetry is the whole reason the
split is where it is. See `edits.ts` and [TESTING.md](./TESTING.md) §3.

## Testing

See [TESTING.md](./TESTING.md), including §7 on the application shell that has
not yet come back up into this package.
