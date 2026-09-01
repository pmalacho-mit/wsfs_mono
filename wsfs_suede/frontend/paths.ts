/**
 * Paths, over a tree that has none.
 *
 * The wire is entirely id-addressed: an entry knows its name and its parent's
 * id, and nothing anywhere is a path. Both things that consume this client --
 * the editor's file provider and the kernel's filesystem -- are entirely
 * path-addressed. This is the seam between them, and it is derived from the
 * effective view, so a queued rename moves a file's path before the server has
 * answered.
 */
import { isLive, type Id, type Metadata } from "./contract";
import type { View } from "./effective";

export type Path = string;

export const SEPARATOR = "/";

export const normalize = (path: Path) =>
  path.split(SEPARATOR).filter(Boolean).join(SEPARATOR);

export const parent = (path: Path) =>
  normalize(path).split(SEPARATOR).slice(0, -1).join(SEPARATOR);

export const base = (path: Path) =>
  normalize(path).split(SEPARATOR).pop() ?? "";

export const join = (...parts: Path[]) => normalize(parts.join(SEPARATOR));

/**
 * A reachable entry is one every step of whose ancestry is live. Deleting a
 * folder tombstones the folder alone, so its contents keep their rows and
 * lose their path -- which is what a user means by deleting a folder.
 */
const walked = (view: View, entry: Metadata): Path | undefined => {
  const names: string[] = [];
  const seen = new Set<Id>();
  let at: Metadata | undefined = entry;
  while (at !== undefined && !seen.has(at.id)) {
    if (!isLive(at)) return undefined;
    seen.add(at.id);
    names.unshift(at.name);
    at = at.parent == null ? undefined : view.get(at.parent);
    if (at === undefined && names.length < seen.size) return undefined;
  }
  return names.join(SEPARATOR);
};

export type Index = {
  of: (id: Id) => Path | undefined;
  at: (path: Path) => Metadata | undefined;
  under: (path: Path) => Metadata[];
  paths: () => Path[];
};

/**
 * Built in one pass over the view rather than walked per lookup, because both
 * consumers ask for every path at once and then ask for one at a time.
 */
export const index = (view: View): Index => {
  const byId = new Map<Id, Path>();
  const byPath = new Map<Path, Metadata>();

  for (const entry of view.values()) {
    const path = walked(view, entry);
    if (path === undefined) continue;
    byId.set(entry.id, path);
    byPath.set(path, entry);
  }

  const childrenOf = (path: Path) => {
    const holder = byPath.get(normalize(path));
    const parentId = path === "" ? null : (holder?.id ?? undefined);
    if (parentId === undefined) return [];
    return [...view.values()].filter(
      (entry) => isLive(entry) && (entry.parent ?? null) === parentId,
    );
  };

  return {
    of: (id) => byId.get(id),
    at: (path) => byPath.get(normalize(path)),
    under: childrenOf,
    paths: () => [...byPath.keys()],
  };
};
