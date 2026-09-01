/**
 * Where a new entry goes, and what to call it before anyone has.
 *
 * A placeholder name is never what the user is left with -- a draft is opened
 * for renaming the moment it exists -- but the tree still needs a path to put
 * the row at, and that path has to be free.
 */
import type { Path } from "./model.svelte";

type Kind = "file" | "folder";

/** A trailing separator is how the tree says "folder"; nothing else does. */
export const placeholder = { file: "untitled", folder: "untitled/" } as const;

export const parentOf = (path: Path): Path => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash < 0 ? "" : trimmed.slice(0, lastSlash + 1);
};

/** Where a new entry lands: inside a directory, and beside a file. */
export const holding = (item: { kind: "directory" | "file"; path: Path }): Path =>
  item.kind === "directory" ? item.path : parentOf(item.path);

/** Both spellings of a path collide, so a directory can never shadow a file. */
const taken = (has: (path: Path) => boolean, path: Path): boolean =>
  has(path) || has(path.endsWith("/") ? path.slice(0, -1) : `${path}/`);

const numbered = (path: Path, suffix: number): Path => {
  if (path.endsWith("/")) return `${path.slice(0, -1)}-${suffix}/`;
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/")
    ? `${path.slice(0, dot)}-${suffix}${path.slice(dot)}`
    : `${path}-${suffix}`;
};

export const vacant = (has: (path: Path) => boolean, path: Path): Path => {
  let suffix = 0;
  let candidate = path;
  while (taken(has, candidate)) candidate = numbered(path, ++suffix);
  return candidate;
};

export const draftPath = (
  has: (path: Path) => boolean,
  within: Path,
  kind: Kind,
): Path => vacant(has, `${within}${placeholder[kind]}`);
