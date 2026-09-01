import {
  FILE_TREE_TAG_NAME,
  FileTree,
  type FileTreeBatchOperation,
  type FileTreeDragAndDropConfig,
  type FileTreeGitStatusPatch,
  type FileTreeIcons,
  type FileTreeItemHandle,
  type FileTreeMoveOptions,
  type FileTreeMutationEvent,
  type FileTreeRemoveOptions,
  type FileTreeRenderProps,
  type FileTreeResetOptions,
  type FileTreeResetPreparedOptions,
  type FileTreeScrollToPathOptions,
  type FileTreeVisibleRow,
  type GitStatusEntry,
} from "@pierre/trees";
import {
  Emitter,
  announceMutation,
  type Events,
  type Handlers,
  type Unsubscribe,
} from "./events";
import { rootDropsIn, type Subject } from "./dropping";
import { draftPath } from "./naming";
import { announcing, dropsOnRoot, type Options } from "./options";
import { Snapshot } from "./snapshot.svelte";

export type Path = string;

/**
 * A new entry, between existing and being named.
 *
 * The tree can hold a row nothing outside it knows about, and that is the
 * whole point: a consumer that mirrors the tree somewhere real should hear
 * about a new file ONCE, under the name the user chose -- not about
 * `untitled`, and then about a rename it has to chase.
 */
type Draft = {
  path: Path;
  /** Why it will never become an entry, once that is known. */
  refused?: string;
  /** Escape, rather than a name that could not be used: nothing to report. */
  abandoned?: boolean;
};

/**
 * The input the tree draws over the row it is renaming, wherever it is.
 *
 * The tree renders into a shadow root -- often the container's OWN, since the
 * container is usually the custom element itself -- so the search has to start
 * there rather than with the light-DOM children, of which there are none.
 */
const renameInputIn = (root: ParentNode): HTMLInputElement | null => {
  const own = (root as Element).shadowRoot;
  const inside = own === null || own === undefined ? null : renameInputIn(own);
  if (inside) return inside;

  const here = root.querySelector<HTMLInputElement>("[data-item-rename-input]");
  if (here) return here;

  for (const element of root.querySelectorAll("*")) {
    const nested = element.shadowRoot && renameInputIn(element.shadowRoot);
    if (nested) return nested;
  }
  return null;
};

/**
 * Empties that input, through the same event typing into it would raise.
 *
 * A draft is to be typed into, not corrected, and the tree seeds the input
 * with the row's name -- which for a draft is a placeholder the user never
 * chose. The input belongs to the tree's own renderer and arrives after the
 * rename starts, so this waits for it: on microtasks first, which all run
 * before the browser paints, so the placeholder is never actually seen.
 */
