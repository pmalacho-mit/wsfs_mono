/**
 * The delta between two texts, and whether it says what happened.
 *
 * One property carries most of this: applying the delta to `before` has to
 * produce `after`, whatever the two are. The rest is about SHAPE -- a delta
 * that is correct but says "replace the file" would pass the round trip and
 * still be the thing this replaced.
 */
import { describe, expect, it } from "vitest";

import {
  applyDelta,
  deltaBetween,
  editsFor,
  invertDelta,
} from "../../release/frontend/delta";

/** Applying the edits by hand, the way a Y.Text has them applied. */
const edited = (base: string, delta: ReturnType<typeof deltaBetween>): string => {
  let text = base;
  for (const edit of editsFor(delta))
    text =
      "insert" in edit
        ? text.slice(0, edit.at) + edit.insert + text.slice(edit.at)
        : text.slice(0, edit.at) + text.slice(edit.at + edit.remove);
  return text;
};

const kinds = (delta: ReturnType<typeof deltaBetween>) =>
  delta.map((op) => Object.keys(op)[0]).join(" ");

describe("the delta between two texts", () => {
  it("takes before to after, and back again", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nTWO\nthree\n";
    const delta = deltaBetween(before, after);

    expect(applyDelta(before, delta)).toBe(after);
    expect(applyDelta(after, invertDelta(delta))).toBe(before);
  });

  it("says nothing when nothing changed", () => {
    expect(deltaBetween("same", "same")).toEqual([]);
  });

  it("leaves the parts that did not move alone", () => {
    // The whole point: two edits at opposite ends of a file are TWO edits,
    // not one that swallows everything between them.
    const before = "first\nmiddle\nmiddle\nmiddle\nlast\n";
    const after = "FIRST\nmiddle\nmiddle\nmiddle\nLAST\n";
    const delta = deltaBetween(before, after);

    expect(applyDelta(before, delta)).toBe(after);
    // A retained run survives in the middle, which a single replacement
    // could not have produced.
    const retained = delta.filter((op) => "retain" in op);
    expect(retained.length).toBeGreaterThanOrEqual(2);
    expect(delta.some((op) => "delete" in op && op.delete.includes("middle"))).toBe(false);
  });

  it("edits inside a line rather than replacing the line", () => {
    const delta = deltaBetween("value = compute(a, b)\n", "value = compute(a, c)\n");
    expect(applyDelta("value = compute(a, b)\n", delta)).toBe("value = compute(a, c)\n");
    // One character in, one character out -- not twenty-two of each.
    for (const op of delta) {
      if ("delete" in op) expect(op.delete.length).toBeLessThanOrEqual(2);
      if ("insert" in op) expect(op.insert.length).toBeLessThanOrEqual(2);
    }
  });

  it("handles the ends: from nothing, to nothing, and appended to", () => {
    expect(applyDelta("", deltaBetween("", "hello"))).toBe("hello");
    expect(applyDelta("hello", deltaBetween("hello", ""))).toBe("");
    const appended = deltaBetween("a\n", "a\nb\n");
    expect(applyDelta("a\n", appended)).toBe("a\nb\n");
    expect(kinds(appended)).toBe("retain insert");
  });

  it("counts positions the way Yjs does, which is UTF-16 units", () => {
    // An emoji is two units, and a delta that counted it as one would put
    // everything after it in the wrong place.
    const before = "a😀b";
    const after = "a😀B";
    const delta = deltaBetween(before, after);
    expect(applyDelta(before, delta)).toBe(after);
    expect(edited(before, delta)).toBe(after);
  });

  it("survives whatever it is given", () => {
    const alphabet = "ab\n";
    const random = (length: number) =>
      Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

    for (let round = 0; round < 300; round += 1) {
      const before = random(Math.floor(Math.random() * 40));
      const after = random(Math.floor(Math.random() * 40));
      const delta = deltaBetween(before, after);
      expect(applyDelta(before, delta), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(after);
      // And the positional form has to agree with the textual one, because
      // the positional form is the one a Y.Text actually gets.
      expect(edited(before, delta), `edits for ${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(after);
      expect(applyDelta(after, invertDelta(delta))).toBe(before);
    }
  });

  it("gives up on shortest rather than on correct, past a size", () => {
    const before = "x".repeat(5_000);
    const after = "y".repeat(5_000);
    const delta = deltaBetween(before, after);
    expect(applyDelta(before, delta)).toBe(after);
    expect(kinds(delta)).toBe("delete insert");
  });
});
