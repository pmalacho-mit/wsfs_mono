"""Finds the external packages a run will need before it runs.

`pyodide.code.find_imports` plus `loadPackagesFromImports` only sees the imports
written in the source it is handed. A run whose entry point imports a local
module, which imports another local module, which imports pandas, would reach
that import at runtime with nothing installed. This walks the local modules
first and reports what they need, along with the directories to put on sys.path.

Being a walker over local files, it has to be kept working against the Pyodide
release in use.
"""

import pyodide.code
import os
import sys

try:
    import micropip
except ImportError:  # no package index is reachable; only the stdlib is here
    micropip = None


def find_external_imports_of_local_modules(
    source: str,
    path: str,
    root: str = "/home/pyodide",
    recursive=True,
):
    external_imports: set[str] = set()
    discovered_dirs: set[str] = set()
    visited: set[str] = set()
    stdlib = set(sys.stdlib_module_names)
    installed = {pkg.name for pkg in micropip.list().values()} if micropip else set()

    root = os.path.realpath(root)

    def is_under_root(p: str) -> bool:
        return os.path.realpath(p).startswith(root)

    base_dir = os.path.dirname(path)
    if is_under_root(base_dir):
        discovered_dirs.add(base_dir)
    discovered_dirs.add(root)

    for dirpath, dirnames, filenames in os.walk(root):
        if "__pycache__" in dirpath:
            continue
        if any(f.endswith(".py") for f in filenames):
            rp = os.path.realpath(dirpath)
            if is_under_root(rp):
                discovered_dirs.add(rp)

    search_paths = list(discovered_dirs)

    def is_installed(name: str) -> bool:
        return (
            name in installed
            or name.replace("_", "-") in installed
            or name.replace("-", "_") in installed
        )

    def resolve_local_module(name: str, context_dir: str):
        parts = name.split(".")
        dirs_to_check = [context_dir] if is_under_root(context_dir) else []
        dirs_to_check += [p for p in search_paths if p != context_dir]

        for d in dirs_to_check:
            result_path, result_dir = _resolve_in_dir(parts, d)
            if result_path and is_under_root(result_dir):
                discovered_dirs.add(result_dir)
                return result_path, result_dir

        return None, None

    def _resolve_in_dir(parts: list[str], d: str):
        current = d
        for i, part in enumerate(parts):
            is_last = i == len(parts) - 1
            if is_last:
                candidate = os.path.join(current, part + ".py")
                if os.path.isfile(candidate):
                    return candidate, current
                candidate_pkg = os.path.join(current, part, "__init__.py")
                if os.path.isfile(candidate_pkg):
                    return candidate_pkg, os.path.join(current, part)
            else:
                next_dir = os.path.join(current, part)
                if os.path.isdir(next_dir):
                    current = next_dir
                else:
                    return None, None
        return None, None

    def visit_local_module(module_path: str, module_base_dir: str):
        if module_path in visited:
            return
        visited.add(module_path)
        if is_under_root(module_base_dir):
            discovered_dirs.add(module_base_dir)
        try:
            with open(module_path) as f:
                src = f.read()
        except Exception:
            return

        for imp in pyodide.code.find_imports(src):
            top = imp.split(".")[0]
            next_module_path, next_base_dir = resolve_local_module(imp, module_base_dir)
            if next_module_path:
                if recursive:
                    visit_local_module(next_module_path, next_base_dir)
                continue
            if top not in stdlib and not is_installed(top):
                external_imports.add(top)

    for imp in pyodide.code.find_imports(source):
        top = imp.split(".")[0]
        module_path, module_base_dir = resolve_local_module(imp, base_dir)
        if module_path:
            visit_local_module(module_path, module_base_dir)
        else:
            if top not in stdlib and not is_installed(top):
                external_imports.add(top)

    return sorted(external_imports), sorted(discovered_dirs)
    external_imports: set[str] = set()
    discovered_dirs: set[str] = set()  # NEW: directories containing local modules
    visited: set[str] = set()
    stdlib = set(sys.stdlib_module_names)
    installed = {pkg.name for pkg in micropip.list().values()} if micropip else set()

    base_dir = os.path.dirname(path)
    discovered_dirs.add(base_dir)
    discovered_dirs.add(root)

    # Also pre-discover all subdirectories of root that contain .py files
    for dirpath, dirnames, filenames in os.walk(root):
        if "__pycache__" in dirpath:
            continue
        if any(f.endswith(".py") for f in filenames):
            discovered_dirs.add(os.path.realpath(dirpath))

    search_paths = list(discovered_dirs)

    def is_installed(name: str) -> bool:
        return (
            name in installed
            or name.replace("_", "-") in installed
            or name.replace("-", "_") in installed
        )

    def resolve_local_module(name: str, context_dir: str):
        parts = name.split(".")
        dirs_to_check = [context_dir]
        dirs_to_check += [p for p in search_paths if p != context_dir]

        for d in dirs_to_check:
            result_path, result_dir = _resolve_in_dir(parts, d)
            if result_path:
                discovered_dirs.add(result_dir)
                return result_path, result_dir

        return None, None

    def _resolve_in_dir(parts: list[str], d: str):
        current = d
        for i, part in enumerate(parts):
            is_last = i == len(parts) - 1
            if is_last:
                candidate = os.path.join(current, part + ".py")
                if os.path.isfile(candidate):
                    return candidate, current
                candidate_pkg = os.path.join(current, part, "__init__.py")
                if os.path.isfile(candidate_pkg):
                    return candidate_pkg, os.path.join(current, part)
            else:
                next_dir = os.path.join(current, part)
                if os.path.isdir(next_dir):
                    current = next_dir
                else:
                    return None, None
        return None, None

    def visit_local_module(module_path: str, module_base_dir: str):
        if module_path in visited:
            return
        visited.add(module_path)
        discovered_dirs.add(module_base_dir)
        try:
            with open(module_path) as f:
                src = f.read()
        except Exception:
            return

        for imp in pyodide.code.find_imports(src):
            top = imp.split(".")[0]
            next_module_path, next_base_dir = resolve_local_module(imp, module_base_dir)
            if next_module_path:
                if recursive:
                    visit_local_module(next_module_path, next_base_dir)
                continue
            if top not in stdlib and not is_installed(top):
                external_imports.add(top)

    for imp in pyodide.code.find_imports(source):
        top = imp.split(".")[0]
        module_path, module_base_dir = resolve_local_module(imp, base_dir)
        if module_path:
            visit_local_module(module_path, module_base_dir)
        else:
            if top not in stdlib and not is_installed(top):
                external_imports.add(top)

    return sorted(external_imports), sorted(discovered_dirs)