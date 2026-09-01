/**
 * What this client records about WHEN, end to end.
 *
 * Three claims, and none of them is about parsing (that is `minted.test.ts`):
 * every transaction that leaves here carries the zone it was made in, nothing
 * reads a second clock to say when it was made, and queued work is visibly
 * queued rather than pretending to have been accepted.
 */
import { describe, expect, it } from "vitest";

import * as confirmed from "../../release/frontend/confirmed";
import { connect, inMemory } from "../../release/frontend";
import type { Metadata, Submitted } from "../../release/frontend/contract";
import * as effective from "../../release/frontend/effective";
import { mint } from "../../release/frontend/identity";
import { mintedAt, offset } from "../../release/frontend/minted";
import { queue } from "../../release/frontend/outbox";
import type { Transport } from "../../release/frontend/transport";

const SETTLED = new Date("2026-01-01T00:00:00Z").toISOString();

const born = (over: Partial<Metadata> = {}): Metadata => {
  const at = mint();
  return {
    id: mint(),
    type: "file",
    name: "a.py",
    parent: null,
    name_version: at,
    parent_version: at,
    deleted_version: at,
    content_version: at,
    modified: { minted: mintedAt(at)!.toISOString(), offset: 0, accepted: SETTLED },
    ...over,
  };
};

/** Records what was submitted and answers nothing else. */
const recording = () => {
  const sent: Submitted[] = [];
  const transport: Transport = {
    initialize: async () => ({ token: "t", entries: [], applied: [], rejected: [] }),
    submit: async (_workspace, request) => (sent.push(request), { rejected: false }),
    content: async () => ({ kind: "text", text: "" }),
    store: async () => {},
    follow: () => ({ close: () => {} }),
  };
  return { sent, transport };
};

const opened = () => {
  const { sent, transport } = recording();
  return { sent, workspace: connect({ workspace: mint(), transport, bytes: inMemory() }) };
};

describe("what a transaction carries about when it happened", () => {
  it("stamps the client's zone on every kind of request", async () => {
    const { sent, workspace } = opened();

    await workspace.create("a.py", "print()").settled;
    await workspace.folder("src").settled;
    await workspace.write("a.py", "print(1)").settled;
    await workspace.move("a.py", "b.py").settled;
    await workspace.remove("b.py").settled;
    workspace.stop();

    expect(sent.map((request) => request.op)).toEqual([
      "create",
      "create",
      "write",
      "move",
      "delete",
    ]);
    // Every one of them, because the stamp is applied at the choke point this
    // client submits through rather than at each of the five call sites.
    expect(sent.every((request) => request.offset === offset())).toBe(true);
  });

  it("sends no second clock reading -- the id already holds one", async () => {
    const { sent, workspace } = opened();
    await workspace.create("a.py", "x").settled;
    workspace.stop();

    const request = sent[0]!;
    expect(Object.keys(request)).not.toContain("at");
    expect(mintedAt(request.transaction)).toBeInstanceOf(Date);
  });

  it("dates an outbox entry from the request rather than from the clock", async () => {
    // Two clock reads would be two answers to one question, and the one shown
    // here would be the one the server could never confirm.
    const items = queue();
    const request: Submitted = {
      op: "rename",
      transaction: mint(),
      id: mint(),
      name: "b.py",
      name_version: mint(),
    };

    expect(items.capture(request).at).toBe(mintedAt(request.transaction)!.toISOString());
  });

  it("still dates an entry whose id was not minted as a v7", async () => {
    const items = queue();
    const request: Submitted = {
      op: "rename",
      transaction: "f3a2b1c0-1234-4567-89ab-cdef01234567",
      id: mint(),
      name: "b.py",
      name_version: mint(),
    };

    // The id says nothing, so the local clock is all there is. The entry is
    // this client's own bookkeeping and must not be left blank.
    expect(Number.isNaN(Date.parse(items.capture(request).at))).toBe(false);
  });
});

describe("the mtime a client shows before the server has answered", () => {
  const rename = (entry: Metadata) =>
    ({
      op: "rename" as const,
      transaction: mint(),
      id: entry.id,
      name: "renamed.py",
      name_version: entry.name_version,
      offset: 330,
    });

  it("moves to the queued transaction, in the zone it was made in", () => {
    const file = born();
    const items = queue();
    const request = rename(file);
    items.capture(request);

    const shown = effective.of(confirmed.snapshot([file]), items.entries()).view.get(file.id)!;

    expect(shown.modified.minted).toBe(mintedAt(request.transaction)!.toISOString());
    expect(shown.modified.offset).toBe(330);
  });

  it("says nobody has accepted it yet, and that is what null means", () => {
    const file = born();
    const items = queue();
    items.capture(rename(file));

    const { view } = effective.of(confirmed.snapshot([file]), items.entries());

    expect(view.get(file.id)!.modified.accepted).toBeNull();
    // ...and the confirmed entry underneath still carries the real one.
    expect(file.modified.accepted).toBe(SETTLED);
  });

  it("moves for a write, which changes nothing else about an entry", () => {
    const file = born();
    const items = queue();
    const writing = {
      op: "write" as const,
      transaction: mint(),
      id: file.id,
      content_version: file.content_version!,
      content: { type: "text" as const, content: "hello" },
    };
    items.capture(writing);

    const shown = effective.of(confirmed.snapshot([file]), items.entries()).view.get(file.id)!;

    expect(shown.modified.minted).toBe(mintedAt(writing.transaction)!.toISOString());
    // NOT the content token: that is what invalidates the content cache, and a
    // cache told a write landed before it did would serve the wrong bytes.
    expect(shown.content_version).toBe(file.content_version);
  });

  it("snaps back to the confirmed mtime when the work is refused", () => {
    const file = born();
    const items = queue();
    const request = rename(file);
    items.capture(request);
    const map = confirmed.snapshot([file]);

    expect(effective.of(map, items.entries()).view.get(file.id)!.modified.accepted).toBeNull();
    items.evict([request.transaction]);
    expect(effective.of(map, items.entries()).view.get(file.id)!.modified).toEqual(
      file.modified,
    );
  });

  it("gives a queued create an mtime of its own", () => {
    const id = mint();
    const items = queue();
    const creating = {
      op: "create" as const,
      transaction: mint(),
      id,
      type: "file" as const,
      name: "new.py",
      parent: null,
      content: { type: "text" as const, content: "" },
      offset: -420,
    };
    items.capture(creating);

    const shown = effective.of(confirmed.empty(), items.entries()).view.get(id)!;

    expect(shown.modified).toEqual({
      minted: mintedAt(creating.transaction)!.toISOString(),
      offset: -420,
      accepted: null,
    });
  });
});
