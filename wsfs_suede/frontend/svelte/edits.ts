/**
 * What the person at this keyboard did to a Monaco editor.
 *
 * `onDidChangeModelContent` fires for everything: the user typing, a peer's
 * keystroke arriving through y-monaco, a formatter, a chat edit, the binding
 * seeding the model on attach. Focus is a poor way to tell those apart -- it
 * says where the caret is, not who caused the edit, so anything landing while
 * the caret sits here is attributed to this person whether they did it or not.
 *
 * Two signals do better, and this uses both because neither is sufficient on
 * its own:
 *
 *  1. `detailedReasons` -- VS Code tags every model edit with what caused it
 *     (`cursor`/`type`, `cursor`/`paste`, `applyEdits`, `setValue`, `suggest`,
 *     `Chat.applyEdits`, ...). This is the only signal that names the gesture,
 *     and it works before there is any shared document at all. It is also the
 *     fragile half: the field is on the runtime event but absent from the
 *     public typings, so it is read defensively and its absence is survivable.
 *
 *  2. The Yjs transaction origin -- y-monaco applies a peer's edit to the
 *     model from inside a Yjs transaction, so any model change occurring while
 *     a transaction that is NOT this editor's own binding is in flight did not
 *     come from this person. This half is public, stable Yjs API, and it
 *     catches remote edits even if the first signal ever goes away.
 *
 * The Y.Text is optional and attachable later, because the interesting case is
 * an editor that opens on server content and only joins the shared document
 * once the provider has synced. Before it is attached, signal 1 does the work
 * alone and every edit is reported with `shared: false` -- the person is still
 * editing, their edits just are not going anywhere yet.
 */

import type { Doc, Text, Transaction } from "yjs";
import { WithEvents } from "../../../wsfs_suede.with-events-suede";
import type { Editor } from "../../../wsfs_suede.python-monaco-suede";

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
 * A gesture, named.
 *
 * `ran` is the catch-all for edits an editor command made on the person's
 * behalf -- backspace, tab, Enter, delete-word, re-indent -- and `via` carries
 * which. `accepted` is the person taking something the editor offered them: a
 * completion, a snippet, an inline suggestion, a code action. `changed` is the
 * honest answer when the editor did not say: see `reported`.
 */
export type Did =
  | "typed"
  | "pasted"
  | "cut"
  | "composed"
  | "ran"
  | "undid"
  | "redid"
  | "accepted"
  | "changed";

export type UserEdit<D extends Did = Did> = {
  did: D;
  /** Everything this edit inserted, in the order the document reads it. */
  inserted: string;
  /** How much text it removed. */
  removed: number;
  /** The offset of the earliest span it touched. */
  at: number;
  /** The command or trigger behind it, when the editor named one. */
  via?: string;
  /**
   * Whether a shared document was attached, and therefore whether this edit
   * is on its way to everybody else or is still only in this browser.
   */
  shared: boolean;
  /**
   * Whether the editor NAMED the gesture, or it was inferred.
   *
   * True is the normal case. False means `detailedReasons` was not on the
   * event -- a Monaco version that no longer carries it -- and `did` fell back
   * to what the public events could establish, which is much less. Worth
   * asserting on in a test: the day this starts coming back false, the naming
   * above has quietly stopped working.
   */
  reported: boolean;
  /** The model version this edit produced. */
  version: number;
  /** The raw spans, end-of-document first, as Monaco ordered them. */
  changes: readonly ModelChange[];
};

/** Why a change was not reported as the person's. */
export type Ignored =
  | "remote"
  | "programmatic"
  | "reset"
  | "assistant"
  | "unwitnessed";

type Gestures = { [K in Did]: [edit: UserEdit<K>] };

