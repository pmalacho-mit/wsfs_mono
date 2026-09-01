/**
 * Two browsers, one room.
 *
 * Everything about collaboration that matters is a claim about what happens
 * BETWEEN clients, and a single browser cannot make one. Two `Workspace`s in
 * one page share an origin, and the moment local persistence lands they share
 * an IndexedDB too -- so a suite that passed there would be proving something
 * about one client talking to itself.
 *
 * So the same suite runs in Chromium and in Firefox at once, and each test
 * plays a different part depending on which one it is in. `me()` is which.
 *
 * The two cannot tell each other anything directly -- that is the thing under
 * test -- so they meet on the host, at `/rendezvous`. Two primitives are
 * enough: agreeing on a value neither of them can pick alone, and waiting for
 * the other to say it has got somewhere.
 */
import { createClient } from "@liveblocks/client";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";

import {
  connect,
  contract,
  http,
  persistenceMechanism,
  type Keeping,
  type Transport,
  type Workspace,
} from "$wsfs";

import {
  Rooms,
  become,
  type Replacement,
  type Room,
  type Written,
} from "../../../../../release/frontend/svelte/room.svelte";

import {
  hostedIn,
  persisting,
  untilSynchronized,
} from "../../../../../release/frontend/svelte/collaborator";
/** Stable, and few: the account is capped on how many users it may have. */
export const ADA = "ada@example.com";
export const GRACE = "grace@example.com";

export type Part = "ada" | "grace";

/**
 * Which browser this is, read off the report driver's own URL.
 *
 * The driver appends `?reportServer=<url>/<browser>` when it opens the page,
 * which makes the browser's name the one piece of identity already on hand --
 * no flag to pass, and nothing to keep in step with the runner.
 */
export const browser = (): string => {
  const reporting = new URL(location.href).searchParams.get("reportServer");
  const named = reporting?.split("/").filter(Boolean).pop();
  return named ?? "chromium";
};

/**
 * The part this browser plays. Chromium is Ada, everyone else is Grace.
 *
 * Arbitrary, and it has to be: what matters is only that the two browsers
 * disagree about who they are, so that a test can say "if I am Ada, type; if
 * I am Grace, wait and then check".
 */
export const me = (): Part => (browser() === "chromium" ? "ada" : "grace");

export const other = (): Part => (me() === "ada" ? "grace" : "ada");

export const emailOf = (part: Part) => (part === "ada" ? ADA : GRACE);

export const iAm = emailOf(me());

/** Whether this browser plays a given part -- the shape most tests branch on. */
export const playing = (part: Part) => me() === part;

const HOST = "";

/**
 * Propose a value; get back whatever the first proposal was.
 *
 * How the two browsers come to be in the same workspace at all. Both make one
 * and offer it; one of them is thrown away unused, which costs a row and
 * saves needing either browser to be told anything by the other.
 */
