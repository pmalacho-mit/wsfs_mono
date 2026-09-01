import type { Snippet } from "svelte";

import type { Edits, UserEdit } from "./edits";
import type { OpenText } from "./open.svelte";

/**
 * A key pressed with hands in an editor, and the chance to claim it.
 *
 * `claim` prevents the browser's own shortcut and stops the workbench
 * underneath from acting on a key that has already been answered.
 */
export type Pressed = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  claim: () => void;
};

/**
 * What an editor tells the workspace about itself, once it is on screen.
 *
 * Registered with `OpenText.mounted`, which returns the undo. Three of the
 * four members exist because the workspace has to be able to keep what
 * somebody typed when there is no shared document to keep it in -- see
 * `OpenText.keepWhatWasTyped`.
 */
export type Editor = {
  /** What the person can see right now. */
  text: () => string;
  /**
   * Say this, with no regard for a shared document.
   *
   * Only reached when none is bound. Once one is, `become` on its `Y.Text` is
   * the way to change what it says: replacing a shared text throws away the
   * positions that let two people type in one paragraph at once.
   */
  replace: (text: string) => void;
  /** Edits made BY THE PERSON AT THIS KEYBOARD. See `edits.ts`. */
  edits: Edits;
  /** Keys pressed with hands in this editor. Returns the unsubscribe. */
  keys?: (pressed: (key: Pressed) => void) => () => void;
};

/**
 * What draws a text file, for the files a consumer draws its own way.
 *
 * Answering `undefined` takes this package's plain textarea, which is bound to
 * the room's document and correct rather than capable. Nothing here knows what
 * a `.py` file is, so nothing here can decide that one wants an IDE.
 *
 * THE SIZE IS PASSED, not read: the panel's slider is the shell's and outranks
 * whatever a consumer configured every editor with. An editor that ignores it
 * is one the slider does not move.
 */
export type EditorFor = (
  path: string,
) => Snippet<[file: OpenText, size: number]> | undefined;

export type { Edits, UserEdit };
