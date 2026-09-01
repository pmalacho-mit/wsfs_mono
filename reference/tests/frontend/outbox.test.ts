/**
 * The queue, and what it costs to hold.
 *
 * These used to assert COALESCING -- one item per entry, later writes eating
 * earlier ones. That is gone on purpose: a consumer writes at moments it cares
 * about, and a queue that keeps only the last one cannot say what the file
 * held at any of the others. What replaced it has to be paid for in space, so
 * most of what is below is about the chain staying readable and the byte store
 * not being asked to hold more than it has to.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend";
import { applyDelta, type Delta } from "../../release/frontend/delta";
import { mint } from "../../release/frontend/identity";
import {
  chained,
  isElided,
  presenting,
  queue,
  textOf,
  type Queue,
} from "../../release/frontend/outbox";
import type { Store } from "../../release/frontend/bytes";
import type { Write } from "../../release/frontend/contract";

const writing = (entry: string, content: string, token: string): Write => ({
  op: "write",
  transaction: mint(),
  id: entry,
  content_version: token,
  content: { type: "text", content },
});

/** Queue a text write the way `writes.ts` does: whole at the head, delta behind. */
const queued = async (items: Queue, bytes: Store, entry: string, text: string) => {
  const chain = items.chain(entry);
  const tail = chain[chain.length - 1];
  const request = writing(entry, text, "v0");
  if (tail === undefined) {
    items.capture(request, await bytes.put(text));
    return request;
  }
  const before = await textOf(tail, items, bytes);
  items.capture(
    request,
    await bytes.put(chained(before, text)),
    tail.request.transaction,
  );
  return request;
};

describe("the outbox", () => {
  it("keeps every write to an entry, in the order they were made", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();

    for (const text of ["one", "two", "three"]) await queued(items, bytes, entry, text);

    expect(items.size()).toBe(3);
    expect(items.chain(entry)).toHaveLength(3);
  });

  it("does not chain writes to different entries", async () => {
    const bytes = inMemory();
    const items = queue();
    const first = mint();
    const second = mint();

    await queued(items, bytes, first, "a");
    await queued(items, bytes, second, "b");

    expect(items.chain(first)).toHaveLength(1);
    expect(items.chain(second)).toHaveLength(1);
    expect(items.chain(first)[0]!.basis).toBeUndefined();
    expect(items.chain(second)[0]!.basis).toBeUndefined();
  });

  it("takes a text write's body off the request, so it is stored once", async () => {
    const bytes = inMemory();
    const items = queue();
    const request = writing(mint(), "the whole document", "v0");

    items.capture(request, await bytes.put("the whole document"));

    const [held] = items.entries();
    expect(isElided(held!.request)).toBe(true);
    expect((held!.request as { content: unknown }).content).toBeNull();
  });

  it("stores a chained write as an edit script, not another copy", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();
    const document = "x".repeat(5_000);

    await queued(items, bytes, entry, document);
    await queued(items, bytes, entry, `${document}!`);

    const [, second] = items.chain(entry);
    const stored = await bytes.text(second!.content!);
    expect(stored!.length).toBeLessThan(200);
    expect(applyDelta(document, JSON.parse(stored!) as Delta)).toBe(`${document}!`);
  });

  it("reads a chain three deep back to the text each write meant", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();
    const texts = ["print(1)", "print(1)\nprint(2)", "print(1)\nprint(2)\nprint(3)"];

    for (const text of texts) await queued(items, bytes, entry, text);

    const chain = items.chain(entry);
    for (const [at, text] of texts.entries())
      expect(await textOf(chain[at]!, items, bytes)).toBe(text);
  });

  it("hands the bytes to the delta behind it when a write leaves", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();

    const first = await queued(items, bytes, entry, "before");
    await queued(items, bytes, entry, "before and after");

    const released = items.evict([first.transaction]);

    /**
     * Nothing may be forgotten here: the delta left behind is a delta against
     * exactly those bytes, and forgetting them would strand it.
     */
    expect(released).toEqual([]);
    expect(await textOf(items.chain(entry)[0]!, items, bytes)).toBe(
      "before and after",
    );
  });

  it("releases the bytes once the delta that needed them is written out whole", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();

    const first = await queued(items, bytes, entry, "before");
    const second = await queued(items, bytes, entry, "before and after");
    items.evict([first.transaction]);

    const whole = await textOf(items.chain(entry)[0]!, items, bytes);
    const released = items.promote(second.transaction, await bytes.put(whole));

    expect(released).toHaveLength(2);
    expect(items.chain(entry)[0]!.basis).toBeUndefined();
    expect(await textOf(items.chain(entry)[0]!, items, bytes)).toBe(
      "before and after",
    );
  });

  it("releases the bytes an evicted item was holding", async () => {
    const bytes = inMemory();
    const items = queue();
    const request = writing(mint(), "payload", "v0");
    const digest = await bytes.put("payload");

    items.capture(request, digest);
    const released = items.evict([request.transaction]);

    expect(released).toEqual([digest]);
    expect(items.size()).toBe(0);
  });

  it("keeps bytes two items happen to share", async () => {
    const bytes = inMemory();
    const items = queue();
    const digest = await bytes.put("identical");
    const first = writing(mint(), "identical", "v0");

    items.capture(first, digest);
    items.capture(writing(mint(), "identical", "v0"), digest);

    expect(items.evict([first.transaction])).toEqual([]);
  });

  it("presents what it holds in the order it was queued", async () => {
    const bytes = inMemory();
    const items = queue();
    const requests = [mint(), mint(), mint()].map((id) => writing(id, "x", "v0"));
    for (const request of requests) items.capture(request, await bytes.put("x"));

    const { presented: shown } = await presenting(items.entries(), items, bytes);
    expect(shown.map((request) => request.transaction)).toEqual(
      requests.map((request) => request.transaction),
    );
  });

  it("puts an elided body back before presenting it", async () => {
    const bytes = inMemory();
    const items = queue();
    await queued(items, bytes, mint(), "the whole document");

    const { presented: [shown] } = await presenting(items.entries(), items, bytes);
    expect((shown as Write).content).toEqual({
      type: "text",
      content: "the whole document",
    });
  });

  it("presents only the first write of a chain, because replay has no answers in it", async () => {
    const bytes = inMemory();
    const items = queue();
    const entry = mint();

    const first = await queued(items, bytes, entry, "one");
    await queued(items, bytes, entry, "two");
    await queued(items, bytes, entry, "three");

    const { presented: shown } = await presenting(items.entries(), items, bytes);
    expect(shown.map((request) => request.transaction)).toEqual([
      first.transaction,
    ]);
  });
});
