/**
 * Measurements, not assertions.
 *
 *     WSFS_BACKEND=http://localhost:8099 npx vitest run performance
 *
 * The point is a number to compare against the same number after a change, so
 * this prints a table and asserts only that nothing hung. Thresholds would
 * make it a flaky test on a shared machine; a recorded number makes it
 * evidence.
 */
import { beforeAll, expect, it } from "vitest";

import { connect, inMemory, mint, type Workspace } from "../../release/frontend";
import { describeLive, project, reachable, transport } from "./backend";

type Measured = { what: string; runs: number; totalMs: number };

const measurements: Measured[] = [];

/** These do real network work on purpose, so the default per-test budget is
 * far too small -- a deep tree is built one confirmed level at a time. */
const MEASURING = 180_000;

const timed = async (what: string, runs: number, work: () => Promise<unknown>) => {
  const started = performance.now();
  await work();
  const totalMs = performance.now() - started;
  measurements.push({ what, runs, totalMs });
  return totalMs;
};

const settled = (workspace: Workspace, holds: () => boolean, within = 30_000) =>
  new Promise<void>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error(`never settled`)), within);
    const finish = () => (clearTimeout(deadline), stop(), done());
    const stop = workspace.watch(() => holds() && finish());
    if (holds()) finish();
  });

const opened = async () =>
  connect({ workspace: await project(), transport: transport(), bytes: inMemory() });

const padded = (value: string, width: number) => value.padEnd(width);

const report = () => {
  const widest = Math.max(...measurements.map(({ what }) => what.length));
  const lines = measurements.map(
    ({ what, runs, totalMs }) =>
      `  ${padded(what, widest)}  ${totalMs.toFixed(1).padStart(9)} ms` +
      `  ${(totalMs / runs).toFixed(2).padStart(8)} ms/run`,
  );
  process.stdout.write(`\nwsfs cost\n${lines.join("\n")}\n\n`);
};

describeLive("cost", () => {
  beforeAll(async () => {
    if (!(await reachable())) throw new Error("WSFS_BACKEND is set but not answering");
  });

  it("measures a cold connect against an empty workspace", async () => {
    const workspace = await opened();
    const elapsed = await timed("connect, empty workspace", 1, () =>
      settled(workspace, () => true),
    );
    workspace.stop();
    expect(elapsed).toBeGreaterThan(0);
  }, MEASURING);

  it("measures creates, and the connect that has to snapshot them", async () => {
    const id = await project();
    const workspace = connect({
      workspace: id,
      transport: transport(),
      bytes: inMemory(),
    });
    await settled(workspace, () => true);

    const count = 50;
    await timed(`create x${count}`, count, async () => {
      for (let n = 0; n < count; n += 1) {
        await workspace.create(`file-${n}.py`, `# file ${n}\n`).settled;
      }
      await settled(workspace, () => workspace.index().paths().length >= count);
    });
    workspace.stop();

    const rejoining = connect({
      workspace: id,
      transport: transport(),
      bytes: inMemory(),
    });
    const elapsed = await timed(`connect, ${count} entries`, 1, () =>
      settled(rejoining, () => rejoining.index().paths().length >= count),
    );
    rejoining.stop();
    expect(elapsed).toBeGreaterThan(0);
  }, MEASURING);

  /**
   * Depth is the axis the server pays for: judging a placement walks from the
   * parent to the root, and every rung of that walk is a query. These are the
   * numbers that move when the walk gets cheaper, and the flat cases above
   * are the ones that barely notice.
   */
  const nested = async (workspace: Workspace, depth: number) => {
    let at = "";
    for (let level = 0; level < depth; level += 1) {
      at = at === "" ? `level-${level}` : `${at}/level-${level}`;
      await workspace.folder(at).settled;
      // Each level is the next one's parent, and a parent has to be CONFIRMED
      // before a child can name it -- otherwise this measures the sync loop
      // catching up rather than the server judging a placement.
      const holder = at;
      await settled(workspace, () => workspace.index().at(holder) !== undefined);
    }
    return at;
  };

  const DEPTH = 12;

  it("measures creates into a deeply nested folder", async () => {
    const workspace = await opened();
    const deepest = await nested(workspace, DEPTH);

    const count = 25;
    await timed(`create x${count} at depth ${DEPTH}`, count, async () => {
      for (let n = 0; n < count; n += 1) {
        await workspace.create(`${deepest}/file-${n}.py`, `# ${n}\n`).settled;
      }
      await settled(workspace, () => workspace.index().under(deepest).length >= count);
    });

    workspace.stop();
  }, MEASURING);

  it("measures moves into a deeply nested folder", async () => {
    const workspace = await opened();
    const deepest = await nested(workspace, DEPTH);

    const count = 15;
    for (let n = 0; n < count; n += 1) await workspace.create(`mover-${n}.py`, "x").settled;
    await settled(workspace, () => workspace.index().paths().length >= DEPTH + count);

    await timed(`move x${count} to depth ${DEPTH}`, count, async () => {
      for (let n = 0; n < count; n += 1) {
        await workspace.move(`mover-${n}.py`, `${deepest}/mover-${n}.py`).settled;
      }
      await settled(workspace, () => workspace.index().under(deepest).length >= count);
    });

    workspace.stop();
  }, MEASURING);

  /**
   * One unit of work adjudicating a whole offline session. Every create in it
   * walks the same ancestors, which is the case the submission-level memo
   * exists for -- and it is only ONE unit of work if the outbox arrives in a
   * single `initialize`, so this drives the transport directly rather than
   * making a hundred round trips through the sync loop.
   */
  it("measures a deep offline session replayed in one initialize", async () => {
    const id = await project();
    const wire = transport();
    const workspace = connect({ workspace: id, transport: wire, bytes: inMemory() });
    const deepest = await nested(workspace, DEPTH);
    const folder = workspace.index().at(deepest)!.id;
    workspace.stop();

    const count = 100;
    const outbox = Array.from({ length: count }, (_, n) => ({
      op: "create" as const,
      transaction: mint(),
      id: mint(),
      type: "file" as const,
      name: `queued-${n}.py`,
      parent: folder,
      content: { type: "text" as const, content: `# ${n}\n` },
    }));

    const elapsed = await timed(
      `replay x${count} creates at depth ${DEPTH}`,
      count,
      async () => {
        const snapshot = await wire.initialize(id, outbox);
        expect(snapshot.applied).toHaveLength(count);
      },
    );
    expect(elapsed).toBeGreaterThan(0);
  }, MEASURING);

  it("measures the path index over a wide tree", async () => {
    const workspace = await opened();
    await settled(workspace, () => true);

    const count = 100;
    for (let n = 0; n < count; n += 1) {
      await workspace.create(`wide-${n}.py`, "x").settled;
    }
    await settled(workspace, () => workspace.index().paths().length >= count);

    await timed(`index over ${count} entries x200`, 200, async () => {
      for (let n = 0; n < 200; n += 1) workspace.index().paths();
    });

    workspace.stop();
    report();
  }, MEASURING);
});
