/**
 * Two things a client records that change nothing.
 *
 * They are transactions for one reason: the outbox is the only machine here
 * that promises delivery, and an execution that never reached the server is
 * evidence of nothing. So what is worth testing on this side is that they go
 * through it -- queued while offline, replayed when the server comes back.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend/bytes";
import { remembering } from "../../release/frontend/kept";
import { connect } from "../../release/frontend/workspace";
import { server } from "./fake";

const settle = () => new Promise((done) => setTimeout(done, 60));
const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

const opened = () => {
  const wire = server();
  const held = remembering();
  const workspace = connect({
    workspace: "alpha",
    transport: wire,
    bytes: inMemory(),
    kept: held.kept,
    restored: held.restored(),
    timing: quickly,
  });
  return { wire, held, workspace };
};

describe("a snapshot", () => {
  it("names every entry at the four tokens that are its identity", async () => {
    const { wire, workspace } = opened();
    await settle();
    const { entry } = workspace.create("notes.py", "one\n");
    await settle();

    const taken = workspace.snapshot([entry]);
    await taken.settled;
    await settle();

    const sent = wire
      .submitted()
      .find((one) => one.transaction === taken.transaction) as never as {
      entries: { id: string; name_version: string; content_version: string }[];
    };
    expect(sent.entries).toHaveLength(1);
    expect(sent.entries[0]!.id).toBe(entry);
    /** All four, because together they ARE the entry. */
    for (const named of [
      "name_version",
      "parent_version",
      "deleted_version",
      "content_version",
    ])
      expect((sent.entries[0] as never as Record<string, string>)[named]).toBeTruthy();
    workspace.stop();
  });

  it("waits in the outbox while the server cannot be reached", async () => {
    const { wire, workspace, held } = opened();
    await settle();
    const { entry } = workspace.create("notes.py", "one\n");
    await settle();

    wire.reachable(false);
    const taken = workspace.snapshot([entry]);
    void taken.settled.catch(() => undefined);
    await settle();
    expect(held.restored().entries.map((one) => one.request.transaction)).toContain(
      taken.transaction,
    );

    wire.reachable(true);
    workspace.nudge();
    await settle();
    await settle();
    expect(wire.recorded()).toContain(taken.transaction);
    workspace.stop();
  });
});

describe("what a kernel produced", () => {
  it("is reduced to what a disk will actually take", async () => {
    /**
     * The failure this prevents was not local. A queued transaction is
     * written down by structured clone, which refuses a class instance or a
     * proxy -- and kernel output is full of them. The clone threw, the whole
     * durable write failed, and the client reported that the outbox had
     * stopped reaching disk: one unstorable output reading as "your work is
     * not being saved".
     */
    const { wire, workspace } = opened();
    await settle();
    const { entry } = workspace.create("run.py", "print(1)\n");
    await settle();
    const taken = workspace.snapshot([entry]);
    await taken.settled;

    /**
     * A function on the output itself, which is what a proxy or a lazily
     * rendered value looks like to the clone. A class instance would not do:
     * that clones fine, losing only its prototype.
     */
    const awkward = {
      output_type: "display_data",
      text: "1\n",
      render: () => "1\n",
    };
    const ran = workspace.executed(
      entry,
      taken.transaction,
      [awkward, { output_type: "stream", text: "1\n" }],
      true,
    );
    await ran.settled;
    await settle();

    const sent = wire
      .submitted()
      .find((one) => one.transaction === ran.transaction) as never as {
      outputs: unknown[];
    };
    /** Structured-cloneable, which is the whole requirement. */
    expect(() => structuredClone(sent.outputs)).not.toThrow();
    /** What survives is what the server was ever going to store. */
    expect(sent.outputs).toEqual([
      { output_type: "display_data", text: "1\n" },
      { output_type: "stream", text: "1\n" },
    ]);
    workspace.stop();
  });

  it("keeps the run even when nothing about it survives JSON", async () => {
    const { wire, workspace } = opened();
    await settle();
    const { entry } = workspace.create("run.py", "print(1)\n");
    await settle();
    const taken = workspace.snapshot([entry]);
    await taken.settled;

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ran = workspace.executed(entry, taken.transaction, [circular], false);
    await ran.settled;
    await settle();

    const sent = wire
      .submitted()
      .find((one) => one.transaction === ran.transaction) as never as {
      outputs: { unstorable: string }[];
      ok: boolean;
    };
    expect(() => structuredClone(sent.outputs)).not.toThrow();
    /** That it ran, and how it ended, outlive the shape of what it said. */
    expect(sent.ok).toBe(false);
    expect(sent.outputs[0]!.unstorable).toContain("Object");
    workspace.stop();
  });
});

describe("an execution", () => {
  it("carries what came out, and whether it ended well", async () => {
    const { wire, workspace } = opened();
    await settle();
    const { entry } = workspace.create("run.py", "print(1)\n");
    await settle();
    const taken = workspace.snapshot([entry]);
    await taken.settled;

    const outputs = [{ output_type: "stream", text: "1\n" }];
    const ran = workspace.executed(entry, taken.transaction, outputs, true);
    await ran.settled;
    await settle();

    const sent = wire
      .submitted()
      .find((one) => one.transaction === ran.transaction) as never as {
      snapshot: string;
      outputs: unknown[];
      ok: boolean;
    };
    expect(sent.snapshot).toBe(taken.transaction);
    expect(sent.outputs).toEqual(outputs);
    expect(sent.ok).toBe(true);
    workspace.stop();
  });

  it("survives the page that recorded it", async () => {
    /**
     * The whole reason it is a transaction. A run recorded on a machine that
     * then went offline is worth exactly as much as the guarantee that it
     * arrives.
     */
    const wire = server();
    let store = remembering();
    const open = () => {
      const held = remembering(store.restored());
      store = held;
      return connect({
        workspace: "alpha",
        transport: wire,
        bytes: inMemory(),
        kept: held.kept,
        restored: held.restored(),
        timing: quickly,
      });
    };

    const first = open();
    await settle();
    const { entry } = first.create("run.py", "print(1)\n");
    await settle();
    const taken = first.snapshot([entry]);
    await taken.settled;

    wire.reachable(false);
    const ran = first.executed(entry, taken.transaction, [{ text: "1\n" }], true);
    void ran.settled.catch(() => undefined);
    await settle();
    first.stop();

    wire.reachable(true);
    const again = open();
    await settle();
    await settle();
    expect(wire.recorded()).toContain(ran.transaction);
    again.stop();
  });
});
