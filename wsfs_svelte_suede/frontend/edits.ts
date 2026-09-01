/**
 * What the person at this keyboard did, and how to tell it was them.
 *
 * Every editing surface has the same problem: its change event fires for
 * everything -- the user typing, a peer's keystroke arriving through the
 * shared document, a formatter, a chat edit, the binding seeding the surface
 * on attach. Focus is a poor way to tell those apart; it says where the caret
 * is, not who caused the edit, so anything landing while the caret sits here
 * is attributed to this person whether they did it or not.
 *
 * THE SIGNAL THAT IS HERE is the Yjs transaction origin: a binding applies a
 * peer's edit to the surface from inside a Yjs transaction, so any change
 * occurring while a transaction that is NOT this surface's own binding is in
 * flight did not come from this person. It is public, stable Yjs API, and it
 * is vendor-neutral -- a textarea bound with y-textarea has exactly the same
 * problem and exactly the same answer available.
 *
 * THE SIGNAL THAT IS NOT is whatever the surface itself can say about the
 * gesture. Monaco tags every model edit with what caused it, which is the only
 * signal that names the gesture and the only one that works before there is a
 * shared document at all -- and it is Monaco's, so it lives with Monaco in
 * `wsfs_python_suede`. A surface supplies it by implementing `Naming`.
 *
 * Which half is sufficient matters, because it decides what breaks when the
 * other goes: the Yjs half alone still refuses a peer's edit, so the worst a
 * missing refinement costs is a vaguer `did`. The other way round is the
 * failure with no symptom -- a peer typing would look like this student
 * typing, nobody would ever be detected as stuck, and nothing would fail.
 */

import type { Doc, Text, Transaction } from "yjs";
import { WithEvents } from "../../with-events-suede";

/**
 * A gesture, named.
 *
 * `ran` is the catch-all for edits an editor command made on the person's
 * behalf -- backspace, tab, Enter, delete-word, re-indent -- and `via` carries
 * which. `accepted` is the person taking something the surface offered them: a
 * completion, a snippet, an inline suggestion, a code action. `changed` is the
 * honest answer when the surface did not say.
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

/** Why a change was not reported as the person's. */
export type Ignored =
  | "remote"
  | "programmatic"
  | "reset"
  | "assistant"
  | "unwitnessed";

/** One replaced span, as any surface can describe one. */
export type Span = {
  /** Where in the document it began. */
  at: number;
  /** How much text it removed. */
  removed: number;
  /** What it put there. */
  inserted: string;
};

export type UserEdit<D extends Did = Did> = {
  did: D;
  /** Everything this edit inserted, in the order the document reads it. */
  inserted: string;
  /** How much text it removed. */
  removed: number;
  /** The offset of the earliest span it touched. */
  at: number;
  /** The command or trigger behind it, when the surface named one. */
  via?: string;
  /**
   * Whether a shared document was attached, and therefore whether this edit
   * is on its way to everybody else or is still only in this browser.
   */
  shared: boolean;
  /**
   * Whether the surface NAMED the gesture, or it was inferred.
   *
   * True is the normal case. False means the surface's own signal was not
   * there -- a Monaco version that no longer carries `detailedReasons` -- and
   * `did` fell back to what the neutral half could establish, which is much
   * less. Worth asserting on in a test: the day this starts coming back
   * false, the naming has quietly stopped working.
   */
  reported: boolean;
  /** The surface's own version counter, for a caller that follows one. */
  version: number;
  /** The spans, in document order. */
  changes: readonly Span[];
};

/** What a surface says about one change, before anybody decides whose it was. */
export type Change = {
  spans: readonly Span[];
  version: number;
  /** The whole document was replaced -- a public flag where a surface has one. */
  flushed?: boolean;
  /** Undo and redo, which every surface knows about and no source string does. */
  undone?: "undid" | "redid";
};

/** What a surface's own signal answers: a gesture, or why this was not one. */
export type Named = { did: Did; via?: string; reported?: false } | Ignored;

/** A surface's refinement of `Change` into a gesture. See the module note. */
export type Naming = (change: Change) => Named;

type Gestures = { [K in Did]: [edit: UserEdit<K>] };

export type Events = Gestures & {
  /** Every user edit, whatever the gesture. The one to reach for first. */
  edited: [edit: UserEdit];
  /**
   * A change that was somebody or something else. Not an error -- this is the
   * majority of traffic in a busy room -- but it is the only window onto what
   * is being filtered out, which is what makes the filtering testable rather
   * than merely trusted.
   */
  ignored: [why: Ignored, change: Change];
  attached: [text: Text];
  detached: [];
};

/**
 * Whether a Yjs transaction origin is a binding driving THIS surface.
 *
 * Structural rather than `instanceof`, deliberately: it costs no runtime
 * import of the binding's module, and it keeps working if two copies of that
 * module ever end up in the graph, where `instanceof` would quietly answer
 * false and every one of this person's own edits would be discarded as
 * somebody else's.
 *
 * `ytext` and the model under whichever name the binding gives it -- y-monaco
 * calls it `monacoModel`, another binding will call it something else -- so
 * the property to compare is named by the caller.
 */
