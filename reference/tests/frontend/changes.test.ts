/**
 * What `watch` says, and whether a consumer can act on it alone.
 *
 * The claim being tested is not that changes are emitted -- it is that they
 * are enough. The last block builds the consumer this exists for: a mirror
 * that keeps entry ids against paths, applies changes one at a time, and never
 * rebuilds. If it can stay equal to `workspace.index()` through local work,
 * remote work, and a refusal, the vocabulary is complete.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connect, inMemory, type Change, type Workspace } from "../../release/frontend";
import type {
  Id,
  Metadata,
  Response,
  Snapshot,
  StreamEvent,
  Submitted,
} from "../../release/frontend/contract";
import { mint } from "../../release/frontend/identity";
import type { Reading, Transport } from "../../release/frontend/transport";

const WORKSPACE = mint();

/**
 * A server this test drives by hand: nothing is answered until it is told to,
 * so the order a response and its event arrive in is a thing under test rather
 * than a thing to hope about.
 */
const standing = () => {
  const submitted: Submitted[] = [];
  const answers = new Map<string, (response: Response) => void>();
  let reading: Reading | undefined;
  let entries: Metadata[] = [];

  const transport: Transport = {
    initialize: async (): Promise<Snapshot> => ({
      token: "token",
      entries,
      applied: [],
      rejected: [],
    }),
    submit: (_workspace, request) => {
      submitted.push(request);
      return new Promise<Response>((answer) => answers.set(request.transaction, answer));
    },
    content: async () => ({ kind: "text", text: "" }),
    store: async () => undefined,
    follow: (_workspace, _token, listening) => {
      reading = listening;
      listening.alive();
      return { close: () => (reading = undefined) };
    },
  };

  return {
    transport,
    submitted,
    /** Answer a request this client sent, by the transaction it minted. */
    accept: (transaction: string) => answers.get(transaction)?.({ rejected: false }),
    refuse: (transaction: string, reason = "conflict") =>
      answers.get(transaction)?.({ rejected: true, reason }),
    /** Push an event, as any client's work reaching this one. */
    announce: (event: StreamEvent) => reading?.event(event),
    holding: (given: Metadata[]) => (entries = given),
  };
};

/**
 * Long enough for the client to finish reacting. A mutation stages its content
 * and puts its bytes away before it queues anything, so "after the call" is
 * several turns, not one.
 */
const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((done) => setTimeout(done, 0));
};

/**
 * An entry as the SERVER would record it: every token is the transaction that
 * made it, because identity is client-minted end to end and the server writes
 * down the id it was given. Getting that wrong in a fixture would hide the one
 * property this whole file is about.
 */
const born = (over: Partial<Metadata> = {}, at = mint()): Metadata => ({
  id: mint(),
  type: "file",
  name: "given.py",
  parent: null,
  name_version: at,
  parent_version: at,
  deleted_version: at,
  content_version: at,
  ...over,
});

/** What the server would store for a create this client sent. */
const accepted = (
  entry: Id,
  transaction: string,
  over: Partial<Metadata> = {},
): Metadata => born({ id: entry, ...over }, transaction);

