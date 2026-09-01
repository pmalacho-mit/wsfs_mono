/**
 * One content write per entry on the wire, and what that buys.
 *
 * The server that answers here is the real rule and nothing else: a write
 * lands if the token it presents is the one that is current, and otherwise it
 * is refused and told what the current one is. Everything asserted below is a
 * consequence of the client's ordering, not of a server that was talked into
 * being lenient -- which is the whole point, so the fake is deliberately
 * unforgiving.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend";
import { mint } from "../../release/frontend/identity";
import { queue as outbox } from "../../release/frontend/outbox";
import { pump } from "../../release/frontend/writes";
import type { Response, Submitted, Write } from "../../release/frontend/contract";

/**
 * A workspace that does the compare-and-swap and nothing else, plus the lag
 * that makes this interesting: what a write PRESENTS comes from `confirmed`,
 * which only catches up when the stream is pumped -- exactly as the real
 * client's confirmed map only moves on a stream event.
 */
const server = () => {
  const current = new Map<string, string>();
  const held = new Map<string, string>();
  const confirmed = new Map<string, string>();
  const applied: string[] = [];

  let inflight = 0;
  let most = 0;
  const seen: string[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;

  return {
    applied,
    most: () => most,
    seen,
    text: (entry: string) => held.get(entry),
    /** Nothing is answered until this is released -- so a chain can be seen whole. */
    hold: () => {
      gate = new Promise<void>((released) => (open = released));
    },
    release: () => {
      open?.();
      gate = undefined;
    },
    /** The entry exists, with a token the client has already been told about. */
    open: (entry: string, text = "") => {
      const token = mint();
      current.set(entry, token);
      confirmed.set(entry, token);
      held.set(entry, text);
      return token;
    },
    /**
     * A create this client has queued but not sent: the server will accept it
     * under the transaction that minted it, and until then nothing confirmed
     * names this entry at all.
     */
    creates: (entry: string, transaction: string) => {
      current.set(entry, transaction);
      held.set(entry, "");
    },
    /** Somebody else writes. The client hears nothing until the stream runs. */
    elsewhere: (entry: string, text: string) => {
      const token = mint();
      current.set(entry, token);
      held.set(entry, text);
      return token;
    },
    /** Deliver what has landed, which is what moves the confirmed token. */
    stream: () => {
      for (const [entry, token] of current) confirmed.set(entry, token);
    },
    token: (entry: string) => confirmed.get(entry) ?? null,
    send: async (request: Submitted): Promise<Response> => {
      inflight += 1;
      most = Math.max(most, inflight);
      try {
        await (gate ?? Promise.resolve());
        const write = request as Write;
        seen.push(write.transaction);
        if (write.content_version !== current.get(write.id))
          return {
            rejected: true,
            reason: "content was already updated",
            version: current.get(write.id)!,
          };
        current.set(write.id, write.transaction);
        held.set(
          write.id,
          write.content.type === "text" ? write.content.content : "",
        );
        applied.push(write.transaction);
        return { rejected: false };
      } finally {
        inflight -= 1;
      }
    },
  };
};

/**
 * Queueing a write is asynchronous -- hashing, and diffing against the tail --
 * and `crypto.subtle` settles on a task rather than a microtask, so this has
 * to yield the loop properly rather than spin on resolved promises.
 */
const until = async (settled: () => boolean) => {
  for (let turn = 0; turn < 200; turn += 1) {
    if (settled()) return;
    await new Promise((carry) => setTimeout(carry, 0));
  }
  throw new Error("the queue never reached the expected state");
};

const wired = (world: ReturnType<typeof server>) => {
  const queue = outbox();
  const bytes = inMemory();
  let announced = 0;
  const flight = pump({
    queue,
    bytes,
    send: world.send,
    announced: () => {
      announced += 1;
    },
    remembered: () => {},
    token: world.token,
    unsound: () => {},
  });
  return {
    queue,
    bytes,
    flight,
    announcements: () => announced,
    /** A write whose token comes from the caller, not from anything confirmed. */
    writeAgainst: (entry: string, token: string, text: string) => {
      const transaction = mint();
      return {
        transaction,
        settled: flight.write(
          entry,
          {
            op: "write",
            transaction,
            id: entry,
            content_version: token,
            content: { type: "text", content: text },
          } as Write,
          text,
          "text/plain",
        ),
      };
    },
    write: (entry: string, text: string) => {
      const transaction = mint();
      return {
        transaction,
        settled: flight.write(
          entry,
          {
            op: "write",
            transaction,
            id: entry,
            content_version: world.token(entry)!,
            content: { type: "text", content: text },
          } as Write,
          text,
          "text/plain",
        ),
      };
    },
  };
};

describe("writes in flight", () => {
  it("lands a run of writes the old client would have lost all but one of", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry, "");

    /**
     * Issued back to back and none of them awaited, which is what a debounced
     * save landing on top of an explicit one looks like. Every one of these
     * used to read the same confirmed token and all but the first was refused.
     */
    const sent = ["one", "two", "three"].map((text) => client.write(entry, text));
    const answers = await Promise.all(sent.map(({ settled }) => settled));

    expect(answers.map((answer) => answer.rejected)).toEqual([false, false, false]);
    expect(world.applied).toEqual(sent.map(({ transaction }) => transaction));
    expect(world.text(entry)).toBe("three");
  });

  it("puts only one of an entry's writes on the wire at a time", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry);

    await Promise.all(
      ["a", "b", "c", "d"].map((text) => client.write(entry, text).settled),
    );

    expect(world.most()).toBe(1);
  });

  it("does not make writes to different entries wait for each other", async () => {
    const world = server();
    const client = wired(world);
    const first = mint();
    const second = mint();
    world.open(first);
    world.open(second);

    world.hold();
    const sent = [client.write(first, "a"), client.write(second, "b")];
    await until(() => world.most() === 2);
    world.release();
    await Promise.all(sent.map(({ settled }) => settled));

    expect(world.most()).toBe(2);
  });

  it("still refuses a chain that somebody else wrote into the middle of", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry, "");

    const first = client.write(entry, "mine");
    expect((await first.settled).rejected).toBe(false);

    /**
     * The protection the swap exists to give. A token this client cannot name
     * is current, so what it sends next has to lose -- being able to chain
     * onto its OWN work must not become being able to chain onto anyone's.
     */
    world.elsewhere(entry, "theirs");
    const second = client.write(entry, "mine again");

    expect(await second.settled).toMatchObject({
      rejected: true,
      reason: "content was already updated",
    });
    expect(world.text(entry)).toBe("theirs");
  });

  it("takes a refused write back off the queue and says so", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry, "");
    world.elsewhere(entry, "theirs");

    const before = client.announcements();
    const refused = client.write(entry, "mine");
    await refused.settled;

    expect(client.queue.chain(entry)).toHaveLength(0);
    /** Once for queueing it, once for taking it back. */
    expect(client.announcements()).toBe(before + 2);
  });

  it("rebases what is behind a refusal onto what the stream then confirms", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry, "");
    const theirs = world.elsewhere(entry, "theirs");

    const doomed = client.write(entry, "mine");
    await doomed.settled;

    /**
     * The client hears about their write, and the next one it sends presents
     * that token -- which is the ordinary path back, and the reason a refusal
     * does not have to be a dead end.
     */
    world.stream();
    expect(world.token(entry)).toBe(theirs);
    const after = client.write(entry, "mine, rebased");

    expect((await after.settled).rejected).toBe(false);
    expect(world.text(entry)).toBe("mine, rebased");
  });

  it("writes against a create that is itself still queued", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();

    /**
     * No `open`: the server has never heard of this entry, so there is no
     * confirmed token to write against. What names its content is the
     * transaction of the create sitting in the outbox in front of it.
     */
    const creating = mint();
    world.creates(entry, creating);
    const written = client.writeAgainst(entry, creating, "after the create");

    expect((await written.settled).rejected).toBe(false);
    expect(world.text(entry)).toBe("after the create");
  });

  it("keeps the queue at a document and a pile of diffs", async () => {
    const world = server();
    const client = wired(world);
    const entry = mint();
    world.open(entry, "");
    const document = "line\n".repeat(2_000);

    /**
     * Queued while nothing can leave, so the whole chain is sitting in the
     * store at once -- which is the state a client that has been offline is
     * in, and the one whose size actually matters.
     */
    world.hold();
    const sent = [
      client.write(entry, document),
      client.write(entry, `${document}a`),
      client.write(entry, `${document}ab`),
      client.write(entry, `${document}abc`),
    ];
    await until(() => client.queue.chain(entry).length === 4);

    const sizes = await Promise.all(
      client.queue
        .chain(entry)
        .map(async (item) => (await client.bytes.text(item.content!))!.length),
    );

    expect(sizes[0]).toBeGreaterThan(document.length - 1);
    for (const size of sizes.slice(1)) expect(size).toBeLessThan(200);

    world.release();
    await Promise.all(sent.map(({ settled }) => settled));
    expect(world.text(entry)).toBe(`${document}abc`);
  });

  it("carries a chain on after a connection dropped in the middle of it", async () => {
    const world = server();
    const entry = mint();
    world.open(entry, "");

    let broken = true;
    const client = wired({
      ...world,
      send: async (request) => {
        if (broken) throw new Error("offline");
        return world.send(request);
      },
    } as ReturnType<typeof server>);

    const first = client.write(entry, "one");
    await expect(first.settled).rejects.toThrow("offline");
    const second = client.write(entry, "two");
    await until(() => client.queue.chain(entry).length === 2);

    /** Nothing was answered, so nothing was thrown away. */
    expect(client.queue.chain(entry)).toHaveLength(2);

    broken = false;
    client.flight.resume();
    expect((await second.settled).rejected).toBe(false);
    expect(world.text(entry)).toBe("two");
  });
});
