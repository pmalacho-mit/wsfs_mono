"""Regenerate the client's view of the backend contract.

    python3 backend/wsfs_suede/frontend/generate.py

Writes `openapi.generated.json` and `schema.generated.d.ts` beside this file.
Both are outputs: the `.generated` in their names is there so that a hand edit
announces itself as something the next run will discard.

The router has a schema only once a host has mounted it, so this mounts one --
a stub, declared below, that exists for no other reason. The document is a
function of the declared shapes, so the stub's user and workspace tables never
appear in it and its dependency is never called. Nothing is served, nothing
connects to a database, and nothing here is meant to be imported.

WHERE THIS PACKAGE IS IMPORTED FROM is worked out rather than written down,
and that is not cleverness -- it is the only thing that can be right in a file
that is COPIED into a host repo verbatim. This package is vendored under some
directory the host chose, so the dotted path to it is a fact about the host,
not about this package, and the last hardcoded one (`wsfs_suede.release.*`)
stopped resolving the moment the layout it named went away. Everything below
is derived from `__file__`, so the next host to vendor this needs to change
nothing, and so does the next rearrangement.

The one thing it does assume is the thing the backend already requires: this
package sits INSIDE a host package, beside `wsfs_suede__sqlmodel_utils_suede`.
`backend/main.py` reaches that sibling with `from ...` -- three levels up --
so a layout where this derivation is wrong is one the backend cannot import
under either way.
"""

from __future__ import annotations

import importlib
import json
import pathlib
import subprocess
import sys
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    from fastapi import FastAPI

HERE = pathlib.Path(__file__).resolve().parent
PACKAGE = HERE.parent
"""This package -- the `wsfs_suede` directory holding `backend/` and this."""
HOST = PACKAGE.parent
"""The host package it is vendored into. A package, not just a directory:
`backend/main.py`'s `from ...wsfs_suede__sqlmodel_utils_suede` resolves here."""
ROOT = HOST.parent
"""What has to be on `sys.path` for `HOST` to be importable as a package, and
the directory `npx` is run from -- the host's `node_modules` is there."""

DOCUMENT = HERE / "openapi.generated.json"
TYPES = HERE / "schema.generated.d.ts"

sys.path.insert(0, str(ROOT))

BACKEND = f"{HOST.name}.{PACKAGE.name}.backend"
"""The dotted path to the backend, as this host spells it."""


def _from_backend(module: str, *names: str) -> tuple[Any, ...]:
    """`from {BACKEND}.module import *names`, with the prefix worked out.

    `importlib` rather than an import statement because the prefix is not
    known until run time -- see the module docstring. Only the three names
    this actually CALLS come through here; everything the stub merely stands
    in for is `_absent`, which needs no class to be None.
    """
    imported = importlib.import_module(f"{BACKEND}.{module}")
    return tuple(getattr(imported, name) for name in names)


_absent: Any = None
"""What the stub is handed where a running host would hand a real thing.

`Any`, so it satisfies every parameter it is passed to without importing the
class it stands in for. Each one is commented at the call site with why it is
never reached.
"""


def _stub() -> "FastAPI":
    from fastapi import FastAPI

    (Backend, create_router) = _from_backend("main", "Backend", "create_router")
    (build_models,) = _from_backend("models", "build_models")

    async def never_asked() -> UUID:
        raise NotImplementedError("a schema is not a request")

    app = FastAPI(title="wsfs schema stub")
    app.include_router(
        create_router(
            backend=Backend.over(
                build_models(user_table="users", workspace_table="workspaces"),
                # Neither the database nor the blob store is reached:
                # describing an endpoint never runs it, and requiring a
                # database driver to emit a type file would be a tax on every
                # consumer who only wants the types.
                _absent,
                _absent,
                heartbeat_seconds=15.0,
                grace_seconds=30.0,
                max_blob_bytes=0,
                # Nor this: the collaboration server is reached when a room is
                # filled, and describing an endpoint never fills one.
                liveblocks=_absent,
                # Nor this: a schema says what an answer looks like, and
                # describing that never asks anybody for one.
                tutor=_absent,
            ),
            authorize=never_asked,
        ).router
    )
    return app


def typed(document: pathlib.Path, into: pathlib.Path) -> None:
    _ = subprocess.run(
        ["npx", "--yes", "openapi-typescript@7", str(document), "-o", str(into)],
        check=True,
        cwd=ROOT,
    )


def main() -> None:
    _ = DOCUMENT.write_text(json.dumps(_stub().openapi(), indent=2) + "\n")
    typed(DOCUMENT, TYPES)
    print(f"wrote {DOCUMENT.name} and {TYPES.name}")


if __name__ == "__main__":
    main()
