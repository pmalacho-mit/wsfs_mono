/**
 * Making room, and telling the truth when there is none to make.
 *
 * The second half is the one that matters. A sweep can only ever free
 * garbage: work that has not been sent is not discardable, so a store full of
 * it is not a fault to be fixed but a fact to be reported -- and reported as
 * an instruction, because the person can act on it and the client cannot.
 */
import { describe, expect, it } from "vitest";

import { mint } from "../../release/frontend/identity";
import { queue as outbox, type Entry } from "../../release/frontend/outbox";
import {
  collectable,
  crowded,
  sweep,
  type Headroom,
  type Sweepable,
} from "../../release/frontend/reclaim";
import type { Submitted } from "../../release/frontend/contract";

const WORKSPACE = "alpha";
const OTHER = "beta";

/** A queued row naming a payload, as the outbox itself would make one. */
const row = (workspace: string, content: string, basis?: string) => {
  const queue = outbox();
  const captured = queue.capture(
    {
      op: "write",
      transaction: mint(),
      id: mint(),
      content_version: mint(),
      content: { type: "text", content: "" },
    } as Submitted,
    content,
    basis,
  );
  return { workspace, entry: captured as Entry };
};

const payload = (workspace: string, digest: string, size = 100, at?: number) => ({
  workspace,
  digest,
  size,
  at,
});

/** A store whose contents the test states outright. */
const holding = (
  rows: { workspace: string; entry: Entry }[],
  payloads: ReturnType<typeof payload>[],
): Sweepable & { dropped: { workspace: string; digest: string }[] } => {
  const dropped: { workspace: string; digest: string }[] = [];
  return {
    dropped,
    queued: async () => rows,
    payloads: async () => payloads,
    drop: async (of) => void dropped.push(...of),
  };
};

const room = (usage: number, quota = 100): Headroom => ({ usage, quota });

describe("what a sweep may take", () => {
  it("takes payloads nothing names", () => {
    const kept = mint();
    const garbage = mint();
    const found = collectable(
      [payload(WORKSPACE, kept, 100, 1), payload(WORKSPACE, garbage, 100, 1)],
      [row(WORKSPACE, kept)],
      5,
    );
    expect(found.map(({ digest }) => digest)).toEqual([garbage]);
  });

  it("will not take one workspace's payload because another does not name it", () => {
    /**
     * The store is scoped by workspace and so is every digest in it. Matching
     * on the digest alone would let a queue in one workspace be destroyed by
     * a sweep reading rows from another.
     */
    const shared = mint();
    const found = collectable(
      [payload(WORKSPACE, shared, 100, 1), payload(OTHER, shared, 100, 1)],
      [row(WORKSPACE, shared)],
      5,
    );
    expect(found.map(({ workspace }) => workspace)).toEqual([OTHER]);
  });

  it("leaves alone anything written since the pass began", () => {
    /**
     * The window every payload passes through: stored, and not yet named by
     * the row that is about to name it. In another tab that row is on its way
     * and this one cannot see it, so age is the only safe answer.
     */
    const arriving = mint();
    const found = collectable([payload(WORKSPACE, arriving, 100, 9)], [], 5);
    expect(found).toEqual([]);
  });

  it("takes a payload from before timestamps existed", () => {
    const old = mint();
    const found = collectable([payload(WORKSPACE, old, 100)], [], 5);
    expect(found.map(({ digest }) => digest)).toEqual([old]);
  });

  it("keeps the bytes a chained write is a delta against", () => {
    /**
     * A queued delta names two payloads: its own, and the one it is a
     * difference from. Forgetting the second makes the first unreadable, and
     * that is the work.
     */
    const head = mint();
    const delta = mint();
    const chained = row(WORKSPACE, delta, mint());
    chained.entry.basis!.content = head;
    const found = collectable(
      [payload(WORKSPACE, head, 100, 1), payload(WORKSPACE, delta, 10, 1)],
      [chained],
      5,
    );
    expect(found).toEqual([]);
  });
});

describe("what a sweep says afterwards", () => {
  it("says nothing happened when there was nothing to do", async () => {
    const store = holding([], []);
    const found = await sweep(store, async () => room(10), () => 5);
    expect(found).toEqual({ phase: "clear" });
  });

  it("reports what it freed", async () => {
    const garbage = mint();
    const store = holding([], [payload(WORKSPACE, garbage, 4096, 1)]);
    const found = await sweep(store, async () => room(10), () => 5);
    expect(found).toEqual({ phase: "freed", freed: 4096 });
    expect(store.dropped).toEqual([{ workspace: WORKSPACE, digest: garbage }]);
  });

  it("says it is short, and where the work is, when nothing may be taken", async () => {
    /**
     * The answer this exists for. Everything left is unsent work, so no
     * further pass will help -- and naming the workspaces is what turns that
     * from an apology into something the person can act on.
     */
    const mine = mint();
    const theirs = mint();
    const store = holding(
      [row(WORKSPACE, mine), row(OTHER, theirs)],
      [payload(WORKSPACE, mine, 900, 1), payload(OTHER, theirs, 100, 1)],
    );
    const found = await sweep(store, async () => room(99), () => 5);
    expect(found).toEqual({
      phase: "short",
      holding: 1000,
      workspaces: [WORKSPACE, OTHER],
    });
    expect(store.dropped).toEqual([]);
  });

  it("counts only what survived when it is still short after freeing", async () => {
    const mine = mint();
    const garbage = mint();
    const store = holding(
      [row(WORKSPACE, mine)],
      [payload(WORKSPACE, mine, 700, 1), payload(WORKSPACE, garbage, 300, 1)],
    );
    const found = await sweep(store, async () => room(99), () => 5);
    expect(found).toEqual({
      phase: "short",
      holding: 700,
      workspaces: [WORKSPACE],
    });
    expect(store.dropped).toEqual([{ workspace: WORKSPACE, digest: garbage }]);
  });
});

describe("how full is full", () => {
  it("treats a browser that will not say as unknown rather than fine", () => {
    expect(crowded(undefined)).toBe(false);
    expect(crowded({ usage: 90, quota: 100 })).toBe(true);
    expect(crowded({ usage: 10, quota: 100 })).toBe(false);
    /** A quota of nothing is not a store that is 100% full; it is no answer. */
    expect(crowded({ usage: 0, quota: 0 })).toBe(false);
  });
});
