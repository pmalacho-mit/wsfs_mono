/**
 * A Svelte user interface for a wsfs workspace.
 *
 * WHAT THIS PACKAGE IS NOT is an application. It ships the pieces -- a tree, a
 * file view, a history dialog, a layout shell -- and three extension points
 * where the things it must not know about slot in:
 *
 *   `surfaceFor`  what a file is edited in       (`wsfs_python_suede` puts Monaco here)
 *   `panels`      what else the dock holds       (`wsfs_assistant_suede` puts a chat panel here)
 *   `onEdit`      who is typing, and what        (`wsfs_pytutor_suede` listens)
 *
 * It knows nothing about Python, about models, or about who is watching. What
 * it knows is core's `Workspace` object and how to draw one.
 */

/** The pieces a workspace is composed of. */
export { default as FileTree, Model as FileTreeModel } from "./FileTree.svelte";
export { default as FileView } from "./FileView.svelte";
export { default as History } from "./History.svelte";
export { default as Layout } from "./Layout.svelte";
export { default as MenuLayer } from "./MenuLayer.svelte";
export { default as Preview } from "./Preview.svelte";

/** The shell around a workspace: a header, a frame, and a pane to put one in. */
export { default as Header } from "./shell/Header.svelte";
export { default as ModeToggle } from "./shell/ModeToggle.svelte";
export { default as PanelHeading } from "./shell/PanelHeading.svelte";
export { default as TextSizeSlider } from "./shell/TextSizeSlider.svelte";
export { default as WorkspaceFrame } from "./shell/WorkspaceFrame.svelte";

/**
 * What an editing surface is, and the plain one this package ships.
 *
 * The protocol is the boundary: a consumer registers Monaco, a notebook cell,
 * or anything else for the files it knows about, and everything here goes on
 * working because nothing here knows what any of those are.
 */
export type { Editing, Opening, Pressed, Surface, SurfaceFor } from "./surface";

/**
 * One file, open -- and what happens to what somebody types into it.
 *
 * Public because a composition root builds these: it decides which surface a
 * file gets and hands the result to `FileView`.
 */
export { OpenFile, SharedTextFile } from "./open.svelte";
export type {
  Entry,
  EntrySnapshot,
  Execution,
  Snapshot,
  Taking,
} from "./open.svelte";
export { textarea } from "./TextareaSurface.svelte";
export { TextareaEditing } from "./textarea.svelte";

/**
 * Who edited, and how to tell.
 *
 * `Edits` is public API of this package because `wsfs_pytutor_suede`'s stuck
 * detector consumes it through whichever surface is in use -- see `edits.ts`
 * for which half of the answer lives here and why that half is the sufficient
 * one.
 */
export { Edits, bindsSurface, described } from "./edits";
export type {
  Change,
  Did,
  Events as EditEvents,
  Ignored,
  Named,
  Naming,
  Span,
  UserEdit,
} from "./edits";

/** One file's shared document, as a component can watch it. */
export { Room, Rooms, become } from "./room.svelte";
export type {
  Enter,
  Host,
  Persist,
  Provider,
  Replacement,
  Sending,
  Trouble,
  Withheld,
  Written,
} from "./room.svelte";

/** Appearance, and the one text size every panel is drawn at. */
export { appearance } from "./appearance.svelte";
export { TextSize, TextSizes } from "./textsize.svelte";

/** Paths, as the components spell them. */
export { holderOf, nameOf } from "./paths";

/** Dragging files in and out of the tree. */
export * as transfer from "./transfer";

/** A pool of expensive, single-use resources -- a kernel, say. */
export { WarmPool } from "./pool";
export type { Lease, WarmPoolOptions, WarmPoolStats } from "./pool";

export { InView } from "./inview.svelte";
export { cleaner, pointAsRect } from "./utils";
