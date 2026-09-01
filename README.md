# wsfs_mono

The five wsfs packages, developed in one tree.

| Package | Ships | Depends on |
|---|---|---|
| [wsfs_core_suede](./wsfs_core_suede) | `backend/` + a client library | `sqlmodel_utils_suede` |
| [wsfs_svelte_suede](./wsfs_svelte_suede) | `frontend/` — the UI | core, dockview, pierre-trees, with-events |
| [wsfs_python_suede](./wsfs_python_suede) | `frontend/` — Monaco and the kernel | core, svelte, python-monaco, python-web-kernel |
| [wsfs_assistant_suede](./wsfs_assistant_suede) | `backend/` + `frontend/` | core, svelte, `pytutor_llms_suede` |
| [wsfs_pytutor_suede](./wsfs_pytutor_suede) | `backend/` + `frontend/` | assistant, python, svelte, core |

Dependencies point **down** that list and never up. Core does not know an
assistant exists; svelte does not know Python does. An upward import is a
missing seam in core, not a reason to break the rule — and
`tools/audit-imports.py` fails the build over one.

Each package has a `README.md` for what it is and a `TESTING.md` for how to set
its suite up on its own `main` branch.

## Every dependency is root-owned

There are no `<consumer>__<dependency>` edge entries in this tree, and that is
deliberate. Suede's default names a dependency after whoever asked for it, so
one folder ends up with several paths — and both toolchains read a path as an
identity:

- **TypeScript** treats two paths to one file as **two nominal types**. The
  symptom is `Type 'TextSize' is not assignable to type 'TextSize'`.
- **Python** builds **two module objects**, with two SQLModel registries and two
  copies of every enum.

So each dependency is installed once, under its own name, and every package
imports it that way. On a package's own `main` branch, install with
`--root-owned`.

## Running everything

```bash
./tests/run.sh                  # the backends, against a throwaway postgres
npx vitest run                  # the clients' logic, no network
./tools/typecheck.sh            # the packages' non-component types
python3 tools/audit-imports.py  # the boundaries
cd samples/frontend && npm run check   # svelte-check, the real gate for components
```

`tests/run.sh` runs with **no `LIVEBLOCKS_SECRET_KEY`**, against core's
in-process collaboration service. That is the headline check of the whole split:
rooms are filesystem behaviour, so their tests must not need a vendor.

Two `svelte-check` errors are expected and are the vendored dependencies', not
these packages': `pierre-trees`'s `Action` has drifted from the `note` /
`isNote` the file tree uses, and `@streamdown-svelte/math` is a subpackage
nobody has installed.

## The sample host

`samples/backend/app.py` is a host application of the kind wsfs is mounted into
— its own users, its own workspaces, its own idea of who may reach one. It
mounts all three routers on one prefix and builds **one** tutor for the two
that need a model, which is the arrangement the split is for. The suites drive
wsfs through it rather than through a fixture of their own, so the integration
path is the one under test.

`samples/frontend` is a SvelteKit app that mounts the components, and where the
browser suite lives.

## What is still here from before

- `wsfs_suede/` — the original single package, left in place and untouched.
  `reference/` holds its full `main` branch, including how it was tested.
- The `wsfs_suede.*` and `wsfs_suede__*` entries at the root are now symlinks
  to the root-owned folders, so that package still resolves.

Both go when the five packages are published.
