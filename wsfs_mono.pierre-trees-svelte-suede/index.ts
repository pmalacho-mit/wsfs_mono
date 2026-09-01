import {
  FILE_TREE_DEFAULT_ITEM_HEIGHT,
  FILE_TREE_DENSITY_PRESETS,
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
  prepareFileTreeInput,
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type ContextMenuButtonVisibility,
  type ContextMenuTriggerMode,
  type FileTreeBatchOperation,
  type FileTreeCompositionOptions,
  type FileTreeDensity,
  type FileTreeDirectoryHandle,
  type FileTreeDragAndDropConfig,
  type FileTreeDropContext,
  type FileTreeDropResult,
  type FileTreeFileHandle,
  type FileTreeGitStatusPatch,
  type FileTreeIconConfig,
  type FileTreeIcons,
  type FileTreeItemHandle,
  type FileTreeMutationEvent,
  type FileTreePreparedInput,
  type FileTreeRenamingConfig,
  type FileTreeRowDecorationRenderer,
  type FileTreeSearchMode,
  type FileTreeSortComparator,
  type FileTreeVisibleRow,
  type GitStatus,
  type GitStatusEntry,
  type TreeThemeInput,
} from "@pierre/trees";
import TreeComponent from "./Tree.svelte";
import ContextMenuComponent, { standardActions } from "./ContextMenu.svelte";
import { Model as TreeModel } from "./model.svelte";
import { entries as entryMutations } from "./entries";
import type { Props as TreeProps } from "./Tree.svelte";
import type {
  Action as MenuAction,
  Props as MenuProps,
  Variables as MenuVariables,
} from "./ContextMenu.svelte";
import type { Path as TreePath } from "./model.svelte";
import type { ContextMenuTrigger } from "./composition";
import { asDeclarations, asProps } from "./variables";
import type { VariableName, Variables } from "./variables";
import type {
  Events as TreeEvents,
  Handlers as TreeHandlers,
  Unsubscribe as TreeUnsubscribe,
} from "./events";
import type { Options as TreeOptions } from "./options";

/**
 * `handle.isDirectory()` answers the question but does not narrow the union,
 * because TypeScript reads return types, not literal return values.
 */
const isDirectory = (
  handle: FileTreeItemHandle | null,
): handle is FileTreeDirectoryHandle => handle !== null && handle.isDirectory();

export const Tree = {
  Model: TreeModel,
  Component: TreeComponent,
  isDirectory,
  isFile: (handle: FileTreeItemHandle | null): handle is FileTreeFileHandle =>
    handle !== null && !handle.isDirectory(),
};

export namespace Tree {
  export type Model = TreeModel;
  export type Props = TreeProps;
  export type Variable = VariableName;
  export type Style = Variables;
  export type Options = TreeOptions;
  export type Path = TreePath;
  export type Events = TreeEvents;
  export type Handlers = TreeHandlers;
  export type Unsubscribe = TreeUnsubscribe;

  export type Item = FileTreeItemHandle;
  export type Directory = FileTreeDirectoryHandle;
  export type File = FileTreeFileHandle;
  export type Row = FileTreeVisibleRow;

  export type Mutation = FileTreeMutationEvent;
  export type BatchOperation = FileTreeBatchOperation;
  export type Composition = FileTreeCompositionOptions;
  export type ContextMenu = ContextMenuTrigger;
  export type TriggerMode = ContextMenuTriggerMode;
  export type ButtonVisibility = ContextMenuButtonVisibility;
  export type Decoration = FileTreeRowDecorationRenderer;
  export type Density = FileTreeDensity;
  export type DragAndDrop = FileTreeDragAndDropConfig;
  export type Drop = FileTreeDropResult;
  export type DropContext = FileTreeDropContext;
  export type GitState = GitStatus;
  export type GitEntry = GitStatusEntry;
  export type GitPatch = FileTreeGitStatusPatch;
  export type Icons = FileTreeIcons;
  export type IconConfig = FileTreeIconConfig;
  export type PreparedInput = FileTreePreparedInput;
  export type Renaming = FileTreeRenamingConfig;
  export type SearchMode = FileTreeSearchMode;
  export type Sort = FileTreeSortComparator;
  export type Theme = TreeThemeInput;
}

/**
 * A ready-made menu for the tree's `contextMenu` snippet: the surface, the
 * keyboard handling, the anchoring, and the four actions a file explorer is
 * expected to have. Nothing here is privileged — it is the same snippet API a
 * consumer would write, kept in the library because most of them want it.
 */
export const ContextMenu = {
  Component: ContextMenuComponent,
  actions: standardActions,
};

export namespace ContextMenu {
  export type Action = MenuAction;
  export type Props = MenuProps;
  export type Style = MenuVariables;
}

/**
 * The mutations the standard menu actions are made of. `add` opens a DRAFT --
 * a row with no name that nothing outside the tree hears about until it has
 * one; see `Tree.Model.draft`.
 */
export const entries = entryMutations;

export const input = {
  prepare: prepareFileTreeInput,
  presorted: preparePresortedFileTreeInput,
};

export const theme = {
  /** The whole mapping, camelCase host styles included. */
  styles: themeToTreeStyles,
  /** Just the custom properties, ready to spread onto `Tree.Component`. */
  props: (source: TreeThemeInput): Variables =>
    asProps(themeToTreeStyles(source)),
  /** The whole mapping as a `style` attribute. */
  css: (source: TreeThemeInput): string =>
    asDeclarations(themeToTreeStyles(source)),
};

export const icons = {
  spriteSheet: getBuiltInSpriteSheet,
  resolver: createFileTreeIconResolver,
};

export const density = {
  presets: FILE_TREE_DENSITY_PRESETS,
  defaultItemHeight: FILE_TREE_DEFAULT_ITEM_HEIGHT,
};
