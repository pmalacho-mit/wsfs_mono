/**
 * Who edited, decided by the half of the answer that is vendor-neutral.
 *
 * THE FAILURE THIS GUARDS AGAINST HAS NO SYMPTOM. If the Yjs half stops
 * working, a peer typing looks like this student typing, nobody is ever
 * detected as stuck, and nothing fails -- the experiment just quietly stops
 * finding anything. So it is asserted directly rather than through anything
 * that would notice second-hand.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  Edits,
  bindsSurface,
  described,
  type Change,
  type Named,
  type UserEdit,
} from "../../../wsfs_svelte_suede/frontend/edits";

/** A surface that reports what a test tells it to, and nothing else. */
class Surface extends Edits {
  readonly seen: UserEdit[] = [];
  readonly refused: string[] = [];

  constructor(
    readonly model: object,
    naming: Named = { did: "typed" },
  ) {
    super(() => naming, { surface: () => model, bound: "monacoModel" });
    this.subscribe({
      edited: (edit) => void this.seen.push(edit),
      ignored: (why) => void this.refused.push(why),
    });
  }

  reportEdit(change: Partial<Change> = {}) {
    this.report({
      spans: [{ at: 0, removed: 0, inserted: "x" }],
      version: 1,
      ...change,
    });
  }
}

const shared = () => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  return { doc, text };
};

describe("the Yjs transaction origin", () => {
  it("refuses a change that lands while a peer's update is being applied", () => {
    const model = {};
    const { doc, text } = shared();
    const surface = new Surface(model);
    surface.attach(text);

    /**
     * A peer's edit arrives as an UPDATE from elsewhere, which is the whole
     * point: `applyUpdate` opens a transaction Yjs marks as not local, and
     * that flag is what separates somebody else's typing from this app's own
     * writes into the shared text.
     */
    const elsewhere = new Y.Doc();
    elsewhere.getText("content").insert(0, "theirs");

    /** What the binding would report while that update was reaching the screen. */
    doc.on("beforeTransaction", () => surface.reportEdit());
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(elsewhere));

    expect(surface.refused).toEqual(["remote"]);
    expect(surface.seen).toEqual([]);
  });

  it("lets this person's own binding through", () => {
    const model = {};
    const { doc, text } = shared();
    const surface = new Surface(model);
    surface.attach(text);

    doc.on("beforeTransaction", () => surface.reportEdit());
    /** The origin a binding driving THIS model presents. */
    doc.transact(() => text.insert(0, "mine"), {
      ytext: text,
      monacoModel: model,
    });

    expect(surface.refused).toEqual([]);
    expect(surface.seen.map((edit) => edit.did)).toEqual(["typed"]);
  });

  it("names this app's own writes into the shared text as programmatic", () => {
    const { doc, text } = shared();
    const surface = new Surface({});
    surface.attach(text);

    doc.on("beforeTransaction", () => surface.reportEdit());
    /** A local transaction that is not the binding's -- `become`, say. */
    doc.transact(() => text.insert(0, "carried in"));

    expect(surface.refused).toEqual(["programmatic"]);
  });

  it("still attributes when there is no shared document at all", () => {
    const surface = new Surface({});
    surface.reportEdit();
    expect(surface.seen).toHaveLength(1);
    /**
     * The person is still editing; their edits just are not going anywhere
     * yet. Anything counting activity has to hear these.
     */
    expect(surface.seen[0]?.shared).toBe(false);
  });

  it("says so when a shared document is attached", () => {
    const { text } = shared();
    const surface = new Surface({});
    surface.attach(text);
    surface.reportEdit();
    expect(surface.seen[0]?.shared).toBe(true);
  });
});

describe("the surface's own signal", () => {
  it("is not needed for the neutral half to do its work", () => {
    /**
     * `reported: false` is what a surface says when its own signal was not
     * there. The edit is still this person's, and the day this stops being
     * survivable the detector goes deaf.
     */
    const surface = new Surface({}, { did: "changed", reported: false });
    surface.reportEdit();
    expect(surface.seen[0]?.reported).toBe(false);
    expect(surface.seen[0]?.did).toBe("changed");
  });

  it("can refuse a change the neutral half would have allowed", () => {
    const surface = new Surface({}, "assistant");
    surface.reportEdit();
    expect(surface.refused).toEqual(["assistant"]);
  });

  it("is not consulted about undo or redo", () => {
    /**
     * Monaco routes both through a plain `applyEdits`, which is
     * indistinguishable by source from a peer's edit landing -- so the flag
     * on the event wins.
     */
    const surface = new Surface({}, "assistant");
    surface.reportEdit({ undone: "undid" });
    expect(surface.seen.map((edit) => edit.did)).toEqual(["undid"]);
  });

  it("is not consulted about a whole-document replacement", () => {
    const surface = new Surface({});
    surface.reportEdit({ flushed: true });
    expect(surface.refused).toEqual(["reset"]);
  });
});

describe("bindsSurface", () => {
  it("matches structurally, so two copies of the binding's module still work", () => {
    const model = {};
    expect(bindsSurface({ ytext: {}, monacoModel: model }, model, "monacoModel"))
      .toBe(true);
  });

  it("does not match a binding driving a different surface", () => {
    expect(bindsSurface({ ytext: {}, monacoModel: {} }, {}, "monacoModel"))
      .toBe(false);
  });

  it("does not match something that merely has the property", () => {
    const model = {};
    expect(bindsSurface({ monacoModel: model }, model, "monacoModel")).toBe(false);
  });
});

describe("what a subscriber is handed", () => {
  it("reads the spans in document order", () => {
    const change: Change = {
      spans: [
        { at: 3, removed: 0, inserted: "one" },
        { at: 10, removed: 2, inserted: "two" },
      ],
      version: 7,
    };
    expect(described(change, { did: "typed" }, true)).toEqual({
      did: "typed",
      inserted: "onetwo",
      removed: 2,
      at: 3,
      shared: true,
      reported: true,
      version: 7,
      changes: change.spans,
    });
  });
});
