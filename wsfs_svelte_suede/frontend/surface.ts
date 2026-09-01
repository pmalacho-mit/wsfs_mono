/**
 * What an editing surface is, to this package.
 *
 * A workspace shows files, and what a file is shown IN is not this package's
 * business: `wsfs_python_suede` puts Monaco in front of a `.py`, this package
 * ships a plain collaborative textarea for everything else, and a consumer
 * with an editor of its own registers a third. What all three have to answer
 * is here, and it is short on purpose -- every member below exists because
 * something in `Workspace.svelte` or `FileView.svelte` asks it.
 *
 * THREE RULES A SURFACE MUST FOLLOW, and each of them has cost somebody a
 * file:
 *
 *  1. BIND TO THE ROOM'S DOCUMENT, never one of your own. A room outlives its
 *     providers -- that is what makes a network lapse survivable -- so a
 *     document the surface created is thrown away with the surface, taking
 *     everything typed during the lapse.
 *
 *  2. REPORT EDITS BEFORE THERE IS A DOCUMENT, with `shared: false`. The
 *     person is still editing; their edits just are not going anywhere yet,
 *     and anything counting activity has to hear them.
 *
 *  3. NEVER DIFF THE FILE INTO THE DOCUMENT. Only the server carries text
 *     into a room (SPEC §13.14). A surface that reads the file and types the
 *     difference in creates new characters, and the file ends up saying
 *     everything twice.
 */
import type { Component } from "svelte";
import type * as Y from "yjs";

import type { Edits } from "./edits";

/** A key pressed with hands in the surface, and the chance to claim it. */
export type Pressed = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /**
   * Stop the browser and everything underneath from also acting on it.
   *
   * Both halves: prevented so the browser's own shortcut stays shut, stopped
   * so the workbench underneath does not also act on a key that has already
   * been answered.
   */
  claim: () => void;
};

/** One file, being edited. */
export type Editing = {
  /**
   * What the person can see, whether or not a shared document holds it.
   *
   * The document first when there is one, then whatever the surface holds,
   * then the content it was opened on -- in that order, because each is more
   * authoritative than the next.
   */
  value: () => string;

  /**
   * Say this, locally, with no regard for a shared document.
   *
   * ONLY FOR A SURFACE THAT HAS NOT JOINED ONE. Once a document is bound,
   * `become` on the room's text is the way to change what it says, because
   * replacing a shared text throws away the positions that let two people
   * type in one paragraph at once.
   */
  replace: (value: string) => void;

  /** Bind to the room's text. Called once, when the room has synced. */
  bind: (text: Y.Text) => void;

  /** The shared text this is bound to, if it has been bound. */
  bound: () => Y.Text | undefined;

  /** This file was renamed or moved. */
  moved: (path: string) => void;

  /**
   * Edits made BY THE PERSON AT THIS KEYBOARD, once there is a view watching.
   *
   * Undefined before the surface has mounted, and reactive: a component may
   * read it and be redrawn when it appears. See `edits.ts` for why telling
   * this person's edits from everybody else's is the whole problem.
   */
  readonly edits: Edits | undefined;

  /** Keys pressed with hands in this surface. Returns an unsubscribe. */
  keys: (pressed: (key: Pressed) => void) => () => void;

  dispose: () => void;
};

/** The file a surface is being asked to open. */
export type Opening = {
  path: string;
  content: string;
  readonly: boolean;
};

/**
 * One kind of editing surface: how to open a file in it, and what draws it.
 *
 * Two members rather than one component, because the state outlives the view.
 * A dock tears a panel down and builds it again when a tab is dragged, and
 * what the person typed must not go with it.
 */
export type Surface = {
  open: (file: Opening) => Editing;
  /** Draws whatever `open` returned, at the size the panel asks for. */
  view: Component<{ editing: Editing; size: number }>;
};

/**
 * Which surface a file gets.
 *
 * A consumer says "Monaco for `.py`, the plain one for everything else" by
 * writing that sentence. Nothing here knows what a `.py` file is.
 */
export type SurfaceFor = (file: { path: string }) => Surface;