describe("what a workspace says changed", () => {
  let server: ReturnType<typeof standing>;
  let workspace: Workspace;
  let seen: Change[];
  let detach: (() => void) | undefined;

  const attach = async (entries: Metadata[] = []) => {
    server.holding(entries);
    workspace = connect({ workspace: WORKSPACE, transport: server.transport, bytes: inMemory() });
    await settle();
    detach = workspace.watch((changes) => seen.push(...changes));
  };

  beforeEach(() => {
    server = standing();
    seen = [];
    detach = undefined;
  });

  // A workspace left running keeps recomputing, and its listener would report
  // the next test's changes into the next test's array.
  afterEach(() => {
    detach?.();
    workspace?.stop();
  });

  it("hands back the transaction before it announces the change it makes", async () => {
    await attach();

    const created = workspace.create("a.py", "hello");

    // In hand before anything is announced, which is the whole point: a
    // consumer that only learned this when the promise resolved would learn
    // it after being told about its own work.
    expect(typeof created.transaction).toBe("string");
    expect(seen).toEqual([]);

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "appeared",
      entry: created.entry,
      by: created.transaction,
    });
  });

  it("says only that it landed when the server confirms this client's own work", async () => {
    await attach();
    const created = workspace.create("a.py", "hello");
    await settle();
    seen = [];

    server.accept(created.transaction);
    server.announce({
      type: "create",
      id: created.entry,
      transaction: created.transaction,
      value: accepted(created.entry, created.transaction, { name: "a.py" }),
    });
    await settle();

    // The overlay's removal and the confirmed value cancel exactly, so
    // nothing describes the file as having changed -- a consumer acting on
    // that would be undoing and redoing its own work. What IS said is that
    // the work landed, which no value can say and something has to.
    expect(seen).toEqual([
      { kind: "accepted", entry: created.entry, by: created.transaction },
    ]);
    expect(workspace.index().paths()).toEqual(["a.py"]);
  });

  it("takes a refused create back, and does not blame the transaction for it", async () => {
    await attach();
    const created = workspace.create("a.py", "hello");
    await settle();
    seen = [];

    server.refuse(created.transaction);
    await created.settled;
    await settle();

    expect(seen).toHaveLength(1);
    // Marked as a retraction, which is what tells a consumer to act on a
    // transaction of its own rather than skip it.
    expect(seen[0]).toMatchObject({
      kind: "vanished",
      entry: created.entry,
      by: created.transaction,
      retracting: created.transaction,
    });
    expect(workspace.index().paths()).toEqual([]);
  });

  it("names the rename and the reparent a move makes, both under one transaction", async () => {
    const folder = born({ type: "folder", name: "src", content_version: null });
    const file = born({ name: "a.py" });
    await attach([folder, file]);

    const moved = workspace.move("a.py", "src/b.py");

    expect(seen).toEqual([
      { kind: "renamed", entry: file.id, from: "a.py", to: "b.py", by: moved.transaction },
      { kind: "reparented", entry: file.id, from: null, to: folder.id, by: moved.transaction },
    ]);
  });

  it("puts a refused move back under the token that was there all along", async () => {
    const file = born({ name: "a.py" });
    await attach([file]);
    const moved = workspace.move("a.py", "b.py");
    await settle();
    seen = [];

    server.refuse(moved.transaction);
    await moved.settled;
    await settle();

    // One change, not two: the move kept the parent, and a parent that did not
    // move is not news however many transactions have spoken for it.
    expect(seen).toEqual([
      {
        kind: "renamed",
        entry: file.id,
        from: "b.py",
        to: "a.py",
        by: file.name_version,
        retracting: moved.transaction,
      },
    ]);
  });

  it("announces a write, which moves no value a reader of the metadata can see", async () => {
    const file = born({ name: "a.py" });
    await attach([file]);

    const written = workspace.write("a.py", "next");
    await settle();

    expect(seen).toEqual([{ kind: "written", entry: file.id, by: written.transaction }]);
  });

  it("announces somebody else's work under a transaction this client never minted", async () => {
    const file = born({ name: "a.py" });
    await attach([file]);
    const theirs = mint();

    server.announce({ type: "name", id: file.id, transaction: theirs, value: "theirs.py" });
    await settle();

    expect(seen).toEqual([
      { kind: "renamed", entry: file.id, from: "a.py", to: "theirs.py", by: theirs },
    ]);
  });

  it("announces a deletion and a restoration as different things", async () => {
    const file = born({ name: "a.py" });
    await attach([file]);
    const removed = workspace.remove("a.py");
    expect(seen).toEqual([{ kind: "removed", entry: file.id, by: removed.transaction }]);

    seen = [];
    server.refuse(removed.transaction);
    await removed.settled;
    await settle();
    expect(seen).toEqual([
      {
        kind: "restored",
        entry: file.id,
        by: file.deleted_version,
        retracting: removed.transaction,
      },
    ]);
  });
});

/**
 * The consumer this vocabulary exists for.
 *
 * It holds entry ids against the paths it has them at, applies one change at a
 * time, and rebuilds nothing. Anything it caused it skips, because it minted
 * the transaction. What it must agree with, after every step, is
 * `workspace.index()` -- which derives the same paths the long way round.
 */
class Following {
  readonly at = new Map<Id, string>();
  readonly mine = new Set<string>();

  constructor(private readonly workspace: Workspace) {}

  /** Every path it believes in, for comparing against the index. */
  paths(): string[] {
    return [...this.at.values()].sort();
  }

  /** A gesture of its own: remembered, so its echo can be ignored. */
  own<T extends { transaction: string }>(submitting: T): T {
    this.mine.add(submitting.transaction);
    return submitting;
  }

  apply(changes: readonly Change[]): void {
    for (const change of changes) {
      // Its own work taking effect it has already done. Its own work being
      // taken back it has not, and did not ask for.
      if (change.retracting === undefined && this.mine.has(change.by)) continue;
      this[change.kind](change as never);
    }
  }

  private placed(entry: Metadata): string | undefined {
    if (entry.deleted === true) return undefined;
    const holder = entry.parent == null ? "" : this.at.get(entry.parent);
    if (holder === undefined) return undefined;
    return holder === "" ? entry.name : `${holder}/${entry.name}`;
  }

  /** A folder moving takes everything under it, which is the point of ids. */
  private carry(entry: Id, from: string, to: string): void {
    for (const [id, path] of [...this.at])
      if (path === from || path.startsWith(`${from}/`))
        this.at.set(id, `${to}${path.slice(from.length)}`);
    this.at.set(entry, to);
  }

  private settle(entry: Id): void {
    const found = this.workspace.entries().get(entry);
    const path = found === undefined ? undefined : this.placed(found);
    const held = this.at.get(entry);
    if (path === undefined) return void this.at.delete(entry);
    if (held === undefined) return void this.at.set(entry, path);
    if (held !== path) this.carry(entry, held, path);
  }

