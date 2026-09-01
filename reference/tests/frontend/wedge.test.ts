/**
 * One queued write that can never be sent, and what it costs.
 *
 * Its bytes are gone -- the browser cleared the store, or the tab died between
 * the payload landing and the row that names it. That transaction is lost and
 * nothing can undo it. The question this file answers is what it costs
 * EVERYTHING ELSE, and the answer used to be: everything. Initialize threw,
 * the loop backed off and re-entered at Initialize, and threw the same way for
 * ever, so a single unreadable write stopped the workspace draining again.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend/bytes";
import { mint } from "../../release/frontend/identity";
import { remembering } from "../../release/frontend/kept";
import type { Unreadable } from "../../release/frontend/outbox";
import { connect } from "../../release/frontend/workspace";
import { queue as outbox, textOf } from "../../release/frontend/outbox";
import { pump } from "../../release/frontend/writes";
import type { Write } from "../../release/frontend/contract";
import { server } from "./fake";

const settle = () => new Promise((done) => setTimeout(done, 60));
const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

const TEXT = "text/plain";

const writing = (id: string): Write =>
  ({
    op: "write",
    transaction: mint(),
    id,
    content_version: mint(),
    content: { type: "text", content: "" },
  }) as Write;

describe("a queued write whose bytes are gone", () => {
  it("costs that transaction and nothing else", async () => {
    const wire = server();
    let store = remembering();
    const lost: Unreadable[] = [];

    const open = (over = inMemory()) => {
      const held = remembering(store.restored());
      store = held;
      return connect({
        workspace: "alpha",
        transport: wire,
        bytes: over,
        kept: held.kept,
        restored: held.restored(),
        timing: quickly,
        lost: (entries) => lost.push(...entries),
      });
    };

    const bytes = inMemory();
    const first = open(bytes);
    await settle();
    const { entry } = first.create("notes.py", "start\n");
    await settle();

    wire.reachable(false);
    const stranded = first.write("notes.py", "start\nwanted\n");
    void stranded.settled.catch(() => undefined);
    await settle();
    first.stop();

    /** The queue comes back. The bytes it points at do not. */
    wire.reachable(true);
    const again = open(inMemory());
    await settle();
    await settle();

    /** Said, not swallowed: a user who is told can retype a paragraph. */
    expect(lost.map(({ transaction }) => transaction)).toContain(
      stranded.transaction,
    );
    expect(lost[0]!.why).toMatch(/bytes/);

    /** And it is gone from the queue, so it is not tried for ever. */
    expect(store.restored().entries).toHaveLength(0);

    /** Above all, the workspace still works. */
    const after = again.write("notes.py", "start\nlater\n");
    await after.settled;
    await settle();
    expect(wire.text(entry)).toContain("later");
    again.stop();
  });
});

/**
 * The other half, and the one Initialize cannot reach.
 *
 * A client whose stream is healthy never re-enters Initialize, so `presenting`
 * never gets a turn. If the bytes behind a queued write go while that client
 * is running -- another tab releasing a payload this one's delta was the last
 * reader of -- the pump is the only party that finds out, and it used to stop
 * the entry and retry the same unreadable write for ever.
 *
 * Driven through `pump` rather than `connect` on purpose: going through the
 * workspace would reconcile, and reconciling is exactly the path being ruled
 * out here.
 */
describe("a queued write whose bytes go while the client is running", () => {
  it("is dropped on the way out rather than retried for ever", async () => {
    const entry = mint();
    const queue = outbox();
    const bytes = inMemory();
    const lost: Unreadable[] = [];
    const sent: string[] = [];

    let answering = false;
    const flight = pump({
      queue,
      bytes,
      send: async (request) => {
        if (!answering) throw new Error("nothing is listening");
        sent.push(request.transaction);
        return { rejected: false };
      },
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
      lost: (entries) => lost.push(...entries),
    });

    const long = "a line long enough to be worth diffing\n".repeat(60);
    const first = flight.write(entry, writing(entry), long, TEXT);
    void first.catch(() => undefined);
    await settle();
    const second = flight.write(entry, writing(entry), long + "more\n", TEXT);
    void second.catch(() => undefined);
    await settle();

    const chain = queue.chain(entry);
    expect(chain).toHaveLength(2);
    expect(chain[1]!.basis).toBeDefined();

    /** The payload the head holds, and the only thing the delta can be read against. */
    await bytes.forget([chain[0]!.content!]);

    answering = true;
    flight.resume();
    await settle();
    await settle();

    /** Both are unreadable now, and both are named rather than retried. */
    expect(lost.map(({ transaction }) => transaction)).toEqual(
      expect.arrayContaining([chain[0]!.request.transaction]),
    );
    expect(queue.chain(entry)).toHaveLength(0);

    /** And the entry still takes writes, which is what fails without the eviction. */
    const after = flight.write(entry, writing(entry), "starting over\n", TEXT);
    expect((await after).rejected).toBe(false);
    await settle();
    expect(sent).toHaveLength(1);
  });
});

/**
 * The same loss, met from the other side.
 *
 * `drain` is not the only reader of a chain tail: so is `staged`, every time
 * the user types again. A tail whose bytes are gone therefore breaks the NEXT
 * write too -- and that one has nothing to do with sending, so no amount of
 * evicting on the way out arrives in time to help it.
 *
 * A write that cannot be described as a difference is simply stored whole.
 * The unreadable tail is still unreadable, and `drain` still drops it; what
 * changes is that the person typing is not stopped meanwhile.
 */
describe("typing again into a file whose queued tail is unreadable", () => {
  it("stores the new write whole rather than refusing it", async () => {
    const entry = mint();
    const queue = outbox();
    const bytes = inMemory();
    const flight = pump({
      queue,
      bytes,
      send: async () => {
        throw new Error("nothing is listening");
      },
      announced: () => {},
      remembered: () => {},
      token: () => null,
      unsound: () => {},
    });

    const long = "a line long enough to be worth diffing\n".repeat(60);
    const first = flight.write(entry, writing(entry), long, TEXT);
    void first.catch(() => undefined);
    await settle();

    /** Gone from under it, as another tab releasing a payload would do. */
    await bytes.forget([queue.chain(entry)[0]!.content!]);

    const typed = writing(entry);
    const after = flight.write(entry, typed, long + "typed anyway\n", TEXT);
    void after.catch(() => undefined);
    await settle();

    /**
     * Queued, whole, and readable. Whether the unreadable tail is still
     * beside it depends on whether a drain has reached it yet, which is not
     * what this is about -- what matters is that typing was not refused.
     */
    const queued = queue.find(typed.transaction);
    expect(queued).toBeDefined();
    expect(queued!.basis).toBeUndefined();
    expect(await textOf(queued!, queue, bytes)).toBe(long + "typed anyway\n");
  });
});
