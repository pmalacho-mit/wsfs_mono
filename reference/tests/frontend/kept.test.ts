/**
 * Work outliving the page that made it.
 *
 * A reload is modelled as what it actually is: the same durable store, a fresh
 * `connect` over it, and nothing carried across in memory. If a transaction
 * survives that and reaches the server, it survives a reload -- and if it does
 * not, no amount of the client being careful in one page load matters.
 *
 * The rule being tested is one sentence: EVERY transaction this client makes
 * reaches the server, once the user gets back to the workspace it belongs to.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend/bytes";
import { mint } from "../../release/frontend/identity";
import { remembering, type Restored } from "../../release/frontend/kept";
import { connect, type Workspace } from "../../release/frontend/workspace";
import { server, type Fake } from "./fake";

const settle = () => new Promise((done) => setTimeout(done, 60));

/**
 * Queued, and not awaited. A send that fails while the server is unreachable
 * rejects the caller's promise, and these tests are deliberately the caller
 * that walks away -- which is the whole case: the work must reach the server
 * without anybody still holding a promise for it.
 */
const abandoned = <T extends { settled: Promise<unknown> }>(sent: T): T => {
  void sent.settled.catch(() => undefined);
  return sent;
};

const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

/**
 * One machine: a durable store that outlives the workspaces opened over it, and
 * a byte store that does the same. Both are what a browser keeps.
 */
const machine = () => {
  const stores = new Map<string, ReturnType<typeof remembering>>();
  const bytes = inMemory();

  const of = (workspace: string, restored?: Restored) => {
    const held = remembering(restored ?? stores.get(workspace)?.restored());
    stores.set(workspace, held);
    return held;
  };

  return {
    bytes,
    /** Open a workspace as this machine has it written down. */
    open: (workspace: string, wire: Fake): Workspace => {
      const held = of(workspace);
      return connect({
        workspace,
        transport: wire,
        bytes,
        kept: held.kept,
        restored: held.restored(),
        timing: quickly,
      });
    },
    written: (workspace: string) => stores.get(workspace)!.restored(),
  };
};

describe("a queue that outlives the page", () => {
  it("sends what was queued while the server was unreachable", async () => {
    const wire = server();
    const here = machine();

    const first = here.open("alpha", wire);
    await settle();
    const { entry } = first.create("notes.py", "one\n");
    await settle();

    wire.reachable(false);
    const lost = abandoned(first.write("notes.py", "typed while offline\n"));
    await settle();
    expect(here.written("alpha").entries.length).toBeGreaterThan(0);

    /** The tab goes. Nothing in memory survives; the store does. */
    first.stop();

    wire.reachable(true);
    const again = here.open("alpha", wire);
    await settle();
    await settle();

    expect(wire.text(entry)).toBe("typed while offline\n");
    expect(wire.answered()).toContain(lost.transaction);
    again.stop();
  });

  it("keeps a draft until it reaches the server, like any other transaction", async () => {
    const wire = server();
    const here = machine();

    const first = here.open("alpha", wire);
    await settle();
    const { entry } = first.create("notes.py", "one\n");
    await settle();

    /**
     * A draft is a member of the outbox and not a note in the margin. It is
     * text nobody else has, which is exactly the work that cannot be
     * reconstructed from anywhere else, so it has to reach the server.
     */
    wire.reachable(false);
    const draft = abandoned(first.keep(entry, "reaching nobody\n"));
    await settle();
    first.stop();

    wire.reachable(true);
    const again = here.open("alpha", wire);
    await settle();
    await settle();

    expect(wire.drafts()).toContain(draft.transaction);
    again.stop();
  });

  it("keeps every draft, not only the last", async () => {
    const wire = server();
    const here = machine();

    const first = here.open("alpha", wire);
    await settle();
    const { entry } = first.create("notes.py", "one\n");
    await settle();

    /**
     * Each one can be part of a snapshot somebody took at that moment, so a
     * later draft does not stand in for an earlier one. Nothing supersedes.
     */
    wire.reachable(false);
    const drafts = [
      abandoned(first.keep(entry, "first\n")),
      abandoned(first.keep(entry, "second\n")),
      abandoned(first.keep(entry, "third\n")),
    ];
    await settle();
    first.stop();

    wire.reachable(true);
    const again = here.open("alpha", wire);
    await settle();
    await settle();
    await settle();

    for (const draft of drafts) expect(wire.drafts()).toContain(draft.transaction);
    again.stop();
  });

  it("says a snapshot is portable only once the work in it has landed", async () => {
    const wire = server();
    const here = machine();

    const first = here.open("alpha", wire);
    await settle();
    const { entry } = first.create("notes.py", "one\n");
    await settle();

    wire.reachable(false);
    const draft = abandoned(first.keep(entry, "reaching nobody\n"));
    await settle();
    expect(first.unsettled([draft.transaction])).toEqual([draft.transaction]);
    first.stop();

    /**
     * And the answer survives the reload too. `recorded` used to be the one
     * thing held only in memory, so a reload made a client understate what the
     * server could rebuild -- it would call landed work unsettled for ever.
     */
    wire.reachable(true);
    const again = here.open("alpha", wire);
    await settle();
    await settle();
    expect(again.unsettled([draft.transaction])).toEqual([]);

    const later = here.open("alpha", wire);
    await settle();
    expect(later.unsettled([draft.transaction])).toEqual([]);
    again.stop();
    later.stop();
  });
});

