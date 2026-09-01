> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# wsfs-python-suede

**Making Python work inside a wsfs workspace.** The kernel's view of the
filesystem, running a file and recording what came out, and a Monaco editing
surface with language services.

**This is the only repository in the family that knows Monaco or pyodide
exists.** After the split, `grep -rn "monaco\|pyodide"` across every other one
returns nothing — that single check is what says the extraction worked, and the
import audit fails the build if it stops being true.

## Svelte-bound, deliberately

`python-monaco-suede` ships Svelte bindings and no others, and this package
inherits that rather than choosing it. In future it becomes that library's
responsibility to ship bindings for other UI libraries.

So: everything here that is **not** Svelte-bound is kept free of it — the
kernel's filesystem adapter, the editor's file provider, the edit refinement —
so that it survives that changing. Only `MonacoSurface.svelte` and
`Runner.svelte` are components.

## No backend, and the reason is worth re-deriving

Everything Python-related on the server is language-agnostic by design:
`ExecutionRow.outputs` is opaque JSONB precisely so that a server parsing it
would have to change every time a kernel learned a new kind of output, and
`/executions` says nothing about Python.

Revisit if a server-side runner, server-resolved packages, or hosted language
services arrive. Any of those gets a `backend/` here that mounts over core the
way `wsfs_assistant_suede` does — taking `Backend` + `Authorize`, never
reaching into `service`.

## The two things that are easy to break

**Everything the kernel asks is answered synchronously**, from state the client
already holds. Python blocks while these are answered, so a change that makes
any of them await a network request wedges the kernel — and the symptom is a
program that never finishes rather than an error.

**`FileOverride` is how the open buffer wins.** Core deliberately does not
decide who else to trust, because an editor holding a buffer somebody is typing
into knows something the filesystem does not. This package is that consumer, and
the override is what makes *what Python reads is what the editor shows* true
rather than merely intended. The type is core's; the implementation is here.

## Testing

See [TESTING.md](./TESTING.md).
