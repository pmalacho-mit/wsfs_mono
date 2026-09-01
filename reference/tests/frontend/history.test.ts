/**
 * Two halves of one history.
 *
 * The server holds what it accepted and what it declined. This client holds
 * what it has not managed to send -- and that half is the one a user asking
 * "where did my work go" most often means, because the reason they are asking
 * is usually that it has not gone anywhere.
 */
import { describe, expect, it } from "vitest";

import { mint } from "../../release/frontend/identity";
import { merged, type Told } from "../../release/frontend/history";
import { queue as outbox } from "../../release/frontend/outbox";
import type { Submitted, Version_ } from "../../release/frontend/contract";

const ENTRY = mint();

const queued = (id = ENTRY) => {
  const queue = outbox();
  const one = queue.capture({
    op: "write",
    transaction: mint(),
    id,
    content_version: mint(),
    content: { type: "text", content: "typed\n" },
  } as Submitted);
  return { queue, transaction: one.request.transaction };
};

const applied = (transaction = mint()): Version_ => ({
  transaction,
  at: { minted: null, offset: null, accepted: "2026-08-24T00:00:00Z" },
  standing: "applied",
  kind: "text",
  size: 10,
  why: null,
});

describe("merging what is queued with what the server holds", () => {
  it("puts unsent work in front of everything the server has", () => {
    const { queue, transaction } = queued();
    const found = merged(queue.entries(), ENTRY, [applied()]);
    expect(found.map((one) => one.standing)).toEqual(["queued", "applied"]);
    expect(found[0]!.transaction).toBe(transaction);
  });

  it("gives queued work its own standing rather than borrowing one", () => {
    /**
     * It has not been decided, so applied, draft and refused are all false of
     * it -- and it is the one kind a user can still lose, which makes calling
     * it something it is not the worst answer available.
     */
    const { queue } = queued();
    const [first] = merged(queue.entries(), ENTRY, []);
    expect(first!.standing).toBe("queued");
    expect(first!.at.accepted).toBeNull();
    expect(first!.size).toBeNull();
  });

  it("shows newest first within the queued half", () => {
    const queue = outbox();
    const made = ["one\n", "two\n", "three\n"].map((content) => {
      const one = queue.capture({
        op: "write",
        transaction: mint(),
        id: ENTRY,
        content_version: mint(),
        content: { type: "text", content },
      } as Submitted);
      return one.request.transaction;
    });
    const found = merged(queue.entries(), ENTRY, []);
    expect(found.map((one) => one.transaction)).toEqual([...made].reverse());
  });

  it("does not show a write twice while it is in both places", () => {
    /**
     * The outbox is emptied by the STREAM, not by the answer, so between an
     * answer and the event that carries it the same write is queued here and
     * recorded there.
     */
    const { queue, transaction } = queued();
    const found = merged(queue.entries(), ENTRY, [applied(transaction)]);
    expect(found).toHaveLength(1);
    expect(found[0]!.standing).toBe("applied");
  });

  it("ignores work queued for other files", () => {
    const { queue } = queued(mint());
    expect(merged(queue.entries(), ENTRY, [])).toEqual([]);
  });

  it("ignores queued work that is not a write", () => {
    /** A rename is a version of the entry's NAME, not of what it said. */
    const queue = outbox();
    queue.capture({
      op: "rename",
      transaction: mint(),
      id: ENTRY,
      name: "renamed.py",
      name_version: mint(),
    } as Submitted);
    expect(merged(queue.entries(), ENTRY, [])).toEqual([]);
  });
});

describe("what a caller gets back", () => {
  it("keeps the server's own standings untouched", () => {
    const drafted: Version_ = { ...applied(), standing: "draft" };
    const declined: Version_ = {
      ...applied(),
      standing: "refused",
      why: "content was already updated",
    };
    const found: Told[] = merged([], ENTRY, [declined, drafted]);
    expect(found.map((one) => one.standing)).toEqual(["refused", "draft"]);
    expect(found[0]!.why).toBe("content was already updated");
  });
});