describe("more than one workspace", () => {
  it("does not drain a queue by looking at somewhere else", async () => {
    const wire = server();
    const here = machine();

    const alpha = here.open("alpha", wire);
    await settle();
    const { entry } = alpha.create("notes.py", "one\n");
    await settle();

    wire.reachable(false);
    const stranded = abandoned(alpha.write("notes.py", "typed in alpha\n"));
    await settle();
    alpha.stop();

    /**
     * The user goes somewhere else. Alpha's queue has no route to be drained
     * -- a client follows one workspace's stream, and it is not alpha's -- so
     * the work must simply wait rather than being lost or replayed into the
     * wrong workspace.
     */
    wire.reachable(true);
    const beta = here.open("beta", wire);
    await settle();
    await settle();
    expect(wire.answered()).not.toContain(stranded.transaction);
    expect(here.written("alpha").entries).toHaveLength(1);
    beta.stop();

    /** And back. Now there is a stream that carries it, and it goes. */
    const returned = here.open("alpha", wire);
    await settle();
    await settle();
    expect(wire.answered()).toContain(stranded.transaction);
    expect(wire.text(entry)).toBe("typed in alpha\n");
    expect(here.written("alpha").entries).toHaveLength(0);
    returned.stop();
  });
});

describe("an answer that was current and then was not", () => {
  it("is still accounted for once something supersedes it", async () => {
    /**
     * Found by a soak test, and it is the exact inverse of what `recorded`
     * exists for. Answers used to be pruned against the confirmed map, on the
     * reasoning that a current version is already spoken for. True until the
     * next write to that file: the map only holds what an entry is at NOW, so
     * a transaction pruned while current became -- the moment something
     * superseded it -- one that neither the map nor the set could answer for,
     * and `unsettled` called work that was safely on the server unsettled for
     * ever.
     */
    const wire = server();
    const here = machine();

    const workspace = here.open("alpha", wire);
    await settle();
    await workspace.create("notes.py", "one\n").settled;
    await settle();

    const first = workspace.write("notes.py", "two\n");
    await first.settled;
    await settle();

    /** A reconcile, which is where the pruning used to happen. */
    workspace.nudge();
    await settle();
    await settle();
    expect(workspace.unsettled([first.transaction])).toEqual([]);

    /** And now a later write moves the file past it. */
    await workspace.write("notes.py", "three\n").settled;
    await settle();
    expect(workspace.unsettled([first.transaction])).toEqual([]);
    workspace.stop();
  });

  it("survives the reload that follows", async () => {
    const wire = server();
    const here = machine();

    const first = here.open("alpha", wire);
    await settle();
    await first.create("notes.py", "one\n").settled;
    await settle();
    const early = first.write("notes.py", "two\n");
    await early.settled;
    await settle();
    await first.write("notes.py", "three\n").settled;
    await settle();
    first.stop();

    const again = here.open("alpha", wire);
    await settle();
    await settle();
    expect(again.unsettled([early.transaction])).toEqual([]);
    again.stop();
  });
});