const blank = (root: ParentNode, soon = 12, later = 5): void => {
  const input = renameInputIn(root);
  if (input === null) {
    if (soon > 0) queueMicrotask(() => blank(root, soon - 1, later));
    else if (later > 0) requestAnimationFrame(() => blank(root, 0, later - 1));
    return;
  }
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

class Focus {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get path(): Path | null {
    return this.#snapshot.focusedPath;
  }

  get index(): number {
    return this.#snapshot.focusedIndex;
  }

  get item(): FileTreeItemHandle | null {
    return this.#tree.getFocusedItem();
  }

  at(path: Path): void {
    this.#tree.focusPath(path);
  }

  first(): void {
    this.#tree.focusFirstItem();
  }

  last(): void {
    this.#tree.focusLastItem();
  }

  next(): void {
    this.#tree.focusNextItem();
  }

  previous(): void {
    this.#tree.focusPreviousItem();
  }

  parent(): void {
    this.#tree.focusParentItem();
  }

  nearest(path: Path | null): Path | null {
    return this.#tree.focusNearestPath(path);
  }
}

class Selection {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get paths(): readonly Path[] {
    return this.#snapshot.selectedPaths;
  }

  has(path: Path): boolean {
    return this.#snapshot.selectedPaths.includes(path);
  }

  add(path: Path): void {
    this.#tree.getItem(path)?.select();
  }

  remove(path: Path): void {
    this.#tree.getItem(path)?.deselect();
  }

  toggle(path: Path): void {
    this.#tree.getItem(path)?.toggleSelect();
  }

  clear(): void {
    for (const path of [...this.paths]) this.remove(path);
  }

  only(path: Path): void {
    this.clear();
    this.add(path);
  }
}

class Search {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get isOpen(): boolean {
    return this.#snapshot.searchOpen;
  }

  get value(): string {
    return this.#snapshot.searchValue;
  }

  get matches(): readonly Path[] {
    return this.#snapshot.searchMatches;
  }

  open(initialValue?: string): void {
    this.#tree.openSearch(initialValue);
  }

  close(): void {
    this.#tree.closeSearch();
  }

  set(value: string | null): void {
    this.#tree.setSearch(value);
  }

  focusNext(): void {
    this.#tree.focusNextSearchMatch();
  }

  focusPrevious(): void {
    this.#tree.focusPreviousSearchMatch();
  }
}

class Rows {
  readonly #tree: FileTree;
  readonly #snapshot: Snapshot;

  constructor(tree: FileTree, snapshot: Snapshot) {
    this.#tree = tree;
    this.#snapshot = snapshot;
  }

  get count(): number {
    return this.#snapshot.visibleCount;
  }

  /** `first` and `last` are both inclusive, and both are clamped to `count`. */
  slice(first: number, last: number): readonly FileTreeVisibleRow[] {
    return this.#tree.getVisibleRows(first, last);
  }

  all(): readonly FileTreeVisibleRow[] {
    return this.slice(0, this.count - 1);
  }

  paths(): readonly Path[] {
    return this.all().map(({ path }) => path);
  }

  names(): readonly string[] {
    return this.all().map(({ name }) => name);
  }
}

class Git {
  readonly #tree: FileTree;

  constructor(tree: FileTree) {
    this.#tree = tree;
  }

  set(entries?: readonly GitStatusEntry[]): void {
    this.#tree.setGitStatus(entries);
  }

  patch(patch: FileTreeGitStatusPatch): void {
    this.#tree.applyGitStatusPatch(patch);
  }
}

const renderTarget = (container: HTMLElement): FileTreeRenderProps =>
  container.localName === FILE_TREE_TAG_NAME
    ? { fileTreeContainer: container }
    : { containerWrapper: container };

/**
 * A `@pierre/trees` `FileTree` wearing Svelte's reactivity: every read of
 * `focus`, `selection`, `search` or `rows` is tracked, every write goes straight
 * through to the tree. `tree` is the unwrapped instance for anything not
 * mirrored here.
 */
export class Model {
  readonly tree: FileTree;
  readonly focus: Focus;
  readonly selection: Selection;
  readonly search: Search;
  readonly rows: Rows;
  readonly git: Git;

  readonly #events = new Emitter();
  readonly #snapshot = new Snapshot();
  readonly #teardown: Unsubscribe[] = [];
  readonly #dragAndDrop: FileTreeDragAndDropConfig | undefined;
  readonly #dropOnRoot: boolean;

  #draft: Draft | undefined;
  #held: (() => void) | undefined;
  #container: HTMLElement | undefined;

  constructor(options: Options) {
    const prepared = announcing(options, { emit: this.#outward });
    // Kept as the tree took it, callbacks and all, so a drop this wrapper
    // completes itself is announced exactly like one the tree completes.
    this.#dragAndDrop = prepared.dragAndDrop;
    this.#dropOnRoot = dropsOnRoot(options);
    this.tree = new FileTree(prepared);
    this.focus = new Focus(this.tree, this.#snapshot);
    this.selection = new Selection(this.tree, this.#snapshot);
    this.search = new Search(this.tree, this.#snapshot);
    this.rows = new Rows(this.tree, this.#snapshot);
    this.git = new Git(this.tree);

    this.#teardown.push(this.tree.subscribe(() => this.#absorbChange()));
    this.#teardown.push(
      this.tree.onMutation("*", (event) => this.#announce(event)),
    );
    this.#snapshot.refresh(this.tree);
  }

  /** Whether a new entry is waiting to be named. */
  get drafting(): boolean {
    return this.#draft !== undefined;
  }

  /**
   * Adds an entry with no name yet, inside `within`, and puts the cursor in
   * it.
   *
   * What is announced is only ever the outcome: `added`, once, carrying the
   * name the user typed -- or `rename refused`, carrying why the name could
   * not be used, with the row already gone. Escape says neither, because
   * nothing happened.
   */
  draft(within: Path, kind: "file" | "folder"): void {
    const path = draftPath((at) => this.item(at) !== null, within, kind);
    this.#draft = { path };
    this.tree.add(path);
    this.tree.startRenaming(path, { removeIfCanceled: true });
    if (this.#container) blank(this.#container);
  }

  subscribe(handlers: Handlers): Unsubscribe {
    return this.#events.subscribe(handlers);
  }

  item(path: Path): FileTreeItemHandle | null {
    return this.tree.getItem(path);
  }

  add(path: Path): void {
    this.tree.add(path);
  }

  remove(path: Path, options?: FileTreeRemoveOptions): void {
    this.tree.remove(path, options);
  }

  move(from: Path, to: Path, options?: FileTreeMoveOptions): void {
    this.tree.move(from, to, options);
  }

  batch(operations: readonly FileTreeBatchOperation[]): void {
    this.tree.batch(operations);
  }

  reset(paths: readonly Path[], options?: FileTreeResetOptions): void;
  reset(options: FileTreeResetPreparedOptions): void;
  reset(
    pathsOrOptions: readonly Path[] | FileTreeResetPreparedOptions,
    options?: FileTreeResetOptions,
  ): void {
    const apply = () => {
      if (Array.isArray(pathsOrOptions)) this.tree.resetPaths(pathsOrOptions, options);
      else this.tree.resetPaths(pathsOrOptions as FileTreeResetPreparedOptions);
    };
    // A reset rebuilds the tree around a path set a draft is not in, and the
    // rename in flight goes with it. Whatever arrives mid-draft waits for the
    // draft to end -- only the newest matters, because each is a whole shape.
    if (this.#draft !== undefined) this.#held = apply;
    else apply();
  }

  rename(path?: Path, options?: { removeIfCanceled?: boolean }): boolean {
    return this.tree.startRenaming(path, options);
  }

  scrollTo(path: Path, options?: FileTreeScrollToPathOptions): void {
    this.tree.scrollToPath(path, options);
  }

  setIcons(icons?: FileTreeIcons): void {
    this.tree.setIcons(icons);
  }

  mount(container: HTMLElement): Unsubscribe {
    this.#container = container;
    this.tree.render(renderTarget(container));
    const stopRootDrops = this.#rootDrops(container);
    // Escape and a name the tree will not take both end a draft by removing
    // the row, and the removal alone cannot tell them apart. Only one of them
    // is worth reporting, so the key that caused it is what says which.
    const escaped = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.#draft) this.#draft.abandoned = true;
    };
    container.addEventListener("keydown", escaped, true);
    return () => {
      stopRootDrops?.();
      container.removeEventListener("keydown", escaped, true);
      this.#container = undefined;
      this.tree.unmount();
    };
  }

  hydrate(container: HTMLElement): Unsubscribe {
    this.tree.hydrate({ fileTreeContainer: container });
    const stopRootDrops = this.#rootDrops(container);
    return () => {
      stopRootDrops?.();
      this.tree.unmount();
    };
  }

  dispose(): void {
    for (const stop of this.#teardown.splice(0)) stop();
    this.tree.cleanUp();
  }

  /**
   * Where the tree's own empty space starts meaning the root, for as long as
   * the tree is on the page.
   */
  #rootDrops(container: HTMLElement): Unsubscribe | undefined {
    if (!this.#dropOnRoot || this.#dragAndDrop === undefined) return undefined;
    return rootDropsIn(container, this.#dragAndDrop, this.#subject);
  }

  /** The tree as a drop on the root sees it -- what it carries, and where it lands. */
  readonly #subject: Subject = {
    // The tree settles the selection on the row being dragged before this is
    // read, so the selection IS what the drag carries.
    dragging: () => this.tree.getSelectedPaths(),
    // A bare name matches an entry of either kind, which is what a collision
    // is: `lib/` cannot land where a file called `lib` already is.
    taken: (name) => this.item(name) !== null,
    move: (from, to) => this.move(from, to),
    batch: (operations) => this.batch(operations),
  };

  /**
   * Everything the tree announces about ITSELF passes here first.
   *
   * A draft's rename is not a move of anything a subscriber has heard of, so
   * it is swallowed; the entry it becomes is announced with the mutation
   * instead. A name the tree will not take is announced as it stands, and
   * takes the row down with it.
   */
  #outward = <Name extends keyof Events>(
    name: Name,
    ...args: Events[Name]
  ): void => {
    const draft = this.#draft;
    if (draft !== undefined) {
      if (name === "renamed") return;
      if (name === "rename refused") {
        draft.refused = args[0] as string;
        // The tree leaves the refused row where it is, still called by its
        // placeholder. Nothing should be left holding that.
        queueMicrotask(() => this.remove(draft.path, { recursive: true }));
      }
    }
    this.#events.emit(name, ...args);
  };

  /**
   * The tree's own mutations, with a draft's translated: it appears as
   * nothing, and it lands as an `added` under the name it ended up with.
   */
  #announce(event: FileTreeMutationEvent): void {
    const draft = this.#draft;
    if (draft === undefined) return announceMutation(this.#events, event);

    if (event.operation === "add" && event.path === draft.path) return;

    if (event.operation === "move" && event.from === draft.path) {
      this.#draft = undefined;
      const { operation: _operation, from: _from, to, ...rest } = event;
      this.#events.emit("added", { ...rest, operation: "add", path: to });
      return this.#resume();
    }

    if (event.operation === "remove" && event.path === draft.path) {
      this.#draft = undefined;
      // A blank name is refused by the tree before it reaches the rule that
      // would say so, so this is where that reason comes from.
      if (draft.abandoned !== true && draft.refused === undefined)
        this.#events.emit("rename refused", "Name cannot be empty.");
      return this.#resume();
    }

    announceMutation(this.#events, event);
  }

  /** Applies whatever shape arrived while the draft was being named. */
  #resume(): void {
    const held = this.#held;
    this.#held = undefined;
    held?.();
  }

  #absorbChange(): void {
    const focusedBefore = this.#snapshot.focusedPath;
    this.#snapshot.refresh(this.tree);
    if (this.#snapshot.focusedPath !== focusedBefore)
      this.#events.emit("focus changed", this.#snapshot.focusedPath);
  }
}
