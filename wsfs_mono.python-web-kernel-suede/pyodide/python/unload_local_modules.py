import sys
import importlib
from pathlib import PurePosixPath

def _module_paths(mod):
    """Return possible filesystem paths a module/package lives at."""
    spec = getattr(mod, "__spec__", None)
    out = set()

    # Normal modules/packages
    f = getattr(mod, "__file__", None)
    if f:
        out.add(str(PurePosixPath(f)))

    # importlib metadata
    if spec is not None:
        origin = getattr(spec, "origin", None)
        if origin and origin not in ("built-in", "frozen"):
            out.add(str(PurePosixPath(origin)))

        # Namespace packages / packages: list of directories
        locs = getattr(spec, "submodule_search_locations", None)
        if locs:
            for p in locs:
                out.add(str(PurePosixPath(p)))

    return out

def unload_local_modules(
    local_roots=("/home/pyodide",),
    external_roots=("/lib/python", "/usr/lib", "/usr/local/lib"),
    extra_keep=(),
):
    """
    Remove modules considered 'local' from sys.modules.
    Heuristic: module path is under a local_root and NOT under any external_root.
    """
    local_roots = tuple(str(PurePosixPath(p)) for p in local_roots)
    external_roots = tuple(str(PurePosixPath(p)) for p in external_roots)
    keep = set(extra_keep)

    to_delete = []
    for name, mod in list(sys.modules.items()):
        if mod is None or name in keep:
            continue

        paths = _module_paths(mod)
        if not paths:
            continue  # built-in/frozen/no-file modules -> skip

        # "local" if any path is inside local_roots, and none are inside external_roots
        is_under_local = any(any(p.startswith(r.rstrip("/") + "/") or p == r for r in local_roots) for p in paths)
        is_under_external = any(any(p.startswith(r.rstrip("/") + "/") or p == r for r in external_roots) for p in paths)

        if is_under_local and not is_under_external:
            to_delete.append(name)

    for name in to_delete:
        sys.modules.pop(name, None)

    importlib.invalidate_caches()
    return to_delete