/**
 * Against a real server.
 *
 *     WSFS_BACKEND=http://localhost:8000 npx vitest run
 *
 * These are the only tests that can tell whether the generated types describe
 * what actually arrives -- everything else is this client reasoning about
 * itself. Without a server they skip rather than fail, so the fast suite stays
 * runnable anywhere.
 */
import { beforeAll, expect, it } from "vitest";

import { connect, inMemory, type Workspace } from "../../release/frontend";
import { accepted, localised, offset } from "../../release/frontend/minted";
import { describeLive, project, reachable, transport } from "./backend";

const settledWhen = (workspace: Workspace, holds: () => boolean, within = 5_000) =>
  new Promise<void>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error("never settled")), within);
    const finish = () => (clearTimeout(deadline), stop(), done());
    const stop = workspace.watch(() => holds() && finish());
    if (holds()) finish();
  });

describeLive("a workspace against a live backend", () => {
  let workspace: Workspace;
  let id: string;

  beforeAll(async () => {
    if (!(await reachable())) throw new Error("WSFS_BACKEND is set but not answering");
    id = await project();
    workspace = connect({
      workspace: id,
      transport: transport(),
      bytes: inMemory(),
    });
    await settledWhen(workspace, () => true);
  });

  it("creates a file and reads its content back", async () => {
    await workspace.create("main.py", "print('hi')").settled;
    await settledWhen(workspace, () => workspace.index().at("main.py") !== undefined);

    expect(await workspace.read("main.py")).toEqual({
      kind: "text",
      text: "print('hi')",
    });
  });

  it("puts a file where a path says, not where an id says", async () => {
    await workspace.folder("src").settled;
    await settledWhen(workspace, () => workspace.index().at("src") !== undefined);
    await workspace.create("src/nested.py", "nested").settled;
    await settledWhen(workspace, () => workspace.index().at("src/nested.py") !== undefined);

    expect(workspace.index().paths()).toContain("src/nested.py");
  });

  it("moves an entry's path and name in one go", async () => {
    await workspace.create("before.py", "x").settled;
    await settledWhen(workspace, () => workspace.index().at("before.py") !== undefined);

    await workspace.move("before.py", "src/after.py").settled;
    await settledWhen(workspace, () => workspace.index().at("src/after.py") !== undefined);

    expect(workspace.index().at("before.py")).toBeUndefined();
  });

  it("carries binary content through the blob store", async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await workspace.create("logo.png", payload, "image/png").settled;
    await settledWhen(workspace, () => workspace.index().at("logo.png") !== undefined);

    const held = await workspace.read("logo.png");
    expect(held).toMatchObject({ kind: "binary" });
    expect([...(held as { bytes: Uint8Array }).bytes]).toEqual([...payload]);
  });

  it("takes a path away when its entry is removed", async () => {
    await workspace.create("doomed.py", "x").settled;
    await settledWhen(workspace, () => workspace.index().at("doomed.py") !== undefined);

    await workspace.remove("doomed.py").settled;
    await settledWhen(workspace, () => workspace.index().at("doomed.py") === undefined);

    expect(workspace.index().paths()).not.toContain("doomed.py");
  });

  it("times a change in both clocks, and in the zone it was made in", async () => {
    // The only place the two halves meet for real: this client derives the
    // client instant from the id it minted, the server derives the same one
    // from the same id, and the offset is the single thing that travelled.
    const before = Date.now();
    await workspace.create("timed.py", "x").settled;
    await settledWhen(workspace, () => {
      const entry = workspace.index().at("timed.py");
      return entry !== undefined && entry.modified.accepted !== null;
    });

    const entry = workspace.index().at("timed.py")!;
    const local = localised(entry.modified)!;

    expect(local.instant.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(local.zoned).toBe(true);
    expect(local.offset).toBe(offset());
    // The server's clock is its own, and it saw this after the client did.
    expect(accepted(entry.modified)!.getTime()).toBeGreaterThanOrEqual(
      local.instant.getTime(),
    );
  });

  it("keeps each queued item's own zone when an outbox is replayed", async () => {
    // Somebody works in one zone and reconnects in another. The offset rides
    // on the transaction, so the server records what each item was made in
    // rather than where the connection happened to be.
    const id = await project();
    const moved = connect({ workspace: id, transport: transport(), bytes: inMemory() });
    await settledWhen(moved, () => true);

    await moved.create("packed.py", "x");
    await settledWhen(moved, () => moved.index().at("packed.py") !== undefined);

    const entry = moved.index().at("packed.py")!;
    expect(entry.modified.offset).toBe(offset());
    moved.stop();
  });

  it("shows one client the work of another", async () => {
    const id = await project();
    const mine = connect({ workspace: id, transport: transport(), bytes: inMemory() });
    const theirs = connect({
      workspace: id,
      transport: transport("grace@example.com"),
      bytes: inMemory(),
    });
    await settledWhen(mine, () => true);
    await settledWhen(theirs, () => true);

    await theirs.create("shared.py", "theirs").settled;
    await settledWhen(mine, () => mine.index().at("shared.py") !== undefined);

    expect(await mine.read("shared.py")).toEqual({ kind: "text", text: "theirs" });
    mine.stop();
    theirs.stop();
  });

  /**
   * The one this whole chain exists for.
   *
   * A consumer writing at the moments it cares about -- a debounce firing, an
   * explicit save, a snapshot taken because the user asked a question -- can
   * put several writes in the air before any of them is answered. Every one of
   * them used to read the same content token, so the server correctly refused
   * all but the first and the rest were dropped with the text still in them.
   */
  it("lands every write of a run against one file, in the order they were made", async () => {
    await workspace.create("chained.py", "").settled;
    await settledWhen(workspace, () => workspace.index().at("chained.py") !== undefined);

    const texts = ["one", "one\ntwo", "one\ntwo\nthree", "one\ntwo\nthree\nfour"];
    const sent = texts.map((text) => workspace.write("chained.py", text));
    const answers = await Promise.all(sent.map(({ settled }) => settled));

    expect(answers.map((answer) => answer.rejected)).toEqual([
      false,
      false,
      false,
      false,
    ]);

    await settledWhen(
      workspace,
      () =>
        workspace.index().at("chained.py")?.content_version ===
        sent[sent.length - 1]!.transaction,
    );
    expect(await workspace.read("chained.py")).toEqual({
      kind: "text",
      text: texts[texts.length - 1],
    });
  });

  /**
   * A snapshot names transactions, and this client shows its own work the
   * instant it makes it -- so a snapshot can name work that has never left
   * this machine, which nothing anywhere else can rebuild.
   */
  it("says which of a snapshot's transactions have not reached the server", async () => {
    const { transaction, settled } = workspace.create("portable.py", "x");

    expect(workspace.unsettled([transaction])).toEqual([transaction]);

    await settled;
    await settledWhen(
      workspace,
      () => workspace.unsettled([transaction]).length === 0,
    );
    expect(workspace.unsettled([transaction])).toEqual([]);
  });

  /**
   * A draft is on the server and rebuildable from it, which is the whole
   * reason it exists -- a snapshot naming one has to be portable, or the
   * assistant cannot be shown what the user is actually looking at.
   *
   * It is never any entry's version, though, so the confirmed map alone
   * would call it unsettled for ever.
   */
  it("counts a draft that reached the server as settled", async () => {
    const { transaction: born, settled: created } = workspace.create("kept.py", "x");
    await created;
    await settledWhen(workspace, () => workspace.unsettled([born]).length === 0);

    const entry = workspace.index().at("kept.py")!.id;
    const { transaction, settled } = workspace.keep(entry, "x typed alone");
    expect(workspace.unsettled([transaction])).toEqual([transaction]);

    await settled;
    expect(workspace.unsettled([transaction])).toEqual([]);
  });
});