  appeared({ entry }: Extract<Change, { kind: "appeared" }>) {
    this.settle(entry);
  }
  vanished({ entry }: Extract<Change, { kind: "vanished" }>) {
    this.at.delete(entry);
  }
  renamed({ entry }: Extract<Change, { kind: "renamed" }>) {
    this.settle(entry);
  }
  reparented({ entry }: Extract<Change, { kind: "reparented" }>) {
    this.settle(entry);
  }
  removed({ entry }: Extract<Change, { kind: "removed" }>) {
    this.at.delete(entry);
  }
  restored({ entry }: Extract<Change, { kind: "restored" }>) {
    this.settle(entry);
  }
  written() {}
}

describe("a consumer that only ever hears about changes", () => {
  let server: ReturnType<typeof standing>;
  let workspace: Workspace;
  let following: Following;
  let detach: () => void;

  const agrees = () =>
    expect(following.paths()).toEqual([...workspace.index().paths()].sort());

  /** What the server stores, and streams back, for a create it accepted. */
  const confirm = (
    created: { entry: Id; transaction: string },
    over: Partial<Metadata> = {},
  ) => {
    server.accept(created.transaction);
    server.announce({
      type: "create",
      id: created.entry,
      transaction: created.transaction,
      value: accepted(created.entry, created.transaction, over),
    });
  };

  beforeEach(async () => {
    server = standing();
    workspace = connect({ workspace: WORKSPACE, transport: server.transport, bytes: inMemory() });
    await settle();
    following = new Following(workspace);
    detach = workspace.watch((changes) => following.apply(changes));
  });

  afterEach(() => {
    detach();
    workspace.stop();
  });

  it("keeps up with its own work without being told twice", async () => {
    const src = following.own(workspace.folder("src"));
    // Its own create is skipped, so it places the row itself -- exactly what a
    // tree does when the user types a name into a row it is already drawing.
    following.at.set(src.entry, "src");

    const file = following.own(workspace.create("src/a.py", ""));
    following.at.set(file.entry, "src/a.py");
    await settle();
    agrees();

    server.accept(src.transaction);
    server.accept(file.transaction);
    server.announce({
      type: "create",
      id: src.entry,
      transaction: src.transaction,
      value: born({ id: src.entry, type: "folder", name: "src", content_version: null }),
    });
    server.announce({
      type: "create",
      id: file.entry,
      transaction: file.transaction,
      value: born({ id: file.entry, name: "a.py", parent: src.entry }),
    });
    await settle();

    // Confirmation announced nothing, so nothing was applied, and it is still
    // right: the optimistic view and the confirmed one agree by construction.
    agrees();
    expect(following.paths()).toEqual(["src", "src/a.py"]);
  });

  it("follows a folder somebody else renames, and carries its contents", async () => {
    const src = following.own(workspace.folder("src"));
    following.at.set(src.entry, "src");
    const file = following.own(workspace.create("src/a.py", ""));
    following.at.set(file.entry, "src/a.py");
    await settle();

    // Confirmed first: an entry that lives only in this client's outbox has
    // nothing for somebody else's event to land on.
    confirm(src, { type: "folder", name: "src", content_version: null });
    confirm(file, { name: "a.py", parent: src.entry });
    await settle();

    server.announce({ type: "name", id: src.entry, transaction: mint(), value: "lib" });
    await settle();

    // ONE change moved two paths, which is what an id-addressed consumer buys.
    agrees();
    expect(following.paths()).toEqual(["lib", "lib/a.py"]);
  });

  it("takes back a create the server refuses, though it was its own", async () => {
    const file = following.own(workspace.create("doomed.py", ""));
    following.at.set(file.entry, "doomed.py");
    await settle();

    server.refuse(file.transaction);
    await file.settled;
    await settle();

    agrees();
    expect(following.paths()).toEqual([]);
  });

  it("stays equal to the index through a mixed run it never rebuilt for", async () => {
    const src = following.own(workspace.folder("src"));
    following.at.set(src.entry, "src");
    const mine = following.own(workspace.create("src/mine.py", ""));
    following.at.set(mine.entry, "src/mine.py");
    await settle();

    confirm(src, { type: "folder", name: "src", content_version: null });
    confirm(mine, { name: "mine.py", parent: src.entry });
    await settle();
    agrees();

    const theirs = born({ name: "theirs.py" });
    server.announce({ type: "create", id: theirs.id, transaction: theirs.name_version, value: theirs });
    await settle();
    agrees();

    server.announce({ type: "move", id: theirs.id, transaction: mint(), value: { name: "moved.py", parent: src.entry } });
    await settle();
    agrees();

    const gone = following.own(workspace.remove("src/mine.py"));
    following.at.delete(mine.entry);
    await settle();
    agrees();

    server.refuse(gone.transaction);
    await gone.settled;
    await settle();

    // The refusal put it back, and the consumer heard about that even though
    // the delete had been its own.
    agrees();
    expect(following.paths()).toEqual(["src", "src/mine.py", "src/moved.py"]);
  });
});
