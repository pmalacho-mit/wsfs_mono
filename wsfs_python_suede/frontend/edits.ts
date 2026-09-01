/**
 * Monaco's own account of what caused an edit, and the class that uses it.
 *
 * THE OTHER HALF IS IN `wsfs_svelte_suede`. That one is the Yjs transaction
 * origin -- vendor-neutral, sufficient on its own, and the reason a peer's
 * keystroke is never mistaken for this person's. What is here is the
 * refinement: VS Code tags every model edit with what caused it
 * (`cursor`/`type`, `cursor`/`paste`, `applyEdits`, `setValue`, `suggest`,
 * `Chat.applyEdits`, ...), which is the only signal that NAMES the gesture and
 * the only one that works before there is a shared document at all.
 *
 * It is also the fragile half, and knowingly so: the field is on the runtime
 * event but absent from the public typings, so it is read defensively and its
 * absence is survivable -- `reported: false` says so, and the neutral half
 * still refuses everything that was not this person.
 */

import type { Text } from "yjs";

import {
  Edits,
  type Change,
  type Did,
  type Ignored,
  type Named,
  type Span,
  type UserEdit,
} from "../../wsfs_svelte_suede/frontend/edits";
import type { Editor } from "../../python-monaco-suede";

export type { Did, Ignored, Span, UserEdit };

/** The editor as the rest of the app already has it -- see `Editor.Props`. */
type CodeEditor = Parameters<NonNullable<Editor.Props["onEditor"]>>[0];

type ContentChanged = Parameters<
  Parameters<CodeEditor["onDidChangeModelContent"]>[0]
>[0];

/** One replaced span, as Monaco reports it. */
export type ModelChange = ContentChanged["changes"][number];

/**
 * What VS Code says caused an edit.
 *
 * Hand-declared because it is missing from the public surface: `editor.api.d.ts`
 * declares `detailedReasonsChangeLengths` and its doc comment refers to a
 * `detailedReasons` it never declares. The field is on the object at runtime
 * (see `textModel.js`, where every `_emitContentChangedEvent` carries one), and
 * this is the shape it has -- but it is internal, so everything below treats it
 * as something that might one day not be there.
 */
type EditSource = {
  readonly metadata: {
    readonly source: string;
    readonly kind?: string;
    readonly detailedSource?: string | null;
  };
};

type Reported = ContentChanged & {
  readonly detailedReasons?: readonly EditSource[];
};

/**
 * What a single edit source means, or why it is not this person's doing.
 *
 * The source strings are VS Code's own (`EditSources` in
 * `textModelEditSource.js`) and the set is closed, so an unrecognised one is
 * treated as programmatic: better to drop an edit that was the user's than to
 * attribute one that was not.
 */
const gestureOf = (
  source: EditSource,
): { did: Did; via?: string } | Ignored => {
  const { source: what, kind, detailedSource } = source.metadata;
  const via = detailedSource ?? undefined;
  switch (what) {
    case "cursor":
      switch (kind) {
        case "type":
          return { did: "typed", via };
        case "paste":
          return { did: "pasted", via };
        case "cut":
          return { did: "cut", via };
        case "compositionType":
        case "compositionEnd":
          return { did: "composed", via };
        case "executeCommand":
        case "executeCommands":
          return { did: "ran", via };
        default:
          return { did: "changed", via };
      }
    // Offered by the editor, taken by the person. Their doing, and the
    // distinction between them is worth keeping, so `via` names which.
    case "suggest":
    case "snippet":
    case "codeAction":
    case "inlineCompletionAccept":
    case "inlineCompletionPartialAccept":
      return { did: "accepted", via: what };
    // Written on the person's behalf by an assistant. Not nobody, but not
    // them either, which is the distinction this class exists to make.
    case "Chat.applyEdits":
    case "Chat.undoEdits":
    case "Chat.reset":
    case "inlineChat.applyEdits":
      return "assistant";
    // The whole buffer swapped out -- most often `MonacoBinding` seeding the
    // model with the room's contents the moment it attaches.
    case "setValue":
      return "reset";
    default:
      return "programmatic";
  }
};

/**
 * One event's reasons, resolved into a gesture.
 *
 * One event can carry several. The person's gesture wins if any of them is
 * one; otherwise the first reason explains the refusal.
 */
const gestureIn = (reasons: readonly EditSource[]): Named => {
  let refused: Ignored | undefined;
  for (const reason of reasons) {
    const gesture = gestureOf(reason);
    if (typeof gesture !== "string") return gesture;
    refused ??= gesture;
  }
  return refused ?? "programmatic";
};

/**
 * Monaco orders its changes from the end of the document backwards. Read in
 * reverse they spell what the person actually inserted.
 */
const spansOf = (changes: readonly ModelChange[]): Span[] =>
  [...changes].reverse().map((change) => ({
    at: change.rangeOffset,
    removed: change.rangeLength,
    inserted: change.text,
  }));

export class UserEdits extends Edits {
  readonly editor: CodeEditor;

  #watching: { dispose: () => void }[] = [];

  /**
   * A paste announces itself just before the change it causes. Only used when
   * the editor did not name the gesture itself; see `UserEdit.reported`.
   */
  #pasted = false;

  constructor(editor: CodeEditor, text?: Text) {
    super((change) => this.#name(change), {
      surface: () => editor.getModel(),
      /** What y-monaco calls the model it drives. */
      bound: "monacoModel",
    });
    this.editor = editor;
    this.#watching.push(
      editor.onDidPaste(() => (this.#pasted = true)),
      editor.onDidChangeModelContent((event: ContentChanged) =>
        this.#changed(event),
      ),
    );
    if (text) this.attach(text);
  }

  override dispose() {
    if (this.disposed) return;
    for (const watch of this.#watching) watch.dispose();
    this.#watching = [];
    super.dispose();
  }

  #reasons: readonly EditSource[] | undefined;

  #changed(event: ContentChanged) {
    this.#reasons = (event as Reported).detailedReasons;
    this.report({
      spans: spansOf(event.changes),
      version: event.versionId,
      flushed: event.isFlush,
      undone: event.isUndoing
        ? "undid"
        : event.isRedoing
          ? "redid"
          : undefined,
    });
  }

  /** The refinement, with the fallback for when Monaco does not supply one. */
  #name(_change: Change): Named {
    const reasons = this.#reasons;
    const pasted = this.#pasted;
    this.#pasted = false;

    if (reasons !== undefined && reasons.length > 0) return gestureIn(reasons);

    // No provenance. All that is left is the public surface, which can say
    // that a paste happened and that the caret is here -- the old heuristic,
    // kept only as the floor rather than as the mechanism.
    if (!this.editor.hasTextFocus()) return "unwitnessed";
    return { did: pasted ? "pasted" : "changed", reported: false };
  }
}

/**
 * Watches one editor and reports what the person using it did.
 *
 * The return value disposes, so it can be handed straight back from `onEditor`.
 */
export const watchEdits = (editor: CodeEditor, text?: Text) =>
  new UserEdits(editor, text);
