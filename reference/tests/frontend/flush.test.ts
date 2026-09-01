import { describe, expect, it } from "vitest";
import { inMemory } from "../../release/frontend/bytes";
import { remembering, type Kept, type Restored } from "../../release/frontend/kept";
import { connect } from "../../release/frontend/workspace";
import { server } from "./fake";

const settle = () => new Promise((d) => setTimeout(d, 60));
const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

/** A store whose writes land later, as a real disk's do. */
const lagging = (over: ReturnType<typeof remembering>) => {
  const pending: (() => void)[] = [];
  const kept: Kept = {
    moved: (change) => pending.push(() => over.kept.moved(change)),
    answered: (transactions) => pending.push(() => over.kept.answered(transactions)),
  };
  return {
    kept,
    restored: () => over.restored(),
    /** What a tab closing does NOT do. */
    land: () => {
      while (pending.length > 0) pending.shift()!();
    },
    outstanding: () => pending.length,
  };
};

describe("an answer written just before the tab went", () => {
  it("is still accounted for when the teardown waited for the disk", async () => {
    const wire = server();
    const backing = remembering();
    const slow = lagging(backing);

    const first = connect({
      workspace: "alpha",
      transport: wire,
      bytes: inMemory(),
      kept: slow.kept,
      restored: slow.restored(),
      timing: quickly,
    });
    await settle();
    await first.create("notes.py", "one\n").settled;
    await settle();
    const written = first.write("notes.py", "two\n");
    await written.settled;
    await settle();

    /** The tab goes with writes still on their way to the disk. */
    expect(slow.outstanding()).toBeGreaterThan(0);
    first.stop();
    slow.land();

    const again = connect({
      workspace: "alpha",
      transport: wire,
      bytes: inMemory(),
      kept: slow.kept,
      restored: slow.restored(),
      timing: quickly,
    });
    await settle();
    await settle();
    expect(again.unsettled([written.transaction])).toEqual([]);
    again.stop();
  });
});

describe("a teardown that does not wait", () => {
  it("loses what had not landed, which is why the ones that can, wait", async () => {
    /**
     * The inherent half, stated so nobody mistakes the fix above for a
     * guarantee. A tab that is KILLED cannot wait for anything, and an answer
     * still on its way goes with it -- the client then understates what the
     * server can rebuild, which is the safe direction and still a loss.
     *
     * Everything that CAN wait does: see `Keeping.flushed`, and the teardowns
     * that await it.
     */
    const wire = server();
    const backing = remembering();
    const slow = lagging(backing);

    const first = connect({
      workspace: "alpha",
      transport: wire,
      bytes: inMemory(),
      kept: slow.kept,
      restored: slow.restored(),
      timing: quickly,
    });
    await settle();
    await first.create("notes.py", "one\n").settled;
    await settle();
    const written = first.write("notes.py", "two\n");
    await written.settled;
    await settle();
    await first.write("notes.py", "three\n").settled;
    await settle();

    /** Killed: nothing lands. */
    first.stop();

    const again = connect({
      workspace: "alpha",
      transport: wire,
      bytes: inMemory(),
      kept: slow.kept,
      restored: slow.restored(),
      timing: quickly,
    });
    await settle();
    await settle();
    expect(again.unsettled([written.transaction])).toEqual([written.transaction]);
    again.stop();
  });
});
