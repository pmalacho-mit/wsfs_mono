/**
 * A store that refuses, and what it is allowed to cost.
 *
 * Refusing is not exotic: a full disk, a blocked store, a browser clearing
 * site data while a tab is open. What matters is that ONE refusal costs one
 * write. It used to cost the file: the row survived naming bytes that were
 * never stored, and every later write to that entry diffed against it, could
 * not read it, and threw -- for the life of the page.
 *
 * Both of these fail against the code as it was before `chainedIn` learned to
 * take its row back and `materialised` learned to store before it promotes.
 */
import { describe, expect, it } from "vitest";

import { inMemory, type Digest, type Store } from "../../release/frontend/bytes";
import { mint } from "../../release/frontend/identity";
import { queue as outbox, textOf } from "../../release/frontend/outbox";
import { pump } from "../../release/frontend/writes";
import type { Response, Write } from "../../release/frontend/contract";

/** The same store, refusing to write on the nth call. */
const refusing = (over: Store, when: (n: number) => boolean): Store => {
  let calls = 0;
  return {
    ...over,
    put: async (content, at) => {
      calls += 1;
      if (when(calls)) throw new Error("QuotaExceededError");
      return over.put(content, at);
    },
  };
};

/** A server that accepts everything, so nothing here turns on adjudication. */
const accepting = () => {
  const seen: Write[] = [];
  let held: ((answer: Response) => void) | undefined;
  return {
    seen,
    /** Nothing is answered until this is released. */
    hold: () => new Promise<void>((ready) => (held = () => ready())),
    send: async (request: Write): Promise<Response> => {
      seen.push(request);
      return { rejected: false };
    },
    release: () => held?.({ rejected: false }),
  };
};

const writing = (id: string, at: string): Write =>
  ({
    op: "write",
    transaction: mint(),
    id,
    content_version: at,
    content: { type: "text", content: "" },
  }) as Write;

const settle = () => new Promise((done) => setTimeout(done, 20));

describe("a store that refuses while a write is being queued", () => {
  it("costs that write and not the file", async () => {
    const entry = mint();
    const queue = outbox();
    const bytes = refusing(inMemory(), (n) => n === 1);
    const server = accepting();
    const flight = pump({
      queue,
      bytes,
      send: server.send as never,
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
    });

    await expect(
      flight.write(entry, writing(entry, mint()), "refused\n", "text/plain"),
    ).rejects.toThrow(/Quota/);

    /**
     * The row goes with the bytes. Left behind it would be this entry's chain
     * tail, and everything after it would diff against something unreadable.
     */
    expect(queue.chain(entry)).toHaveLength(0);

    /** And the file still works, which is the whole point. */
    const answer = await flight.write(
      entry,
      writing(entry, mint()),
      "and then this\n",
      "text/plain",
    );
    expect(answer.rejected).toBe(false);
    expect(server.seen).toHaveLength(1);
    expect(
      (server.seen[0]!.content as { content: string }).content,
    ).toBe("and then this\n");
  });

  it("leaves nothing behind in either place", async () => {
    const entry = mint();
    const queue = outbox();
    const kept = inMemory();
    const digests: Digest[] = [];
    const bytes: Store = {
      ...kept,
      put: async (content, at) => {
        const digest = at ?? (await kept.put(content, at));
        digests.push(digest);
        throw new Error("QuotaExceededError");
      },
    };
    const flight = pump({
      queue,
      bytes,
      send: async () => ({ rejected: false }),
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
    });

    await expect(
      flight.write(entry, writing(entry, mint()), "refused\n", "text/plain"),
    ).rejects.toThrow(/Quota/);

    expect(queue.entries()).toHaveLength(0);
    for (const digest of digests) expect(await kept.text(digest)).toBeUndefined();
  });
});

describe("a store that refuses while a queued write goes out", () => {
  it("leaves the write it was restating still readable", async () => {
    const entry = mint();
    const queue = outbox();
    const kept = inMemory();
    /**
     * The first two puts are the two writes being queued. The third is
     * `materialised` restating the chained one as whole text, which is the
     * one that must not be allowed to destroy it.
     */
    const bytes = refusing(kept, (n) => n === 3);

    let answering = false;
    const flight = pump({
      queue,
      bytes,
      send: async (): Promise<Response> => {
        if (!answering) throw new Error("nothing is listening");
        return { rejected: false };
      },
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
    });

    /**
     * Big enough that an edit script really is smaller than the file: a
     * chained write is only stored as a delta when the delta wins, so a toy
     * payload would be stored whole and there would be no basis to destroy.
     */
    const paragraph = "a line that is long enough to be worth diffing\n".repeat(60);
    const first = flight.write(entry, writing(entry, mint()), paragraph, "text/plain");
    void first.catch(() => undefined);
    await settle();
    const second = flight.write(
      entry,
      writing(entry, mint()),
      paragraph + "one more line\n",
      "text/plain",
    );
    void second.catch(() => undefined);
    await settle();

    const chain = queue.chain(entry);
    expect(chain).toHaveLength(2);
    const chained = chain[1]!;
    expect(chained.basis).toBeDefined();

    /** Now let it try to go out, with the store refusing the promotion. */
    answering = true;
    flight.resume();
    await settle();
    await settle();

    /**
     * Still here, and still says what the user typed. Promoting first and
     * failing to store would have taken both the whole text it never wrote
     * and the delta it deleted to make room for it.
     */
    expect(queue.find(chained.request.transaction)).toBeDefined();
    expect(await textOf(chained, queue, bytes)).toBe(paragraph + "one more line\n");
  });
});
