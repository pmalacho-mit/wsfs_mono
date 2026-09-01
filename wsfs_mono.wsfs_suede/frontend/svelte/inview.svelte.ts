import { SvelteSet } from "svelte/reactivity";
import type { Id } from "./FileTree.svelte";
import type { PanelApi } from "dockview";

/**
 * Which panels are on screen, kept up to date as the layout is moved.
 *
 * "In front" is not the same question as "visible": dockview shows one
 * panel per GROUP, so two groups side by side means two visible panels and
 * neither of them stops being visible when the other is clicked. The panel
 * api answers it directly, and says when the answer changes -- so this can
 * be read live rather than worked out at the moment somebody asks.
 */
export class InView {
  readonly #showing = new SvelteSet<Id>();
  readonly #watching = new Map<Id, { dispose: () => void }>();

  /**
   * Read as a whole rather than asked per entry, so that anything
   * rendering from it depends on the SET and not on whichever entries
   * happened to exist the first time it looked.
   */
  get showing(): ReadonlySet<Id> {
    return this.#showing;
  }

  watch(panel: {
    id: string;
    api: Pick<PanelApi, "isVisible" | "onDidVisibilityChange">;
  }) {
    this.forget(panel.id);
    const settle = (visible: boolean) =>
      visible ? this.#showing.add(panel.id) : this.#showing.delete(panel.id);
    settle(panel.api.isVisible);
    this.#watching.set(
      panel.id,
      panel.api.onDidVisibilityChange(({ isVisible }) => settle(isVisible)),
    );
  }

  forget(entry: Id) {
    this.#watching.get(entry)?.dispose();
    this.#watching.delete(entry);
    this.#showing.delete(entry);
  }

  dispose() {
    for (const entry of [...this.#watching.keys()]) this.forget(entry);
  }
}
