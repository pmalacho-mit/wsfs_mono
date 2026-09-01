/**
 * A plain text area, bound to a shared document.
 *
 * THE DEFAULT SURFACE, and deliberately the least capable thing that is
 * correct. No language services, no gutter, no completions -- what it has is
 * the three properties `surface.ts` says a surface must have, which is what
 * makes a file collaboratively editable without an IDE.
 *
 * THE BINDING IS WRITTEN OUT rather than taken from a library, and the reason
 * is worth stating: what a binding must do is apply the document's changes to
 * the element without moving the caret, and apply the element's changes to the
 * document as EDITS rather than as a value. The second half is the one a naive
 * binding gets wrong -- `text.delete(0, length); text.insert(0, next)` merges
 * with a peer's typing into nonsense -- and `become` already does it properly.
 *
 * EVERY CHANGE THIS MAKES TO THE DOCUMENT IS TAGGED with the binding itself as
 * the transaction origin, which is exactly what `edits.ts` looks for: without
 * it, this person's own typing coming back through the document would be
 * refused as somebody else's.
 */
import type * as Y from "yjs";

import { Edits, type Change, type Named } from "./edits";
import type { Editing, Opening, Pressed } from "./surface";

/**
 * What the person did, as much as a textarea can say.
 *
 * `input` events name the gesture in `inputType`, which is the standard's
 * version of the signal Monaco carries in `detailedReasons` -- less detailed,
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
  GESTURES[inputType] ?? { did: inputType.startsWith("delete") ? "typed" : "changed" };

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
 * One replaced span, worked out from what the element said before and after.
 *
 * A textarea's `input` event does not say WHERE it changed, only that it did,
 * so the span is recovered by comparing -- the common prefix and the common
 * suffix bracket everything that moved.
 */
const spanBetween = (before: string, after: string) => {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
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

export class TextareaEditing implements Editing {
  #element: HTMLTextAreaElement | undefined = $state(undefined);
  #text: Y.Text | undefined = $state(undefined);
  #held: string;
  #path: string;
  readonly readonly: boolean;

  #edits: TextareaEdits | undefined = $state(undefined);
  #pressed = new Set<(key: Pressed) => void>();
  #stop: (() => void)[] = [];

  constructor(file: Opening) {
    this.#held = file.content;
    this.#path = $state(file.path);
    this.readonly = file.readonly;
  }

  get path() {
    return this.#path;
  }

  get element() {
    return this.#element;
  }

  get edits(): Edits | undefined {
    return this.#edits;
  }

  value() {
    return this.#text?.toString() ?? this.#element?.value ?? this.#held;
  }

  bound() {
    return this.#text;
  }

  replace(value: string) {
    this.#held = value;
    if (this.#element !== undefined) this.#element.value = value;
  }

  moved(path: string) {
    this.#path = path;
  }

  bind(text: Y.Text) {
    if (this.#text === text) return;
    this.#text = text;
    this.#edits?.attach(text);
    this.#observe();
    this.#show();
  }

  keys(pressed: (key: Pressed) => void) {
    this.#pressed.add(pressed);
    return () => void this.#pressed.delete(pressed);
  }

  /** Called by the view when the element it draws is in the document. */
  mount(element: HTMLTextAreaElement) {
    this.#element = element;
    element.value = this.value();
    this.#edits = new TextareaEdits(this);
    if (this.#text !== undefined) this.#edits.attach(this.#text);
    this.#watch(element);
    this.#observe();
    return () => this.unmount();
  }

  unmount() {
    for (const stop of this.#stop) stop();
    this.#stop = [];
    this.#edits?.dispose();
    this.#edits = undefined;
    this.#element = undefined;
  }

  dispose() {
    this.unmount();
    this.#pressed.clear();
    this.#text = undefined;
  }

  #watch(element: HTMLTextAreaElement) {
    let before = element.value;
    const typed = (event: Event) => {
      const after = element.value;
      const span = spanBetween(before, after);
      before = after;
      this.#carry(span);
      this.#edits?.saw((event as InputEvent).inputType ?? "", {
        spans: [span],
        version: after.length,
      });
    };
    const key = (event: KeyboardEvent) => this.#told(event);
    element.addEventListener("input", typed);
    element.addEventListener("keydown", key);
    this.#stop.push(() => {
      element.removeEventListener("input", typed);
      element.removeEventListener("keydown", key);
    });
  }

  /**
   * The person's edit, into the shared text as an edit.
   *
   * Tagged with this binding as the origin so that the observer below knows
   * not to write it back onto the element it came from.
   */
  #carry(span: { at: number; removed: number; inserted: string }) {
    const text = this.#text;
    if (text === undefined) return;
    text.doc?.transact(() => {
      if (span.removed > 0) text.delete(span.at, span.removed);
      if (span.inserted) text.insert(span.at, span.inserted);
    }, this);
  }

  #observing: (() => void) | undefined;

  #observe() {
    const text = this.#text;
    if (text === undefined || this.#element === undefined) return;
    this.#observing?.();
    const changed = (_: unknown, transaction: { origin: unknown }) => {
      if (transaction.origin === this) return;
      this.#show();
    };
    text.observe(changed);
    this.#observing = () => text.unobserve(changed);
    this.#stop.push(this.#observing);
  }

  /**
   * The document, onto the element, without moving the caret.
   *
   * A textarea's selection is an offset into its value, so replacing the value
   * puts the caret at the end. Restoring it is not perfect -- somebody else's
   * insertion above the caret shifts it -- but it is the difference between an
   * editable surface and one that fights the person using it.
   */
  #show() {
    const element = this.#element;
    const text = this.#text;
    if (element === undefined || text === undefined) return;
    const next = text.toString();
    if (element.value === next) return;
    const { selectionStart, selectionEnd } = element;
    element.value = next;
    element.setSelectionRange(
      Math.min(selectionStart, next.length),
      Math.min(selectionEnd, next.length),
    );
  }

  #told(event: KeyboardEvent) {
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
    for (const listener of this.#pressed) listener(pressed);
  }
}
