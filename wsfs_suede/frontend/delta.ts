/**
 * The difference between two versions of a text, as Yjs-shaped operations.
 *
 * A port of `release/backend/diff.py`, and deliberately the same vocabulary:
 * `retain` skips, `insert` adds, and `delete` carries the text it removed
 * rather than its length -- which is what makes a delta invertible, and
 * therefore a chain of them walkable in both directions.
 *
 * One thing the Python has to work for and this gets free. Yjs counts
 * positions in UTF-16 code units, so `diff.py` encodes to `utf-16-le` and
 * counts bytes; a JavaScript string is already UTF-16, so `length` is the
 * number Yjs wants. The two agree until the first emoji, and there the Python
 * has to be careful and this does not.
 *
 * Why not a prefix/suffix trim, which is shorter and was here first: because
 * one write can change several places at once. Replacing everything between
 * the first difference and the last says a one-line change to the top of a
 * file and a one-line change to the bottom are one edit spanning the whole
 * file -- which is wrong about what happened, throws away every cursor in
 * between, and gives a merge nothing to work with.
 */

export type Retain = { retain: number };
export type Insert = { insert: string };
/** The removed text, not its length -- see the note about inverting above. */
export type Remove = { delete: string };

export type Operation = Retain | Insert | Remove;
export type Delta = Operation[];

/**
 * Beyond this, finding the SHORTEST edit script costs more than the edit is
 * worth. Myers is O(ND) in the length and the number of differences, so two
 * texts with nothing in common is the case that bites -- and that case is a
 * replacement, which is what this falls back to saying.
 */
const WORTH_DIFFING = 4_000;

type Kind = "=" | "-" | "+";
type Run<T> = { kind: Kind; items: T[] };

/**
 * Myers' shortest edit script, over anything comparable by `===`.
 *
 * Used twice: once over LINES, which is what makes the result readable and
 * cheap for code, and again over the CHARACTERS of a line that was replaced,
 * so that changing a word inside a line does not read as replacing the line.
 */
const script = <T>(from: readonly T[], to: readonly T[]): Run<T>[] => {
  const n = from.length;
  const m = to.length;
  const trace: Map<number, number>[] = [];
  let v = new Map<number, number>([[1, 0]]);

  for (let d = 0; d <= n + m; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const below = v.get(k - 1) ?? 0;
      const above = v.get(k + 1) ?? 0;
      let x = k === -d || (k !== d && below < above) ? above : below + 1;
      let y = x - k;
      while (x < n && y < m && from[x] === to[y]) (x += 1), (y += 1);
      v.set(k, x);
      if (x >= n && y >= m) return walked(trace, from, to, d);
    }
    v = new Map(v);
  }
  /* c8 ignore next */
  throw new Error("no edit script exists, which cannot happen");
};

/** The path back through the traces, turned into runs of one kind each. */
const walked = <T>(
  trace: readonly Map<number, number>[],
  from: readonly T[],
  to: readonly T[],
  distance: number,
): Run<T>[] => {
  const runs: Run<T>[] = [];
  const put = (kind: Kind, item: T) => {
    const last = runs[0];
    if (last?.kind === kind) last.items.unshift(item);
    else runs.unshift({ kind, items: [item] });
  };

  let x = from.length;
  let y = to.length;

  for (let d = distance; d > 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const below = v.get(k - 1) ?? 0;
    const above = v.get(k + 1) ?? 0;
    const previous = k === -d || (k !== d && below < above) ? k + 1 : k - 1;
    const startX = v.get(previous) ?? 0;
    const startY = startX - previous;

    while (x > startX && y > startY) (x -= 1), (y -= 1), put("=", from[x]!);
    if (x > startX) (x -= 1), put("-", from[x]!);
    else if (y > startY) (y -= 1), put("+", to[y]!);
  }
  while (x > 0) (x -= 1), (y -= 1), put("=", from[x]!);

  return runs;
};

/** Splits keeping the newlines, so joining the pieces rebuilds the text. */
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

