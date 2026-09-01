/**
 * The tree resolves a drop target from the ROW under the pointer: a folder row
 * is that folder, a file row is the folder holding it, and a row that sits at
 * the top level is the root. Empty space is no row at all, so a drop there
 * resolves to nothing and the drag is simply abandoned -- which leaves a tree
 * whose only way out of a directory is landing on a top-level FILE, and trees
 * that have none, or none on screen, with no way out at all.
 *
 * This is the missing half: below the last row, and on the header, the tree's
 * own surface means the root. Everything else -- what a drag carries, what
 * `canDrag` refuses, the events a drop announces -- is the tree's, unchanged.
 */

import type {
  FileTreeBatchOperation,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropTarget,
} from "@pierre/trees";
import type { Unsubscribe } from "./events";

/** The only operation a drop is ever made of. */
type Move = Extract<FileTreeBatchOperation, { type: "move" }>;

/** What the tree calls a drop that landed inside no directory. */
const ROOT: FileTreeDropTarget = {
  directoryPath: null,
  flattenedSegmentPath: null,
  hoveredPath: null,
  kind: "root",
};

/** The tree's own selector for a row; anything else the pointer is over is not one. */
const ROW = '[data-type="item"]';

/** Marks the host while a drop on it would land at the root. */
const MARKER = "data-root-drop-target";

/** `"src/lib/utils.ts"` → `"utils.ts"`, `"src/lib/"` → `"lib/"`. */
export const basename = (path: string): string => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return path.endsWith("/") ? `${name}/` : name;
};

/**
 * What a drag actually carries. A selected directory brings its contents with
 * it, so anything already inside one is not moved a second time.
 */
export const carried = (paths: readonly string[]): readonly string[] => {
  const directories = paths.filter((path) => path.endsWith("/"));
  return [...new Set(paths)].filter(
    (path) =>
      !directories.some((directory) => path !== directory && path.startsWith(directory)),
  );
};

/** The tree, narrowed to what a drop on the root needs of it. */
export type Subject = {
  /** The paths a drag that has just started is carrying. */
  dragging(): readonly string[];
  /** Whether the root is already using a name, under either kind. */
  taken(name: string): boolean;
  move(from: string, to: string): void;
  batch(operations: readonly FileTreeBatchOperation[]): void;
};

/**
 * A drop's moves, or `null` where there is nothing to do -- every entry
 * dragged out of the same directory it would land in.
 */
const plan = (draggedPaths: readonly string[]): Move[] | null => {
  const operations = draggedPaths
    .map((from): Move => ({ type: "move", from, to: basename(from) }))
    .filter((operation) => operation.from !== operation.to);
  return operations.length === 0 ? null : operations;
};

/**
 * The name a move would land on that the root cannot give it -- one another
 * entry already answers to, or one two dragged entries both want.
 *
 * The tree rehearses a multi-entry drop against a throwaway store so a batch
 * that cannot finish never starts; that store is not public, so this asks the
 * question the rehearsal was there to answer instead.
 */
const refused = (
  operations: readonly Move[],
  taken: (name: string) => boolean,
): string | null => {
  const wanted = new Set<string>();
  for (const operation of operations) {
    const name = operation.to.endsWith("/") ? operation.to.slice(0, -1) : operation.to;
    if (wanted.has(name) || taken(name)) return operation.to;
    wanted.add(name);
  }
  return null;
};

/**
 * Makes the tree's empty space a drop target that means the root, and returns
 * the way to take it back off again.
 *
 * The tree's own handlers still run first and still resolve nothing there, so
 * nothing is being overridden -- this only picks up the drop the tree let fall.
 */
export const rootDropsIn = (
  container: HTMLElement,
  config: FileTreeDragAndDropConfig,
  subject: Subject,
): Unsubscribe => {
  /** The drag in flight, if it started on one of this tree's rows. */
  let dragging: readonly string[] | null = null;

  /** The row under the pointer, if the pointer is over one at all. */
  const onRow = (event: DragEvent): boolean =>
    event
      .composedPath()
      .some((node) => node instanceof Element && node.matches(ROW));

  const mark = (active: boolean): void => {
    if (active) container.setAttribute(MARKER, "true");
    else container.removeAttribute(MARKER);
  };

  /** Asked on every move of the pointer, the way the tree asks it. */
  const allowed = (draggedPaths: readonly string[]): boolean =>
    config.canDrop?.({ draggedPaths, target: ROOT }) !== false;

  const drop = (draggedPaths: readonly string[]): void => {
    const context: FileTreeDropContext = { draggedPaths, target: ROOT };
    if (!allowed(draggedPaths)) return;

    const operations = plan(draggedPaths);
    if (operations === null) return;

    const clash = refused(operations, subject.taken);
    if (clash !== null)
      return config.onDropError?.(`Destination already exists: "${clash}"`, context);

    try {
      const [only] = operations;
      if (operations.length === 1 && only !== undefined)
        subject.move(only.from, only.to);
      else subject.batch(operations);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return config.onDropError?.(reason, context);
    }

    config.onDropComplete?.({
      ...context,
      operation: operations.length === 1 ? "move" : "batch",
    });
  };

  // The tree's own row handler has already run by the time this does, so a
  // drag it refused arrives prevented, and one it allowed arrives with the
  // selection it decided to carry.
  const started = (event: DragEvent): void => {
    dragging = null;
    if (event.defaultPrevented || !onRow(event)) return;
    const paths = carried(subject.dragging());
    if (paths.length > 0) dragging = paths;
  };

  const over = (event: DragEvent): void => {
    if (dragging === null) return;
    if (onRow(event) || !allowed(dragging)) return mark(false);
    mark(true);
    // Without this the browser refuses the drop before anyone is asked.
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
  };

  // `relatedTarget` is retargeted to the host for anything inside the tree's
  // shadow root, so this only fires for a pointer that has actually left.
  const left = (event: DragEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && container.contains(next)) return;
    mark(false);
  };

  const dropped = (event: DragEvent): void => {
    const paths = dragging;
    dragging = null;
    mark(false);
    if (paths === null || onRow(event)) return;
    event.preventDefault();
    drop(paths);
  };

  const ended = (): void => {
    dragging = null;
    mark(false);
  };

  container.addEventListener("dragstart", started);
  container.addEventListener("dragover", over);
  container.addEventListener("dragleave", left);
  container.addEventListener("drop", dropped);
  container.addEventListener("dragend", ended);

  return () => {
    container.removeEventListener("dragstart", started);
    container.removeEventListener("dragover", over);
    container.removeEventListener("dragleave", left);
    container.removeEventListener("drop", dropped);
    container.removeEventListener("dragend", ended);
    mark(false);
  };
};
