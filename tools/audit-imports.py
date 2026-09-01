#!/usr/bin/env python3
"""The import audit: every BOUNDARY in the port guides, as something that runs.

The inventories in those guides go stale. This does not: it does not care what
a file is called, only what it reaches for. Run it in CI in every repo.

A package may import what its row allows and nothing else. Where an exception
is genuinely intended -- core's one Liveblocks adapter -- it is named here
beside the rule, so that a second one has to be argued for rather than added.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SOURCE = (".py", ".ts", ".svelte", ".mts", ".cts")


@dataclass(frozen=True)
class Rule:
    """One package, and what it may not reach for."""

    package: str
    forbidden: tuple[str, ...]
    allowed_in: tuple[str, ...] = field(default=())
    """Paths, relative to the package, where the forbidden names are the point.

    Core's Liveblocks adapter is the whole list, and it is a list rather than a
    boolean so that adding to it is a visible decision.
    """


UI = ("svelte", "dockview", "@pierre/", "bits-ui", "tailwind", "shadcn")
MODELS = ("pytutor_llms", "anthropic", '"ai"', "openai")
PYTHON_STACK = ("pyodide", "monaco", "basedpyright", "python-web-kernel", "python-monaco")
VENDOR_CRDT = ("@liveblocks/", "liveblocks")

RULES = (
    Rule(
        "wsfs_core_suede",
        forbidden=UI + MODELS + PYTHON_STACK + VENDOR_CRDT
        + ("wsfs_svelte_suede", "wsfs_assistant_suede", "wsfs_pytutor_suede",
           "wsfs_python_suede"),
        allowed_in=(
            # The two vendor adapters this package ships, and the two places
            # that name them. Core owns the protocol and ships more than one
            # implementation of it; what it must not do is let a vendor reach
            # any further in than these.
            "backend/collaboration/__init__.py",
            "backend/collaboration/liveblocks.py",
            "frontend/collaboration/liveblocks.ts",
        ),
    ),
    Rule(
        "wsfs_svelte_suede",
        forbidden=MODELS + PYTHON_STACK
        + ("wsfs_assistant_suede", "wsfs_pytutor_suede", "wsfs_python_suede"),
    ),
    Rule(
        "wsfs_python_suede",
        forbidden=MODELS + ("wsfs_assistant_suede", "wsfs_pytutor_suede"),
    ),
    Rule(
        "wsfs_assistant_suede",
        forbidden=PYTHON_STACK + ("wsfs_pytutor_suede", "wsfs_python_suede"),
        allowed_in=("backend/llm.py",),
    ),
    Rule(
        "wsfs_pytutor_suede",
        forbidden=MODELS,
    ),
)

IMPORT = re.compile(
    r"""^\s*(?:from\s+(?P<from>\S+)\s+import|import\s+(?P<import>\S+))""",
    re.MULTILINE,
)
FROM_TS = re.compile(r"""(?:from|import)\s*\(?\s*["'](?P<what>[^"']+)["']""")


def reached(text: str) -> set[str]:
    """Every module named by an import in this file, however it is spelled."""
    named = {
        match.group("from") or match.group("import") for match in IMPORT.finditer(text)
    }
    named |= {match.group("what") for match in FROM_TS.finditer(text)}
    return {one for one in named if one}


def sources(package: Path):
    for path in sorted(package.rglob("*")):
        if path.is_file() and path.suffix in SOURCE and ".suede" not in path.parts:
            yield path


def offences(rule: Rule) -> list[str]:
    package = ROOT / rule.package
    if not package.is_dir():
        return [f"{rule.package}: no such package"]
    found: list[str] = []
    for path in sources(package):
        where = path.relative_to(package).as_posix()
        if where in rule.allowed_in:
            continue
        for module in reached(path.read_text(errors="ignore")):
            for banned in rule.forbidden:
                if banned in module:
                    found.append(f"{rule.package}/{where}: imports {module!r}")
    return found


def main() -> int:
    failures = [line for rule in RULES for line in offences(rule)]
    for line in failures:
        print(line)
    print(f"\n{len(failures)} boundary violation(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