/**
 * A line replaced by another line is usually a line EDITED, so the two are
 * compared again by character. Anything else is left as it is: a line that
 * only appeared or only went has nothing to compare against.
 */
const refined = (runs: Run<string>[]): Run<string>[] => {
  const out: Run<string>[] = [];
  for (let at = 0; at < runs.length; at += 1) {
    const removed = runs[at]!;
    const added = runs[at + 1];
    if (removed.kind !== "-" || added?.kind !== "+") {
      out.push(removed);
      continue;
    }
    const was = removed.items.join("");
    const now = added.items.join("");
    for (const run of script([...was], [...now]))
      out.push({ kind: run.kind, items: [run.items.join("")] });
    at += 1;
  }
  return out;
};

const asOperation = (kind: Kind, text: string): Operation =>
  kind === "=" ? { retain: text.length } : kind === "-" ? { delete: text } : { insert: text };

/** Runs of the same operation are one operation. */
const merged = (delta: Delta, operation: Operation): Delta => {
  const last = delta[delta.length - 1];
  if (last !== undefined && "retain" in last && "retain" in operation)
    last.retain += operation.retain;
  else if (last !== undefined && "insert" in last && "insert" in operation)
    last.insert += operation.insert;
  else if (last !== undefined && "delete" in last && "delete" in operation)
    last.delete += operation.delete;
  else delta.push(operation);
  return delta;
};

/** The delta taking `before` to `after`. */
export const deltaBetween = (before: string, after: string): Delta => {
  if (before === after) return [];

  // Trimmed first, so the expensive part only sees what actually differs --
  // and typing at the end of a file leaves it almost nothing to look at.
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end += 1;

  const was = before.slice(start, before.length - end);
  const now = after.slice(start, after.length - end);

  const middle: Run<string>[] =
    was.length + now.length > WORTH_DIFFING
      ? [
          ...(was ? [{ kind: "-" as const, items: [was] }] : []),
          ...(now ? [{ kind: "+" as const, items: [now] }] : []),
        ]
      : refined(script(lines(was), lines(now)));

  const delta: Delta = [];
  if (start > 0) merged(delta, { retain: start });
  for (const run of middle) {
    const text = run.items.join("");
    if (text) merged(delta, asOperation(run.kind, text));
  }
  if (end > 0) merged(delta, { retain: end });
  return delta;
};

/** `base` with `delta` applied. Base the delta does not reach is kept. */
export const applyDelta = (base: string, delta: Delta): string => {
  let at = 0;
  let out = "";
  for (const operation of delta) {
    if ("retain" in operation) {
      out += base.slice(at, at + operation.retain);
      at += operation.retain;
    } else if ("insert" in operation) {
      out += operation.insert;
    } else {
      const was = base.slice(at, at + operation.delete.length);
      if (was !== operation.delete)
        throw new Error(`delete mismatch: expected ${operation.delete}, found ${was}`);
      at += operation.delete.length;
    }
  }
  return out + base.slice(at);
};

/** The delta undoing `delta` -- inserts become deletes, and the other way. */
export const invertDelta = (delta: Delta): Delta =>
  delta.map((operation) =>
    "retain" in operation
      ? { retain: operation.retain }
      : "insert" in operation
        ? { delete: operation.insert }
        : { insert: operation.delete },
  );

/** What a Y.Text needs doing to it, in the order it has to be done. */
export type Edit =
  | { at: number; insert: string }
  | { at: number; remove: number };

/**
 * The same delta as positions in the text it applies to.
 *
 * Walked front to back, and a delete does not advance the cursor because the
 * text after it has just moved back to where the cursor already is.
 */
export const editsFor = (delta: Delta): Edit[] => {
  const edits: Edit[] = [];
  let at = 0;
  for (const operation of delta) {
    if ("retain" in operation) at += operation.retain;
    else if ("insert" in operation) {
      edits.push({ at, insert: operation.insert });
      at += operation.insert.length;
    } else edits.push({ at, remove: operation.delete.length });
  }
  return edits;
};
