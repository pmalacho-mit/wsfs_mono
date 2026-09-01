/**
 * Monaco, as an editing surface.
 *
 * THIS PACKAGE IS THE ONLY ONE THAT KNOWS MONACO EXISTS -- see the README.
 * What the rest of the system asks of an editor is `Editing` in
 * `wsfs_svelte_suede`, and everything below is this editor's answer to it.
 *
 * The three rules that file states are followed here as they are anywhere:
 * `bind` hands the room's `Y.Text` to the editor's model rather than making a
 * document of its own, `edits` exists from the moment the editor mounts rather
 * than from the moment a room answers, and nothing here writes the file's text
 * into the document.
 */
import type * as Y from "yjs";

import type {
  Edits,
  Editing,
  Opening,
  Pressed,
} from "../../wsfs_svelte_suede/frontend";
import { Editor } from "../../python-monaco-suede";
import { UserEdits } from "./edits";

type CodeEditor = Parameters<NonNullable<Editor.Props["onEditor"]>>[0];

/** Everything an open file's editor is wired with, minus the file itself. */
export type EditorProps = Omit<Editor.Props, "file">;

/** The two halves of a path, named once so every surface agrees. */
const nameOf = (path: string) => path.split("/").pop() ?? path;
const holderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** Monaco's model wants a parent it can read a path off. */
class Holder {
  path: string;

  constructor(path: string) {
    this.path = $state(path);
  }
}

export class MonacoEditing implements Editing {
  readonly file: Editor.Model;
  readonly props: EditorProps;

  #holder: Holder;
  #held: string;
  #editor: CodeEditor | undefined = $state(undefined);
  #edits: UserEdits | undefined = $state(undefined);
  #pressed = new Set<(key: Pressed) => void>();

  constructor(file: Opening, props: EditorProps = {}) {
    this.#held = file.content;
    this.#holder = new Holder(holderOf(file.path));
    this.file = new Editor.Model({
      name: nameOf(file.path),
      parent: this.#holder,
      source: file.content,
      readonly: file.readonly,
    });
    this.props = { ...props, onEditor: (editor) => this.#mounted(editor, props) };
  }

  /** The editor itself, for a consumer that has genuine Monaco business. */
  get editor() {
    return this.#editor;
  }

  get edits(): Edits | undefined {
    return this.#edits;
  }

  value() {
    return (
      this.file.sourceSync?.toString() ??
      this.#editor?.getModel()?.getValue() ??
      this.#held
    );
  }

  bound() {
    return this.file.sourceSync as Y.Text | undefined;
  }

  /**
   * BOUND ONLY ONCE THE DOCUMENT HAS BEEN RECEIVED, and the caller is what
   * guarantees that. `MonacoBinding` makes the model say whatever the `Y.Text`
   * says the moment it is constructed -- so binding an unsynchronised document
   * does not show an empty file, it MAKES one, and the next store writes that
   * over the real content.
   */
  bind(text: Y.Text) {
    this.file.sourceSync = text;
    this.#edits?.attach(text);
  }

  replace(value: string) {
    this.#held = value;
    this.#editor?.getModel()?.setValue(value);
  }

  moved(path: string) {
    this.file.name = nameOf(path);
    this.#holder.path = holderOf(path);
  }

  keys(pressed: (key: Pressed) => void) {
    this.#pressed.add(pressed);
    return () => void this.#pressed.delete(pressed);
  }

  dispose() {
    this.#edits?.dispose();
    this.#edits = undefined;
    this.#pressed.clear();
  }

  #mounted(editor: CodeEditor, props: EditorProps) {
    this.#editor = editor;
    const theirs = props.onEditor?.(editor);
    const edits = new UserEdits(editor, this.bound());
    this.#edits = edits;
    const keys = editor.onKeyDown((event) => this.#told(event));
    return {
      dispose: () => {
        theirs?.dispose();
        keys.dispose();
        edits.dispose();
        if (this.#edits === edits) this.#edits = undefined;
        if (this.#editor === editor) this.#editor = undefined;
      },
    };
  }

  #told(event: {
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
    for (const listener of this.#pressed) listener(pressed);
  }
}
