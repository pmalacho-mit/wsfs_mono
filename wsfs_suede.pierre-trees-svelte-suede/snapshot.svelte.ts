import type { FileTree } from "@pierre/trees";

const sameOrder = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * The parts of a tree's state Svelte can react to. `@pierre/trees` reports every
 * change through a single subscription with no payload, so each field is re-read
 * from the tree and only written back when it actually moved.
 */
export class Snapshot {
  selectedPaths = $state<readonly string[]>([]);
  focusedPath = $state<string | null>(null);
  focusedIndex = $state(-1);
  visibleCount = $state(0);
  searchOpen = $state(false);
  searchValue = $state("");
  searchMatches = $state<readonly string[]>([]);

  refresh(tree: FileTree): void {
    this.#refreshPaths(tree);
    this.focusedPath = tree.getFocusedPath();
    this.focusedIndex = tree.getFocusedIndex();
    this.visibleCount = tree.getVisibleCount();
    this.searchOpen = tree.isSearchOpen();
    this.searchValue = tree.getSearchValue();
  }

  #refreshPaths(tree: FileTree): void {
    const selected = tree.getSelectedPaths();
    if (!sameOrder(selected, this.selectedPaths)) this.selectedPaths = selected;

    const matches = tree.getSearchMatchingPaths();
    if (!sameOrder(matches, this.searchMatches)) this.searchMatches = matches;
  }
}