export const bindsSurface = (
  origin: unknown,
  surface: unknown,
  named: string,
) =>
  typeof origin === "object" &&
  origin !== null &&
  "ytext" in origin &&
  named in origin &&
  (origin as Record<string, unknown>)[named] === surface;

/**
 * Watching one surface, and refusing everything that was not this person.
 *
 * A surface subclasses this, wires its own change event to `report`, and
 * supplies a `Naming`. Everything below is the half that is the same wherever
 * the text is being typed.
 */
export class Edits extends WithEvents<Events> {
  readonly #naming: Naming;
  readonly #surface: () => unknown;
  readonly #bound: string;

  #text: Text | undefined;
  #doc: Doc | undefined;

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

  #disposed = false;

  constructor(
    naming: Naming,
    { surface, bound }: { surface: () => unknown; bound: string },
  ) {
    super();
    this.#naming = naming;
    this.#surface = surface;
    this.#bound = bound;
  }

  /** Whether edits made now will reach anybody else. */
  get shared() {
    return this.#text !== undefined;
  }

  /** The shared text this is watching, if one has been attached. */
  get text() {
    return this.#text;
  }

  get disposed() {
    return this.#disposed;
  }

  /**
   * Starts using the shared document as a second opinion on who edited.
   *
   * Made separate from construction because the surface is worth watching
   * before the room has answered -- the person can type into server content
   * while the provider is still syncing, and those keystrokes are theirs.
   * Attaching later is the same call.
   */
  attach(text: Text) {
    if (this.#disposed || this.#text === text) return this;
    const doc = text.doc;
    if (doc === null)
      throw new Error("Cannot watch a Y.Text that is not in a document");
    this.unwire();
    this.#text = text;
    this.#doc = doc;
    doc.on("beforeTransaction", this.#opened);
    doc.on("afterTransaction", this.#closed);
    this.fire("attached", text);
    return this;
  }

  /** Goes back to naming edits from the surface alone. */
  detach() {
    if (this.#text === undefined) return this;
    this.unwire();
    this.fire("detached");
    return this;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.unwire();
    this.clear();
  }

  protected unwire() {
    this.#doc?.off("beforeTransaction", this.#opened);
    this.#doc?.off("afterTransaction", this.#closed);
    this.#applying = [];
    this.#text = undefined;
    this.#doc = undefined;
  }

  #opened = (transaction: Transaction) => {
    if (bindsSurface(transaction.origin, this.#surface(), this.#bound)) return;
    this.#applying.push(transaction);
  };

  #closed = (transaction: Transaction) => {
    const at = this.#applying.indexOf(transaction);
    if (at >= 0) this.#applying.splice(at, 1);
  };

  /**
   * The transaction being applied to this surface right now, if any.
   *
   * Anything the surface reports while one is open is that transaction
   * reaching the screen, not a person: `local` separates a peer's edit
   * arriving through the provider from this app writing into the shared text
   * itself.
   */
  protected get foreign(): Ignored | undefined {
    const applying = this.#applying.at(-1);
    if (applying === undefined) return undefined;
    return applying.local ? "programmatic" : "remote";
  }

  /**
   * One change from the surface, attributed or refused.
   *
   * THE ORDER IS THE ARGUMENT. The Yjs origin is asked first because it is the
   * one that cannot be fooled and the only one that stays true if the
   * surface's own signal ever stops being reported.
   */
  protected report(change: Change) {
    const foreign = this.foreign;
    if (foreign !== undefined) return this.fire("ignored", foreign, change);

    // The whole document replaced. A surface's own signal usually says this
    // too, but a public flag is worth checking on its own.
    if (change.flushed) return this.fire("ignored", "reset", change);

    // Undo and redo are read before the surface's signal: Monaco routes both
    // through a plain `applyEdits`, which is indistinguishable by source from
    // a peer's edit landing.
    const named: Named = change.undone
      ? { did: change.undone }
      : this.#naming(change);
    if (typeof named === "string") return this.fire("ignored", named, change);

    const edit = described(change, named, this.shared);
    this.fire("edited", edit);
    // Fired second, and separately, so a subscriber can take the whole stream
    // or just the one gesture it cares about without filtering.
    this.fire(edit.did, edit as never);
  }
}

/** One change and one verdict, put together into what a subscriber reads. */
export const described = (
  change: Change,
  named: { did: Did; via?: string; reported?: false },
  shared: boolean,
): UserEdit => ({
  did: named.did,
  inserted: change.spans.map((span) => span.inserted).join(""),
  removed: change.spans.reduce((total, span) => total + span.removed, 0),
  at: change.spans[0]?.at ?? 0,
  ...(named.via === undefined ? {} : { via: named.via }),
  shared,
  reported: named.reported !== false,
  version: change.version,
  changes: change.spans,
});
