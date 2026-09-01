/**
 * The two things that needed a server that could be told what to say.
 *
 * Rule one -- content that came out of an editor moves as a CRDT update, never
 * as text -- was a convention. And invariant 6, "a token the server never
 * issued means start again", had a tested half at each end and nothing joining
 * them: the server refuses correctly, and the loop re-enters when nudged, and
 * whether the client NUDGES ON THAT REASON was the untested middle.
 */
import { describe, expect, it } from "vitest";

import { connect } from "../../release/frontend/workspace";
import { inMemory } from "../../release/frontend/bytes";
import { mint } from "../../release/frontend/identity";
import { UNSOUND } from "../../release/frontend/contract";
import { server } from "./fake";

const settle = () => new Promise((done) => setTimeout(done, 60));

/**
 * The real backoff, shrunk. Nothing here is about how long a client waits --
 * only about whether it comes round again at all -- and the watchdog is left
 * alone so a quiet stream is not mistaken for a dead one.
 */
const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

const opened = async (shared?: (entry: string) => boolean) => {
  const wire = server();
  const workspace = connect({
    workspace: mint(),
    transport: wire,
    bytes: inMemory(),
    shared,
    timing: quickly,
  });
  await settle();
  return { wire, workspace };
};

describe("a file a shared document speaks for", () => {
  it("cannot be written around", async () => {
    const held = new Set<string>();
    const { workspace } = await opened((entry) => held.has(entry));
    const { entry } = workspace.create("notes.py", "one\n");
    await settle();

    /** While nothing holds a document, a script's write is ordinary. */
    expect(() => workspace.write("notes.py", "by a script\n")).not.toThrow();

    held.add(entry);
    expect(() => workspace.write("notes.py", "around it\n")).toThrow(
      /shared document/,
    );
    workspace.stop();
  });

  it("names the route that is open", async () => {
    const held = new Set<string>();
    const { wire, workspace } = await opened((entry) => held.has(entry));
    const { entry } = workspace.create("notes.py", "one\n");
    await settle();
    held.add(entry);

    /** Which is the one the document itself uses, and it goes through. */
    await workspace.shares(entry, "typed into the document\n").settled;
    await settle();
    expect(wire.text(entry)).toBe("typed into the document\n");

    /** As does a draft, which is the same document reaching nobody. */
    await workspace.keep(entry, "reaching nobody\n").settled;
    expect(wire.drafts()).toHaveLength(1);
    workspace.stop();
  });
});

/** Somebody else's write, which this client is not told about. */
const movedOn = async (wire: ReturnType<typeof server>, entry: string) => {
  wire.silence();
  await wire.submit("w", {
    op: "write",
    transaction: mint(),
    id: entry,
    content_version: wire.entries()[0]!.content_version,
    content: { type: "text", content: "somebody else\n" },
  } as never);
};

describe("a token the server never issued", () => {
  it("makes the client throw its state away and start again", async () => {
    const { wire, workspace } = await opened();
    const { entry, transaction } = workspace.create("notes.py", "one\n");
    await settle();
    const before = wire.initializes();
    await movedOn(wire, entry);

    /**
     * And the version this client is still holding is one the server has no
     * record of minting -- what a client faces after a rollback, or against a
     * different deployment. Rebasing onto it would be reasoning from a state
     * that never existed, so the only sound move is to drop everything and
     * ask again.
     */
    wire.disown(transaction);
    const answer = await workspace.shares(entry, "two\n").settled;
    expect(answer.rejected && answer.reason).toBe(UNSOUND);

    await settle();
    expect(wire.initializes()).toBeGreaterThan(before);
    workspace.stop();
  });

  it("does not start again for an ordinary conflict", async () => {
    const { wire, workspace } = await opened();
    const { entry } = workspace.create("notes.py", "one\n");
    await settle();
    const before = wire.initializes();
    await movedOn(wire, entry);

    /** The token was real, and is simply no longer current. Rebase, not reset. */
    const answer = await workspace.shares(entry, "two\n").settled;
    expect(answer.rejected).toBe(true);
    expect(answer.rejected && answer.reason).not.toBe(UNSOUND);

    await settle();
    expect(wire.initializes()).toBe(before);
    workspace.stop();
  });
});
