/**
 * A plain text area, bound to a shared document.
 *
 * THE DEFAULT EDITOR, and deliberately the least capable thing that is
 * correct. No language services, no gutter, no completions -- what it has is
 * the three properties any editor of a wsfs file must have:
 *
 *  1. it binds to the ROOM's document rather than one of its own, because a
 *     room outlives its providers and a document the editor made is thrown
 *     away with the editor;
 *  2. it reports edits before a document is bound, because the person is
 *     still editing and their edits just are not going anywhere yet;
 *  3. it never diffs the file into the document -- only the server carries
 *     text into a room, and an editor that types the difference in creates
 *     new characters, so the file ends up saying everything twice.
 *
 * The binding is written out rather than taken from a library because what a
 * binding must do is small and the half that is easy to get wrong is already
 * solved: the element's changes reach the document as EDITS, and `become`
 * does that properly. `text.delete(0, length); text.insert(0, next)` merges
 * with a peer's typing into nonsense.
 */
import type * as Y from "yjs";

import { Edits, type Change, type Named, type Span } from "./edits";
import type { Editor, Pressed } from "./editor";

/**
 * What the person did, as much as a text area can say.
 *
 * `input` events name the gesture in `inputType`, which is the standard's
 * version of the signal Monaco carries in `detailedReasons`: less detailed,
 * and enough to tell typing from pasting from an undo.
 */
const GESTURES: Record<string, Named> = {
  insertText: { did: "typed" },
  insertLineBreak: { did: "typed" },
  insertParagraph: { did: "typed" },
  insertCompositionText: { did: "composed" },
  insertFromPaste: { did: "pasted" },
  insertFromDrop: { did: "pasted" },
  deleteByCut: { did: "cut" },
  historyUndo: { did: "undid" },
  historyRedo: { did: "redid" },
};

const gestureOf = (inputType: string): Named =>
  GESTURES[inputType] ??
  (inputType.startsWith("delete") ? { did: "typed" } : { did: "changed" });

class TextareaEdits extends Edits {
  #inputType = "";

  constructor(binding: object) {
    super(() => gestureOf(this.#inputType), {
      surface: () => binding,
      /** What this binding calls the element it drives -- see `bindsSurface`. */
      bound: "element",
    });
  }

  saw(inputType: string, change: Change) {
    this.#inputType = inputType;
    this.report(change);
  }
}

/**
 * The one span an `input` event changed, recovered by comparing.
 *
 * A text area's event does not say WHERE it changed, only that it did, so the
 * common prefix and the common suffix bracket everything that moved.
 */
const spanBetween = (before: string, after: string): Span => {
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < shortest - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    at: start,
    removed: before.length - start - tail,
    inserted: after.slice(start, after.length - tail),
  };
};

/** One text area, bound to one shared document. */
export class TextareaBinding implements Editor {
  readonly element: HTMLTextAreaElement;
  readonly edits: TextareaEdits;

  #document: Y.Text | undefined;
  #lastSeen: string;
  #keyListeners = new Set<(pressed: Pressed) => void>();
  #undo: (() => void)[] = [];

  constructor(element: HTMLTextAreaElement, showing: string) {
    this.element = element;
    this.element.value = showing;
    this.#lastSeen = showing;
    this.edits = new TextareaEdits(this);
    this.#watchTheElement();
  }

  text() {
    return this.#document?.toString() ?? this.element.value;
  }

  replace(next: string) {
    this.element.value = next;
    this.#lastSeen = next;
  }

  keys(listener: (pressed: Pressed) => void) {
    this.#keyListeners.add(listener);
    return () => void this.#keyListeners.delete(listener);
  }

  /** Bind to the room's document. Called once, when the room has synced. */
  bind(document: Y.Text) {
    if (this.#document === document) return;
    this.#document = document;
    this.edits.attach(document);
    this.#watchTheDocument(document);
    this.#showWhatTheDocumentSays();
  }

  dispose() {
    for (const undo of this.#undo) undo();
    this.#undo = [];
    this.#keyListeners.clear();
    this.edits.dispose();
  }

  #watchTheElement() {
    const typed = (event: Event) => this.#personTyped(event as InputEvent);
    const pressed = (event: KeyboardEvent) => this.#personPressed(event);
    this.element.addEventListener("input", typed);
    this.element.addEventListener("keydown", pressed);
    this.#undo.push(() => {
      this.element.removeEventListener("input", typed);
      this.element.removeEventListener("keydown", pressed);
    });
  }

  #watchTheDocument(document: Y.Text) {
    const changed = (_: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === this) return;
      this.#showWhatTheDocumentSays();
    };
    document.observe(changed);
    this.#undo.push(() => document.unobserve(changed));
  }

  #personTyped(event: InputEvent) {
    const span = spanBetween(this.#lastSeen, this.element.value);
    this.#lastSeen = this.element.value;
    this.#carryIntoTheDocument(span);
    this.edits.saw(event.inputType ?? "", {
      spans: [span],
      version: this.#lastSeen.length,
    });
  }

  /**
   * Tagged with this binding as the transaction origin, which is what
   * `edits.ts` looks for: without it, this person's own typing coming back
   * through the document would be refused as somebody else's.
   */
  #carryIntoTheDocument(span: Span) {
    const document = this.#document;
    if (document === undefined) return;
    document.doc?.transact(() => {
      if (span.removed > 0) document.delete(span.at, span.removed);
      if (span.inserted) document.insert(span.at, span.inserted);
    }, this);
  }

  /**
   * The caret is restored rather than left at the end.
   *
   * A text area's selection is an offset into its value, so replacing the
   * value puts the caret last. Restoring it is not perfect -- somebody else's
   * insertion above the caret shifts it -- but it is the difference between an
   * editable surface and one that fights the person using it.
   */
  #showWhatTheDocumentSays() {
    const next = this.#document?.toString();
    if (next === undefined || next === this.element.value) return;
    const { selectionStart, selectionEnd } = this.element;
    this.element.value = next;
    this.#lastSeen = next;
    this.element.setSelectionRange(
      Math.min(selectionStart, next.length),
      Math.min(selectionEnd, next.length),
    );
  }

  #personPressed(event: KeyboardEvent) {
    const pressed: Pressed = {
      key: event.key,
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