export const agree = async (
  key: string,
  candidate: string,
): Promise<string> => {
  const answer = await fetch(`${HOST}/rendezvous/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: candidate }),
  });
  if (!answer.ok) throw new Error(`rendezvous ${key}: ${answer.status}`);
  return ((await answer.json()) as { value: string }).value;
};

/** Say that something has happened, for the other browser to wait on. */
export const announce = (key: string, value = "done") => agree(key, value);

/**
 * Wait for the other browser to announce something.
 *
 * Polled rather than pushed, because a push would need a channel between the
 * two -- and every channel available is either the thing under test or another
 * thing that could be broken in the same way.
 */
export const awaiting = async (
  key: string,
  within = 30_000,
): Promise<string> => {
  const deadline = Date.now() + within;
  for (;;) {
    const answer = await fetch(`${HOST}/rendezvous/${encodeURIComponent(key)}`);
    if (answer.ok) return ((await answer.json()) as { value: string }).value;
    if (Date.now() > deadline)
      throw new Error(`waited ${within}ms for "${key}" and nobody arrived`);
    await new Promise((carry) => setTimeout(carry, 150));
  }
};

/**
 * A key nobody else's test will touch.
 *
 * Scoped by the suite's own agreed workspace, so two scenarios that both want
 * to say "I have finished typing" cannot hear each other.
 */
export const step = (workspace: string, scenario: string, name: string) =>
  `${workspace}:${scenario}:${name}`;

type LiveblocksClient = ReturnType<typeof createClient>;

const BACKEND = "/wsfs";

const asUser = (email: string) => async () => ({ "X-User-Email": email });

export const liveblocksClientAs = (email: string): LiveblocksClient =>
  createClient({
    authEndpoint: async (room) => {
      const answer = await fetch(
        `/liveblocks/token?rooms=${encodeURIComponent(room ?? "")}`,
        { headers: { "X-User-Email": email } },
      );
      if (!answer.ok)
        throw new Error(`token: ${answer.status} ${await answer.text()}`);
      return (await answer.json()) as { token: string };
    },
  });

export const enteringWith = (liveblocks: LiveblocksClient) =>
  ((entry, doc) => {
    const entered = liveblocks.enterRoom(entry);
    const provider = new LiveblocksYjsProvider(entered.room, doc);
    return {
      provider: Object.assign(provider, {
        ahead: () => provider.getStatus() === "synchronizing",
        handedOver: () => untilSynchronized(liveblocks, provider),
        watch: (changed: () => void) =>
          liveblocks.events.syncStatus.subscribe(changed),
      }),
      leave: () => entered.leave(),
    };
  }) satisfies ConstructorParameters<typeof Rooms>[1];

/**
 * The wire, with a switch on it.
 *
 * There is one for the ROOM already -- `drivable()` -- and none for the
 * server, so a client that could reach the collaboration server but not this
 * one was a state no test could reach. It is also the only way to make a
 * browser hold work long enough to prove the queue outlives the page.
 *
 * A refusal, not a hang: a socket that is not there fails, and a client that
 * waited for ever on one would be a different bug than the one being tested.
 */
export const switchable = (
  wire: Transport,
): Transport & { reachable: (now: boolean) => void } => {
  let reaching = true;
  const reach = () => {
    if (!reaching) throw new Error("the server cannot be reached");
  };
  return {
    reachable: (now) => (reaching = now),
    initialize: (workspace, replayed) => (
      reach(),
      wire.initialize(workspace, replayed)
    ),
    submit: (workspace, request) => (reach(), wire.submit(workspace, request)),
    content: (workspace, entry, version) => (
      reach(),
      wire.content(workspace, entry, version)
    ),
    store: (workspace, digest, bytes, mime) => (
      reach(),
      wire.store(workspace, digest, bytes, mime)
    ),
    settleRoom: (workspace, entry) => (reach(), wire.settleRoom(workspace, entry)),
    warmRoom: (workspace, entry) => (reach(), wire.warmRoom(workspace, entry)),
    roomStored: (workspace, entry, version) => (
      reach(),
      wire.roomStored(workspace, entry, version)
    ),
    handOver: (workspace, entry, update) => (
      reach(),
      wire.handOver(workspace, entry, update)
    ),
    ask: (workspace, asking) => (reach(), wire.ask(workspace, asking)),
    hear: (workspace, token) => wire.hear(workspace, token),
    progress: (workspace, asking) => (reach(), wire.progress(workspace, asking)),
    detected: (workspace, told) => (reach(), wire.detected(workspace, told)),
    accepted: (workspace, told) => (reach(), wire.accepted(workspace, told)),
    activity: (workspace, told, options) => (
      reach(),
      wire.activity(workspace, told, options)
    ),
    conversation: (workspace, asking) => (
      reach(),
      wire.conversation(workspace, asking)
    ),
    history: (workspace, entry, asking) => (
      reach(),
      wire.history(workspace, entry, asking)
    ),
    cleared: (workspace, transactions) => (
      reach(),
      wire.cleared(workspace, transactions)
    ),
    follow: (workspace, token, reading) => {
      if (!reaching) {
        queueMicrotask(() =>
          reading.failed(new Error("the server cannot be reached")),
        );
        return { close: () => {} };
      }
      return wire.follow(workspace, token, reading);
    },
  };
};

/**
 * One participant, as a test can drive one.
 *
 * The protocol itself is NOT here any more -- it is in `room.svelte.ts`, which
 * is the same code `Workspace.svelte` runs. That is the point: what these two
 * browsers prove is now a claim about the component a user touches rather than
 * about a second implementation that merely resembled it.
 *
 * What is left here is everything a scenario needs and a widget does not: the
 * identity to connect as, a network that can be taken away and given back, and
 * the snapshot/reconstruction round trip. It is still separate from
 * `Workspace.svelte` on purpose -- the claims are about what happens BETWEEN
 * two clients, and a monaco instance in the middle would only make a failure
 * harder to place.
 */
export class Collaborator {
  readonly part: Part;
  readonly email: string;
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly transport: Transport & { reachable: (now: boolean) => void };
  readonly liveblocks: LiveblocksClient;
  readonly rooms: Rooms;

  /**
   * Opened rather than constructed, because the durable outbox has to be read
   * before anything is served -- a client that answered reads first and found
   * its queued work afterwards would have shown a view missing its own.
   */
  static async opened(part: Part, workspaceId: string): Promise<Collaborator> {
    return new Collaborator(
      part,
      workspaceId,
      await persistenceMechanism(workspaceId),
    );
  }

  readonly held: Keeping;

  constructor(part: Part, workspaceId: string, held: Keeping) {
    this.held = held;
    this.part = part;
    this.workspaceId = workspaceId;
    this.email = emailOf(part);
    /**
     * Held as well as handed over, because reading a file at a version is
     * something a room needs for itself, and the transport already knows how
     * to tell text from bytes. A second reader written here would have to
     * learn that again, and would learn it wrong the first time a file turned
     * binary.
     */
    this.transport = switchable(http(BACKEND, asUser(this.email)));
    /**
     * Late-bound because the two need each other: `connect` asks whether a
     * document speaks for an entry, and the thing that knows is built ON the
     * workspace. A field read at call time is the whole of the knot.
     */
    this.workspace = connect({
      workspace: workspaceId,
      transport: this.transport,
      bytes: held.bytes,
      kept: held.kept,
      restored: held.restored,
      shared: (entry) => this.rooms.speaksFor(entry),
    });
    this.liveblocks = liveblocksClientAs(this.email);
    this.rooms = new Rooms(
      this.workspace,
      enteringWith(this.liveblocks),
      hostedIn(this.workspace),
      persisting,
    );
  }

  /** Whether this client can reach the server at all. */
  reachable(now: boolean): void {
    this.transport.reachable(now);
  }

  /** The version a room's text descends from, as the server stamped it. */
  base(entry: string): string | null {
    return this.rooms.get(entry)?.base ?? null;
  }

  path(entry: string): string | undefined {
    const index = this.workspace.index();
    for (const path of index.paths())
      if (index.at(path)?.id === entry) return path;
    return undefined;
  }

  /**
   * Work the server has been told about and nobody has said got out.
   *
   * The one question a client cannot answer for itself: the case worth
   * reporting is a machine that never came back.
   */
  async stranded(): Promise<string[]> {
    const answer = await fetch(
      `${BACKEND}/workspaces/${this.workspaceId}/drafts`,
      {
        headers: { "X-User-Email": this.email },
      },
    );
    if (!answer.ok) throw new Error(`stranded: ${answer.status}`);
    const { drafts } = (await answer.json()) as {
      drafts: { transaction: string }[];
    };
    return drafts.map(({ transaction }) => transaction);
  }

  /** What the server says this entry holds, now or at one version. */
  async reads(entry: string, version?: string): Promise<string> {
    const held =
      version === undefined
        ? await this.workspace.read(this.#path(entry))
        : await this.workspace.at(entry, version);
    return held !== undefined && held.kind === "text" ? held.text : "";
  }

  token(entry: string): string | null {
    return this.rooms.token(entry);
  }

  #room(entry: string): Room {
    const room = this.rooms.get(entry);
    if (room === undefined) throw new Error(`${entry} is not open here`);
    return room;
  }

  #path(entry: string): string {
    const path = this.path(entry);
    if (path === undefined) throw new Error(`${entry} has no path here`);
    return path;
  }

  /** Stop holding this file, without discarding what it was holding. */
  close(entry: string): Promise<void> {
    return this.rooms.close(entry);
  }

  async open(entry: string): Promise<void> {
    await this.rooms.open(entry);
  }

  text(entry: string): string {
    return this.rooms.get(entry)?.text.toString() ?? "";
  }

  /** Whether this room may answer for the file, and write it back. */
  attached(entry: string): boolean {
    return this.rooms.get(entry)?.attached === true;
  }

  /** Resolves once what was typed into this file has reached its room. */
  async handedOver(entry: string): Promise<void> {
    await this.rooms.get(entry)?.handedOver();
  }

  /** What this file's room would tell the person at the keyboard, if anything. */
  trouble(entry: string) {
    return this.rooms.get(entry)?.trouble;
  }

  speaks(entry: string): boolean {
    return this.rooms.get(entry)?.speaks === true;
  }

  replacement(entry: string): Replacement | undefined {
    return this.rooms.get(entry)?.replaced;
  }

  /** Type, as the one writer a document is allowed to have. */
  type(entry: string, next: string) {
    become(this.#room(entry).text, next);
  }

  store(entry: string): Promise<Written> {
    return this.#room(entry).store();
  }

  /** A write that does NOT go through the room -- a script, another tool. */
  writeAround(entry: string, text: string) {
    return this.workspace.write(this.#path(entry), text).settled;
  }

  /** Bytes over a file somebody may have open as text. */
  replace(entry: string, bytes: Uint8Array, mime: string) {
    return this.workspace.write(this.#path(entry), bytes, mime).settled;
  }

  goOffline(entry: string) {
    this.rooms.get(entry)?.detach();
  }

  comeBack(entry: string): Promise<void> {
    return this.#room(entry).reattach();
  }

  /**
   * The four tokens an entry stands at, as `reconstruction` asks for them.
   *
   * All four, not just the content one: together they ARE the entry -- what it
   * is called, where it lives, whether it is gone, and what is in it -- and a
   * snapshot naming all four can be rebuilt into the filesystem as it stood.
   */
  /**
   * Every snapshot this client took, and what it was showing at the time.
   *
   * `showing` is null when this client had no room for the entry: it was not
   * showing the text at all, so there is nothing to compare a rebuild
   * against -- but the snapshot still has to resolve.
   */
  readonly took: { versions: contract.Versions; showing: string | null }[] = [];

  /**
   * What this client is showing, named so the server can rebuild it.
   *
   * STORING FIRST IS THE POINT. A snapshot of text that exists nowhere else
   * names a version nobody can resolve, and the whole use of a snapshot is
   * being handed to something that will read it somewhere else. Whether the
   * text lands as the file's content or as a draft is the ordinary rule --
   * either way the server has it afterwards.
   */
  async take(entry: string): Promise<contract.Versions> {
    const open = this.rooms.get(entry) !== undefined;
    const showing = open ? this.text(entry) : null;
    const versions = {
      ...this.snapshot(entry),
      ...(await this.#putSomewhere(entry)),
    };
    this.took.push({ versions, showing });
    return versions;
  }

  /**
   * The version the text on screen went to the server as, if it had to go.
   *
   * Nothing to add when this client has no room for the entry: it is showing
   * what the server already holds, so the entry's own tokens name it.
   */
  async #putSomewhere(entry: string): Promise<{ content_version?: string }> {
    if (this.rooms.get(entry) === undefined) return {};
    const answer = await this.store(entry);
    if (!answer.held) return { content_version: answer.transaction };
    return answer.draft === null ? {} : { content_version: answer.draft };
  }

  /**
   * Every snapshot taken this session, asked of the server.
   *
   * The question is not "did the file end up right" -- it is whether what
   * this client was LOOKING AT can still be handed to somebody else, which is
   * a different thing and the one a client typing on its own can quietly
   * lose.
   */
  async rebuildable(): Promise<void> {
    await this.#reachable(this.took.map(({ versions }) => versions));
    for (const [at, { versions, showing }] of this.took.entries())
      await this.#rebuiltAs(at, versions, showing);
  }

  /**
   * One request per snapshot, and that is not incidental.
   *
   * A reconstruction answers once per ENTRY, so two snapshots of the same
   * file taken at different moments come back as one answer -- and comparing
   * the later one against it silently passes or silently lies.
   */
  async #rebuiltAs(
    at: number,
    versions: contract.Versions,
    showing: string | null,
  ): Promise<void> {
    const [answer] = await this.rebuild([versions]);
    if (answer === undefined)
      throw new Error(`snapshot ${at} came back with nothing`);
    if (answer.unresolved.length > 0)
      throw new Error(
        `snapshot ${at} unresolved: ${JSON.stringify(answer.unresolved)}`,
      );
    if (showing === null) return;
    const said =
      answer.content?.type === "text" ? answer.content.content : undefined;
    if (said !== showing)
      throw new Error(
        `snapshot ${at} at ${versions.content_version} rebuilt as ` +
          `${JSON.stringify(said)}, not what was shown ${JSON.stringify(showing)}`,
      );
  }

  async #reachable(taken: readonly contract.Versions[]): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = this.unsettled(taken);
      if (waiting.length === 0) return;
      if (Date.now() > deadline)
        throw new Error(`never reached the server: ${JSON.stringify(waiting)}`);
      await new Promise((carry) => setTimeout(carry, 100));
    }
  }

  snapshot(entry: string): contract.Versions {
    const held = this.workspace.entries().get(entry);
    if (held === undefined)
      throw new Error(`${entry} is not in this workspace`);
    return {
      id: held.id,
      name_version: held.name_version,
      parent_version: held.parent_version,
      deleted_version: held.deleted_version,
      content_version: held.content_version ?? null,
    };
  }

  /**
   * Which of a snapshot's tokens have never left this machine.
   *
   * Empty is what makes a snapshot portable: anything else names work sitting
   * in this client's outbox, which nothing on the server can rebuild.
   */
  unsettled(taken: readonly contract.Versions[]): string[] {
    const tokens = taken.flatMap((entry) =>
      [
        entry.name_version,
        entry.parent_version,
        entry.deleted_version,
        entry.content_version,
      ].filter((token): token is string => typeof token === "string"),
    );
    return this.workspace.unsettled(tokens);
  }

  /** What the server says those transactions said. */
  async rebuild(
    taken: readonly contract.Versions[],
  ): Promise<contract.Reconstructed[]> {
    const answer = await fetch(
      `${BACKEND}/workspaces/${this.workspaceId}/reconstruction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Email": this.email,
        },
        body: JSON.stringify({ entries: taken }),
      },
    );
    if (!answer.ok)
      throw new Error(
        `reconstruction: ${answer.status} ${await answer.text()}`,
      );
    return ((await answer.json()) as contract.ReconstructionResponse).entries;
  }

  async dispose(): Promise<void> {
    await this.rooms.dispose();
    this.workspace.stop();
    /**
     * And wait for the queue's own bookkeeping to reach the disk.
     *
     * This teardown CAN wait, so not waiting would throw away answers that
     * were on their way -- and the next client to open would call work that
     * is safely on the server unsettled.
     */
    await this.held.flushed();
  }
}