type Events = Gestures & {
  /** Every user edit, whatever the gesture. The one to reach for first. */
  edited: [edit: UserEdit];
  /**
   * A model change that was somebody or something else. Not an error -- this
   * is the majority of traffic in a busy room -- but it is the only window
   * onto what is being filtered out, which is what makes the filtering
   * testable rather than merely trusted.
   */
  ignored: [why: Ignored, event: ContentChanged];
  attached: [text: Text];
  detached: [];
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
 * Whether a Yjs transaction origin is a `MonacoBinding` driving THIS model.
 *
 * Structural rather than `instanceof`, deliberately: it costs no runtime
 * import of y-monaco, and it keeps working if two copies of that module ever
 * end up in the graph, where `instanceof` would quietly answer false and every
 * one of this person's own edits would be discarded as somebody else's.
 */
const bindsModel = (origin: unknown, model: unknown) =>
  typeof origin === "object" &&
  origin !== null &&
  "ytext" in origin &&
  "monacoModel" in origin &&
  (origin as { monacoModel: unknown }).monacoModel === model;

export class UserEdits extends WithEvents<Events> {
  readonly editor: CodeEditor;

  #text: Text | undefined;
  #doc: Doc | undefined;
  #attached: { dispose: () => void }[] = [];

  /**
   * The foreign Yjs transactions currently in flight, innermost last.
   *
   * A stack rather than a flag because an observer may open a transaction of
   * its own while one is being cleaned up. Yjs guarantees the pairing --
   * `afterTransaction` is called through `callAll`, which runs the remaining
   * callbacks even when one throws -- so this cannot be left stuck open by a
   * listener that fails.
   */
  #applying: Transaction[] = [];

  /**
   * A paste announces itself just before the change it causes. Only used when
   * the editor did not name the gesture itself; see `reported`.
   */
  #pasted = false;

  #disposed = false;

  constructor(editor: CodeEditor, text?: Text) {
    super();
    this.editor = editor;
    this.#attached.push(
      editor.onDidPaste(() => (this.#pasted = true)),
      editor.onDidChangeModelContent((event) => this.#changed(event)),
    );
    if (text) this.attach(text);
  }

  /** Whether edits made now will reach anybody else. */
  get shared() {
    return this.#text !== undefined;
  }

  /** The shared text this is watching, if one has been attached. */
  get text() {
    return this.#text;
  }

  /**
   * Starts using the shared document as a second opinion on who edited.
   *
   * Made separate from construction because the editor is worth watching
   * before the room has answered -- the person can type into server content
   * while the provider is still syncing, and those keystrokes are theirs.
   * Attaching later is the same call.
   */
  attach(text: Text) {
    if (this.#disposed || this.#text === text) return this;
    const doc = text.doc;
    if (doc === null)
      throw new Error("Cannot watch a Y.Text that is not in a document");
    this.#unwire();
    this.#text = text;
    this.#doc = doc;
    doc.on("beforeTransaction", this.#opened);
    doc.on("afterTransaction", this.#closed);
    this.fire("attached", text);
    return this;
  }

  /** Goes back to naming edits from the editor alone. */
  detach() {
    if (this.#text === undefined) return this;
    this.#unwire();
    this.fire("detached");
    return this;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const attachment of this.#attached) attachment.dispose();
    this.#attached = [];
    this.#unwire();
    this.clear();
  }

  #unwire() {
    this.#doc?.off("beforeTransaction", this.#opened);
    this.#doc?.off("afterTransaction", this.#closed);
    this.#applying = [];
    this.#text = undefined;
    this.#doc = undefined;
  }

  #opened = (transaction: Transaction) => {
    if (bindsModel(transaction.origin, this.editor.getModel())) return;
    this.#applying.push(transaction);
  };

  #closed = (transaction: Transaction) => {
    const at = this.#applying.indexOf(transaction);
    if (at >= 0) this.#applying.splice(at, 1);
  };

  /**
   * The transaction being applied to this model right now, if any.
   *
   * Anything the model reports while one is open is that transaction reaching
   * the screen, not a person: `local` separates a peer's edit arriving through
   * the provider from this app writing into the shared text itself.
   */
  get #foreign(): Ignored | undefined {
    const applying = this.#applying.at(-1);
    if (applying === undefined) return undefined;
    return applying.local ? "programmatic" : "remote";
  }

  #changed(event: ContentChanged) {
    const pasted = this.#pasted;
    this.#pasted = false;

    // Signal 2 first: it is the one that cannot be fooled, and it is the only
    // one that stays true if the reasons below ever stop being reported.
    const foreign = this.#foreign;
    if (foreign !== undefined) return this.fire("ignored", foreign, event);

    // The whole buffer replaced. `setValue` says the same thing, but this flag
    // is public API and so worth checking on its own.
    if (event.isFlush) return this.fire("ignored", "reset", event);

    // Undo and redo are flagged on the event, and they have to be read before
    // the reasons below: VS Code routes both through a plain `applyEdits`,
    // which is indistinguishable by source from a peer's edit landing.
    const undone = event.isUndoing
      ? "undid"
      : event.isRedoing
        ? "redid"
        : undefined;

    const named = undone
      ? { did: undone as Did }
      : this.#name(event as Reported, pasted);
    if (typeof named === "string") return this.fire("ignored", named, event);

    const edit = this.#describe(event, named);
    this.fire("edited", edit);
    // Fired second, and separately, so a subscriber can take the whole stream
    // or just the one gesture it cares about without filtering.
    this.fire(edit.did, edit as never);
  }

  /** Signal 1, with the fallback for when it is not there. */
  #name(
    event: Reported,
    pasted: boolean,
  ): { did: Did; via?: string; reported?: false } | Ignored {
    const reasons = event.detailedReasons;

    if (reasons === undefined || reasons.length === 0) {
      // No provenance. All that is left is the public surface, which can say
      // that a paste happened and that the caret is here -- the old heuristic,
      // kept only as the floor rather than as the mechanism.
      if (!this.editor.hasTextFocus()) return "unwitnessed";
      return { did: pasted ? "pasted" : "changed", reported: false };
    }

    // One event can carry several reasons. The person's gesture wins if any
    // of them is one; otherwise the first reason explains the refusal.
    let refused: Ignored | undefined;
    for (const reason of reasons) {
      const gesture = gestureOf(reason);
      if (typeof gesture !== "string") return gesture;
      refused ??= gesture;
    }
    return refused ?? "programmatic";
  }

  #describe(
    event: ContentChanged,
    named: { did: Did; via?: string; reported?: false },
  ): UserEdit {
    const { changes } = event;
    // Monaco orders these from the end of the document backwards. Read in
    // reverse they spell what the person actually inserted.
    let inserted = "";
    for (let index = changes.length - 1; index >= 0; index--)
      inserted += changes[index]?.text ?? 0;

    return {
      did: named.did,
      inserted,
      removed: changes.reduce((total, change) => total + change.rangeLength, 0),
      at: changes.at(-1)?.rangeOffset ?? 0,
      ...(named.via === undefined ? {} : { via: named.via }),
      shared: this.shared,
      reported: named.reported !== false,
      version: event.versionId,
      changes,
    };
  }
}

/**
 * Watches one editor and reports what the person using it did.
 *
 * ```ts
 * const edits = watchEdits(editor);          // before the room has answered
 * edits.subscribe({
 *   edited: (edit) => store(edit),
 *   pasted: (edit) => noticeThatMuchArrivedAtOnce(edit.inserted),
 * });
 * provider.once("synced", () => edits.attach(text));   // and now it is shared
 * ```
 *
 * The return value disposes, so it can be handed straight back from `onEditor`.
 */
export const watchEdits = (editor: CodeEditor, text?: Text) =>
  new UserEdits(editor, text);
