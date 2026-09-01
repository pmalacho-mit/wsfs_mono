/**
 * Monaco, bound to a wsfs file.
 *
 * THIS PACKAGE IS THE ONLY ONE THAT KNOWS MONACO EXISTS. What the shell asks
 * of an editor is `Editor` in `wsfs_svelte_suede`, and this is Monaco's answer
 * to it -- four members, three of which exist so that what somebody typed can
 * be kept when no shared document holds it yet.
 */
import type * as Y from "yjs";

import type {
  Editor as EditorContract,
  OpenText,
  Pressed,
} from "../../wsfs_svelte_suede/frontend";
import { Editor } from "../../python-monaco-suede";
import { UserEdits } from "./edits";

type CodeEditor = Parameters<NonNullable<Editor.Props["onEditor"]>>[0];

/** Everything every editor in a workspace is configured with, minus the file. */
export type EditorProps = Omit<Editor.Props, "file">;

const nameOf = (path: string) => path.split("/").pop() ?? path;
const holderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** Monaco's model wants a parent it can read a path off. */
class Holder {
  path: string;

  constructor(path: string) {
    this.path = $state(path);
  }
}

/**
 * One file, as Monaco has it open.
 *
 * The MODEL outlives the editor: a tab dragged to another group is torn down
 * and rebuilt, so what a person typed lives here rather than in whichever
 * `IStandaloneCodeEditor` happens to be drawing it.
 */
export class MonacoModel implements EditorContract {
  readonly model: Editor.Model;

  #holder: Holder;
  #openedOn: string;
  #editor: CodeEditor | undefined;
  #edits: UserEdits | undefined;
  #keyListeners = new Set<(pressed: Pressed) => void>();

  constructor(file: OpenText) {
    this.#openedOn = file.showing;
    this.#holder = new Holder(holderOf(file.path));
    this.model = new Editor.Model({
      name: nameOf(file.path),
      parent: this.#holder,
      source: this.#openedOn,
      readonly: file.readonly,
    });
  }

  /** The editor itself, for a consumer with genuine Monaco business. */
  get editor() {
    return this.#editor;
  }

  /**
   * There is no edit stream until Monaco has handed over an editor, and the
   * shell is not told about this model until there is -- so reaching this is a
   * caller having got the order wrong rather than a case to handle.
   */
  get edits(): UserEdits {
    if (this.#edits === undefined)
      throw new Error("no editor is watching this file yet");
    return this.#edits;
  }

  /** Monaco has an editor drawing this model. Returns the undo. */
  watch(editor: CodeEditor): () => void {
    this.#editor = editor;
    const edits = new UserEdits(editor, this.document());
    this.#edits = edits;
    const keys = editor.onKeyDown((event) => this.#pressed(event));
    return () => {
      keys.dispose();
      edits.dispose();
      if (this.#edits === edits) this.#edits = undefined;
      if (this.#editor === editor) this.#editor = undefined;
    };
  }

  text() {
    return (
      this.document()?.toString() ??
      this.#editor?.getModel()?.getValue() ??
      this.#openedOn
    );
  }

  replace(next: string) {
    this.#editor?.getModel()?.setValue(next);
  }

  keys(listener: (pressed: Pressed) => void) {
    this.#keyListeners.add(listener);
    return () => void this.#keyListeners.delete(listener);
  }

  /**
   * BOUND ONLY ONCE THE DOCUMENT HAS ARRIVED, which the shell guarantees by
   * not offering one before then. `MonacoBinding` makes the model say whatever
   * the `Y.Text` says the moment it is constructed -- so binding an
   * unsynchronised document does not show an empty file, it MAKES one, and the
   * next store writes that over the real content.
   */
  bind(document: Y.Text) {
    if (this.model.sourceSync === document) return;
    this.model.sourceSync = document;
    this.#edits?.attach(document);
  }

  moved(path: string) {
    this.model.name = nameOf(path);
    this.#holder.path = holderOf(path);
  }

  dispose() {
    this.#keyListeners.clear();
  }

  private document() {
    return this.model.sourceSync as Y.Text | undefined;
  }

  #pressed(event: {
    browserEvent: KeyboardEvent;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) {
    const pressed: Pressed = {
      key: event.browserEvent.key,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      claim: () => {
        event.preventDefault();
        event.stopPropagation();
      },
    };
    for (const listener of this.#keyListeners) listener(pressed);
  }
}
