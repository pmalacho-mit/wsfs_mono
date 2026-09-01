/**
 * A Svelte user interface for a wsfs workspace.
 *
 * `Workspace` is the shell: a file explorer on the left, and open files in
 * dock tabs beside it. It knows nothing about Python, about models, or about
 * who is watching somebody work -- and it has three ways out for the things it
 * must not know:
 *
 *   `editorFor`   what draws a text file       (`wsfs_python_suede` puts Monaco here)
 *   `events`      what the person did          (`wsfs_pytutor_suede` listens)
 *   `onReady`     the grid, and what is on it  (`wsfs_assistant_suede` adds a panel)
 */

export { default as Workspace, WorkspaceEvents } from "./Workspace.svelte";
export type { Announced, Dock, Grid, Shell } from "./Workspace.svelte";

/** The pieces the shell lays out, for a consumer arranging its own. */
export { default as FileTree, Model as FileTreeModel } from "./FileTree.svelte";
export { default as FileView } from "./FileView.svelte";
export { default as History } from "./History.svelte";
export { default as Layout } from "./Layout.svelte";
export { default as MenuLayer } from "./MenuLayer.svelte";
export { default as Panel } from "./Panel.svelte";
export { default as Preview } from "./Preview.svelte";
export { default as Textarea } from "./Textarea.svelte";

/** The chrome around a workspace: a header, a frame, a heading, a slider. */
export { default as Header } from "./shell/Header.svelte";
export { default as ModeToggle } from "./shell/ModeToggle.svelte";
export { default as PanelHeading } from "./shell/PanelHeading.svelte";
export { default as TextSizeSlider } from "./shell/TextSizeSlider.svelte";
export { default as WorkspaceFrame } from "./shell/WorkspaceFrame.svelte";
export { navigation } from "./shell/navigation";
export type { Destination } from "./shell/navigation";

/**
 * What an editor is, to this package.
 *
 * Short on purpose: every member exists because the shell has to be able to
 * keep what somebody typed when there is no shared document to keep it in.
 * `TextareaBinding` is the implementation this package ships, and the thing to
 * measure a second one against.
 */
export type { Editor, EditorFor, Pressed } from "./editor";
export { TextareaBinding } from "./textarea.svelte";

/** One entry, open in a tab -- and what happens to what is typed into it. */
export { OpenEntry, OpenText } from "./open.svelte";
export type {
  Entry,
  EntrySnapshot,
  Run,
  Snapshot,
  Taking,
} from "./open.svelte";

/**
 * Who edited, and how to tell.
 *
 * `Edits` is public API because `wsfs_pytutor_suede`'s stuck detector consumes
 * it through whichever editor is in use. `edits.ts` says which half of the
 * answer lives here and why that half is the sufficient one.
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

export { holderOf, nameOf } from "./paths";

/** Dragging files in and out of the tree. */
export * as transfer from "./transfer";

/** A pool of expensive, single-use resources -- a kernel, say. */
export { WarmPool } from "./pool";
export type { Lease, WarmPoolOptions, WarmPoolStats } from "./pool";

export { InView } from "./inview.svelte";
export { cleaner, pointAsRect } from "./utils";
