import type {
  FileTreeDragAndDropConfig,
  FileTreeOptions,
  FileTreeRenamingConfig,
} from "@pierre/trees";
import type { Emitter } from "./events";

/**
 * Where these announcements go. Narrower than `Emitter` on purpose: the model
 * puts itself in the middle of this, so a draft's events can be held back
 * before anything subscribed ever sees them.
 */
export type Announce = Pick<Emitter, "emit">;

export type Options = FileTreeOptions & {
  /**
   * Whether the tree's own empty space -- anywhere below the last row, and the
   * header -- accepts a drop, and means the root when it does. On wherever
   * `dragAndDrop` is.
   *
   * The tree reads a drop target off the row under the pointer, so without
   * this the only way out of a directory is a drop onto a row that already
   * lives at the top level. See `dropping.ts`.
   */
  dropOnRoot?: boolean;
};

/** Whether a model's options leave drops on empty space to mean the root. */
export const dropsOnRoot = (options: Options): boolean =>
  options.dropOnRoot ?? true;

const relay =
  <Args extends unknown[]>(
    announce: (...args: Args) => void,
    original: ((...args: Args) => void) | undefined,
  ) =>
  (...args: Args): void => {
    announce(...args);
    original?.(...args);
  };

const configWhenEnabled = <Config extends object>(
  toggle: boolean | Config | undefined,
): Config | undefined => {
  if (toggle === true) return {} as Config;
  if (toggle === false || toggle === undefined) return undefined;
  return toggle;
};

const announcingRenames = (
  renaming: Options["renaming"],
  emitter: Announce,
): FileTreeRenamingConfig | undefined => {
  const config = configWhenEnabled(renaming);
  if (config === undefined) return undefined;
  return {
    ...config,
    onRename: relay(
      (event) => emitter.emit("renamed", event),
      config.onRename,
    ),
    onError: relay(
      (error) => emitter.emit("rename refused", error),
      config.onError,
    ),
  };
};

const announcingDrops = (
  dragAndDrop: Options["dragAndDrop"],
  emitter: Announce,
): FileTreeDragAndDropConfig | undefined => {
  const config = configWhenEnabled(dragAndDrop);
  if (config === undefined) return undefined;
  return {
    ...config,
    onDropComplete: relay(
      (event) => emitter.emit("dropped", event),
      config.onDropComplete,
    ),
    onDropError: relay(
      (error, context) => emitter.emit("drop refused", error, context),
      config.onDropError,
    ),
  };
};

/**
 * The options as the tree takes them: every callback it can make routed
 * through the emitter first, and what only this wrapper understands removed.
 *
 * `dragAndDrop` comes back as the config it resolved to rather than the
 * shorthand it may have arrived as, because the model holds on to it.
 */
export type Announced = FileTreeOptions & {
  dragAndDrop?: FileTreeDragAndDropConfig;
};

export const announcing = (
  { dropOnRoot: _dropOnRoot, ...options }: Options,
  emitter: Announce,
): Announced => ({
  ...options,
  onSelectionChange: relay(
    (paths) => emitter.emit("selection changed", paths),
    options.onSelectionChange,
  ),
  onSearchChange: relay(
    (value) => emitter.emit("search changed", value),
    options.onSearchChange,
  ),
  renaming: announcingRenames(options.renaming, emitter),
  dragAndDrop: announcingDrops(options.dragAndDrop, emitter),
});
