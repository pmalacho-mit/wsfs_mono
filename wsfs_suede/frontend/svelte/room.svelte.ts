/**
 * Joining one file's shared document, for the widget and for the suite.
 *
 * WHAT THIS NO LONGER DOES is most of what it used to. A client used to hear
 * that its file had moved, read the file at two versions, diff them, and type
 * the difference into its own document -- which creates NEW characters, so
 * when the original author's edits arrived carrying their own identity, both
 * copies survived and the file said everything twice.
 *
 * Text is now carried into a room by the server, once, and reaches every
 * member as an ordinary update. What is left here is the provider, the rule
 * about when this client may write the file back, and the one thing only a
 * reader can find out: that the file stopped being text at all.
 */
import * as Y from "yjs";

import {
  contract,
  deltaBetween,
  editsFor,
  rooms,
  type Change,
  type Workspace,
} from "..";

/** What a room needs a provider to be able to do. */
export type Provider = {
  readonly synced: boolean;
  once: (event: "synced", handler: () => void) => void;
  /** Calls back whenever `ahead` may have changed. Returns an unsubscribe. */
  watch: (changed: () => void) => () => void;
  /**
   * Whether this client is holding changes the server has not confirmed.
   *
   * The `ahead` of `SCENARIOS.md`, and the question a store turns on. Being
   * BEHIND -- missing somebody else's typing -- is harmless and is not this.
   */
  ahead: () => boolean;
  /** Settles once nothing this client holds is still on its way. */
  handedOver: () => Promise<void>;
  destroy: () => void;
};

/**
 * Joining the shared document for one entry.
 *
 * The DOCUMENT IS THE ROOM'S, and is handed in rather than taken from the
 * provider. A room outlives its providers -- that is what makes a network
 * lapse survivable -- so a document owned by the provider would be thrown away
 * with it, taking everything typed during the lapse.
 */
export type Enter = (
  entry: string,
  doc: Y.Doc,
) => { provider: Provider; leave: () => void };

/** What a room asks of the host that keeps it. */
export type Host = {
  /**
   * Make this entry's room exist and say what the file says, and answer where
   * it now stands.
   *
   * Where it stands is the host's to keep, not the document's: in the
   * document, advancing it is a write, so one person saving would cost a
   * round trip to the collaboration server for every client that heard.
   */
  settle: (entry: string) => Promise<string | null>;

  /** A member of this room wrote the file, so the room already holds the text. */
  stored: (entry: string, version: string) => Promise<void>;

  /**
   * Put this client's own update into the room for it.
   *
   * The one thing a client cannot do for itself when it can reach the host
   * and not the collaboration server, and losing that connection should cost
   * the direct route to everybody else rather than everybody else.
   */
  handOver: (entry: string, update: Uint8Array) => Promise<void>;
};

/**
 * Keeping this document on THIS MACHINE, so a tab closing does not lose it.
 *
 * The rung below the room. Work reaches here the moment it is typed, before
 * anybody else could possibly have it, and it is what makes a crash survivable
 * -- see `SCENARIOS.md`, E2 and E3.
 */
export type Persist = (
  entry: string,
  doc: Y.Doc,
) => { loaded: Promise<void>; stop: () => Promise<void> };

/**
 * Why a room is not writing its file back, when it is not.
 *
 * One statement of the rule, read by the thing that decides and by the thing
 * that tells the person -- the decision and its explanation drifting apart is
 * how a user ends up looking at a banner that is no longer true.
 */
export type Trouble = {
  /** What to tell the person at the keyboard. */
  says: string;
  /**
   * Whether this passes on its own.
   *
   * True for everything that is a connection: the work is kept, and it
   * becomes the file when the room comes back. False when the file stopped
   * being this room's text, which nothing here undoes.
   */
  passing: boolean;
};

/** What ended a room that was showing text. */
export type Replacement = {
  entry: string;
  at: contract.Version;
  /** The mime the file became, or `null` when it was deleted instead. */
  mime: string | null;
  /** Where the text it was showing went, so that it is not lost with the room. */
  kept: contract.Transaction | null;
};

/**
 * Why a room out of touch did not write the file back, and where the work went.
 *
 * Held from the FILE, not from the server: the text is recorded as a draft, so
 * it is durable and recoverable the moment it is typed. Nothing is waiting to
 * be retried.
 */
export type Held = {
  held: true;
  why: string;
  /** The draft the text went into, or `null` when there was no text to keep. */
  draft: contract.Transaction | null;
  /**
   * The draft reaching the server, for a caller that needs it to have.
   *
   * Named alongside the transaction rather than awaited before returning it,
   * because `send` answers synchronously -- a caller describing what the user
   * is looking at needs the id at the moment it asks. `store` waits.
   */
  settled: Promise<contract.Response> | null;
};

/**
 * A write on its way, named before it is answered.
 *
 * The transaction is known SYNCHRONOUSLY, because a caller describing what the
 * user is looking at needs it at the moment it asks -- waiting on the answer
 * would describe a later moment than the one it was asked about.
 */
export type Sending =
  | Held
  | {
      held: false;
      transaction: contract.Transaction;
      settled: Promise<contract.Response>;
    };

/** The same write, once the server has ruled on it. */
export type Written =
  | Held
  | { held: false; transaction: contract.Transaction; rejected: boolean };

const CONTENT = "content";

/**
 * Make a shared text say `next`, changing as little as possible.
 *
 * Never a replacement. The positions a CRDT hands out are what let two people
 * type in one paragraph at once, and clearing the text throws every one of
 * them away -- so a "replace" between two clients is how one of them silently
 * undoes the other.
 */
export const become = (text: Y.Text, next: string) => {
  const edits = editsFor(deltaBetween(text.toString(), next));
  if (edits.length === 0) return;
  (text.doc as Y.Doc).transact(() => {
    for (const edit of edits) {
      if ("insert" in edit) text.insert(edit.at, edit.insert);
      else text.delete(edit.at, edit.remove);
    }
  });
};

/** One file's room, and what it knows about the file underneath it. */
export class Room {
  readonly doc = new Y.Doc();

  /**
   * Whether an editor may bind to this room's text.
   *
   * FALSE UNTIL THE DOCUMENT HAS BEEN RECEIVED, and that is the whole reason
   * it exists. `MonacoBinding` makes the editor say whatever the `Y.Text` says
   * the moment it is constructed -- so binding an empty document does not show
   * an empty file, it MAKES one, and the next store writes that over the real
   * thing.
   */
  ready = $state(false);

  /**
   * Set once the file stopped being text this room could show.
   *
   * Terminal, and not a repair: a room holding a `Y.Text` has nothing to merge
   * bytes into. What the user is looking at is now a picture of a file that no
   * longer exists, and this is what says so.
   */
  replaced = $state<Replacement | undefined>(undefined);

  /** Reaching the others right now. Reactive, because a banner depends on it. */
  attached = $state(false);

  /**
   * How far opening this room has got.
   *
   * Opening is four waits in a row and any of them can be the one that never
   * finishes. Without this, all four look identical from outside: a promise
   * that has not settled and a file that never binds.
   */
  opening = $state("not started");

  /**
   * Heard something while detached, and has not caught up since.
   *
   * Nothing more is remembered, deliberately: whatever happened while the room
   * was away is ONE gap between what it holds and what the file says, and the
   * server closes a gap of any size in one go.
   */
  #missed = $state(false);

  #provider: Provider | undefined;
  #leave: (() => void) | undefined;
  #unwatch: (() => void) | undefined;
  #stopKeeping: (() => Promise<void>) | undefined;

  /**
   * Drafts made because this room was reaching nobody.
   *
   * Held until the work in them has gone out, which is the same predicate
   * that made them, flipped. NOT the drafts made because the file stopped
   * being this room's text -- that work never got out and never will, and
   * saying otherwise would hide the one thing worth reporting.
   */
  #waiting: contract.Transaction[] = [];
  /**
   * The attach in flight, so that a second caller waits for the first.
   *
   * Returning early on "a provider exists" is not the same question: a
   * provider that has been constructed but has not yet received the document
   * is exactly the state everything here is careful not to act in.
   */
  #attaching: Promise<void> | undefined;

  constructor(
    readonly entry: string,
    readonly held: Rooms,
  ) {}

  get text(): Y.Text {
    return this.doc.getText(CONTENT);
  }

  /**
   * The version this room's text descends from, as the host last said.
   *
   * Held here rather than in the document. It is bookkeeping, the host is the
   * only thing that decides it, and a document is an expensive place to keep
   * anything that changes every time somebody saves.
   */
  base = $state<string | null>(null);

  /**
   * Whether this room may answer for the file, and write it back.
   *
   * A room that cannot reach the others holds text they have not been given.
   * Storing it makes the server tell them about a write whose content is still
   * in flight, and nothing good follows from that -- see `rooms.speaking`.
   */
  get speaks(): boolean {
    return this.#withheld === undefined;
  }

  /**
   * What stands between this room and the file, if anything does.
   *
   * Reactive, because a person typing into a document that is reaching
   * nobody should be told so -- and because the alternative to one answer is
   * two, one for the rule and one for the banner, drifting apart.
   */
  /**
   * Why this room may not write the file back, if it may not.
   *
   * The rule, whole. `speaks` is this being absent, and `trouble` is the part
   * of it worth interrupting somebody about -- which is not the same set, and
   * conflating them is what made the editor jump on every keystroke.
   */
  get #withheld(): (Trouble & { sayable: boolean }) | undefined {
    if (this.replaced !== undefined)
      return {
        says: "this file is not text any more",
        passing: false,
        sayable: true,
      };
    if (this.#ahead)
      return {
        says: "still handing over what you typed",
        passing: true,
        /**
         * NOT SAID. This is the healthy path: it is true for a fraction of a
         * second after every burst of typing, and it means the client is
         * doing exactly what it should. Telling somebody about it while they
         * type is noise -- and a notice that appears and disappears that
         * often is worse than noise if it moves anything.
         */
        sayable: false,
      };
    if (rooms.speaking({ attached: this.attached, behind: this.#missed }))
      return undefined;
    return {
      says: this.attached ? "catching up" : "not reaching anybody",
      passing: true,
      sayable: true,
    };
  }

  /** What is worth telling the person at the keyboard, if anything. */
  get trouble(): Trouble | undefined {
    const held = this.#withheld;
    if (held === undefined || !held.sayable) return undefined;
    return { says: held.says, passing: held.passing };
  }

  /**
   * Holding text the server has not got, so nobody else can have it either.
   *
   * Storing now would have the server tell the others about a write whose
   * content is still in flight, and carry it into their document -- and then
   * this client's own copy would arrive and say it a second time.
   */
  #ahead = $state(false);

  /**
   * The stream says this entry's content moved.
   *
   * A DETACHED ROOM DOES NOT ACT. Everything it might do -- learning the file
   * turned binary, asking the server to bring the room up to date -- is done
   * on the way back in, and doing it now would act on a document that is about
   * to be merged with everybody else's.
   */
  heard(transaction: contract.Transaction) {
    if (!this.attached) {
      this.#missed = true;
      return;
    }
    void this.#told(transaction).catch(() => this.#findOut());
  }

  /**
   * READING THE FILE IS HOW A ROOM FINDS OUT IT IS OVER. Nothing in a token
   * says whether it names text or bytes, so this read is the first moment
   * anybody here can know -- and it is the only reason a client reads a
   * version it did not ask for.
   */
  async #told(transaction: contract.Transaction) {
    const held = await this.held.workspace.at(this.entry, transaction);
    if (held.kind === "binary") {
      await this.standDown(transaction, held.mime);
      return;
    }
    await this.catchUp();
  }

  /**
   * The read that would have said whether this file is still text did not
   * come back.
   *
   * Routinely benign: the token can name a write of this client's own that
   * the server has not issued as a version yet, and reading a version nobody
   * has heard of is refused. So the answer is to ASK AGAIN -- have the server
   * bring the room up to whatever the file now says -- rather than to stand
   * down, which would leave the room mute for ever over a request that was
   * never going to be answered.
   *
   * Standing down is what happens when even that cannot be answered, because
   * then there is genuinely nothing this room knows.
   */
  async #findOut(): Promise<void> {
    try {
      await this.catchUp();
    } catch {
      this.#missed = true;
    }
  }

  /**
   * Bring back what this machine was holding.
   *
   * Before anything else, so that a document which was ahead when the tab
   * closed is ahead again when it opens -- rather than looking empty and
   * being filled with something older.
   */
  async recall(): Promise<void> {
    if (this.#stopKeeping !== undefined) return;
    const { loaded, stop } = this.held.persist(this.entry, this.doc);
    this.#stopKeeping = stop;
    await loaded;
  }

  /**
   * Store work that reached the room and never reached the file.
   *
   * The last session's typing can sit at the room's rung and no further: it
   * was shared, so nobody lost it while the room was alive, and then everyone
   * closed before a store landed. It survives only until the room is evicted.
   *
   * Whoever opens the file next is the one who can still see it, so they are
   * the one who stores it. Free when there is nothing to do, which is almost
   * always.
   */
  async storeWhatNobodyStored(): Promise<void> {
    if (!this.speaks) return;
    const path = this.held.path(this.entry);
    if (path === undefined) return;
    const stored = await this.held.workspace.read(path);
    if (stored?.kind !== "text") return;
    if (stored.text === this.text.toString()) return;
    await this.store();
  }

  /** Resolves once everything typed here has reached the room. */
  async handedOver(): Promise<void> {
    await this.#provider?.handedOver();
  }

  /** Have the server bring this room up to whatever the file now says. */
  async catchUp(): Promise<void> {
    this.base = await this.held.host.settle(this.entry);
    this.#missed = false;
  }

  /**
   * Store what the document says as a version.
   *
   * The write is claimed BEFORE it is sent, because the answer may never come
   * -- and the server reads that claim to tell a write the room made from one
   * it did not, which is what stops its own text being carried back in.
   */
  send(): Sending {
    const trouble = this.trouble;
    if (trouble !== undefined) return this.#kept(trouble.says);

    const { transaction, settled } = this.held.workspace.shares(
      this.entry,
      this.text.toString(),
    );

    /**
     * Taken back here rather than by whoever awaits, so that a caller which
     * never awaits at all still leaves the bookkeeping straight. A refusal
     * never became content, so nothing about the room's base changed.
     */
    /**
     * Told, not discovered. The room already holds this text, so the host
     * only has to be told where the file now stands -- and every other client
     * that hears about this write then costs nothing to answer.
     */
    void settled.then((answer) => {
      if (answer.rejected) return;
      this.base = transaction;
      /**
       * TOLD AT ONCE, and not after the hand-over, which was tried and is
       * worse. Waiting until the others really had it sounds safer -- an
       * unsaid note leaves the host thinking the room is where it last was,
       * so the next settle fills it from the file. But the note is also what
       * keeps `base` level with the file, and a room whose base is behind
       * while its text is ahead is the one case the host CARRIES a change
       * into: it computes what the file gained since that base and applies
       * it to a document that already has it, so the line is said twice.
       *
       * Losing the note is the cheaper failure. The host compares the room's
       * text with the file before carrying anything, so a room that already
       * says it is rebased rather than written to.
       */
      void this.held.host.stored(this.entry, transaction);
    });
    return { held: false, transaction, settled };
  }

  /**
   * Text nobody else has, put somewhere it cannot be lost.
   *
   * Not the file's content, because the others have not been shown it: making
   * it the file would either drop it -- their next store would not contain it
   * -- or have the server carry it into their documents, where this client's
   * own copy would arrive and say it twice.
   */
  #kept(why: string): Held {
    const { transaction, settled } = this.held.workspace.keep(
      this.entry,
      this.text.toString(),
    );
    if (this.replaced === undefined) {
      this.#waiting.push(transaction);
      void this.#carriedByTheHost();
    }
    return { held: true, why, draft: transaction, settled };
  }

  /**
   * Ask the host to put what this document holds into the room.
   *
   * Losing the collaboration server should not mean losing collaboration --
   * only losing the direct route to it. Sent as an update rather than as
   * text, so it merges exactly once however many ways it arrives, including
   * this client's own connection when that comes back.
   */
  async #carriedByTheHost(): Promise<void> {
    if (this.replaced !== undefined) return;
    try {
      await this.held.host.handOver(this.entry, Y.encodeStateAsUpdate(this.doc));
    } catch {
      /**
       * BEST EFFORT, and nothing is lost when it fails.
       *
       * This is the route round a collaboration server this client cannot
       * reach. When the HOST cannot be reached either there is no route left
       * -- and the work is already where it needs to be: in the document, and
       * in the draft that was just kept. It goes when a connection comes
       * back, by whichever road returns first.
       *
       * Uncaught, this was an unhandled rejection every time a client lost
       * both at once, which is not a rare pairing: they are usually the same
       * network.
       */
    }
  }

  /**
   * The work these drafts hold has reached everybody else.
   *
   * Told to the server rather than remembered here: the case worth reporting
   * is a machine that never comes back, and a note kept only on that machine
   * goes with it.
   */
  async #handedOn(): Promise<void> {
    if (this.#waiting.length === 0) return;
    const gone = this.#waiting;
    this.#waiting = [];
    await this.held.workspace.cleared(gone);
  }

  /**
   * Waits for what this client is holding to reach the server, then stores.
   *
   * Storing text that is still on its way is the whole hazard: the server
   * would see a write whose content the room does not have, carry it in, and
   * then this client's own copy would arrive and say it twice. Typing and
   * immediately storing is the ORDINARY case, so this waits rather than
   * refusing -- `send` is the one that refuses, and by then there is nothing
   * left to wait for.
   */
  async store(): Promise<Written> {
    if (this.attached) await this.#provider?.handedOver();
    const sent = this.send();
    if (sent.held) {
      await sent.settled;
      return sent;
    }
    const answer = await sent.settled;
    return {
      held: false,
      transaction: sent.transaction,
      rejected: answer.rejected,
    };
  }

  /**
   * Bytes landing over this file from somewhere local -- a kernel, a tool.
   *
   * The remote case arrives through `heard` and is found out by reading the
   * file. This is the same conclusion reached one step earlier, by a caller
   * that already has the bytes in its hand and knows they are not text.
   */
  tookAway(at: contract.Version, mime: string): Promise<void> {
    return this.standDown(at, mime);
  }

  /**
   * The file stopped being this room's text, and the room goes quiet.
   *
   * WHAT WAS ON SCREEN IS PUT SOMEWHERE FIRST. A room holding a `Y.Text` has
   * nothing to merge bytes into and nothing to say about a file that is gone,
   * so this is terminal -- and terminal without keeping the text would mean a
   * deletion or a kernel's output silently taking work its author never
   * stored. Nobody chose that; it just happened to them.
   */
  async standDown(at: contract.Version, mime: string | null): Promise<void> {
    if (this.replaced !== undefined) return;
    const kept = await this.#keepWhatWasShowing();
    this.replaced = { entry: this.entry, at, mime, kept };
  }

  async #keepWhatWasShowing(): Promise<contract.Transaction | null> {
    const showing = this.text.toString();
    if (showing.length === 0) return null;
    const { transaction, settled } = this.held.workspace.keep(
      this.entry,
      showing,
    );
    await settled;
    return transaction;
  }

  attach(): Promise<void> {
    return (this.#attaching ??= this.#attached());
  }

  async #attached(): Promise<void> {
    const { provider, leave } = this.held.enter(this.entry, this.doc);
    this.#provider = provider;
    this.#leave = leave;
    this.#ahead = provider.ahead();
    this.#unwatch = provider.watch(() => (this.#ahead = provider.ahead()));
    try {
      await this.#syncing(provider);
    } catch (reason) {
      // Cleared so a later attempt is allowed to try again rather than
      // resolving instantly against the promise that failed.
      this.#attaching = undefined;
      throw reason;
    }
    this.attached = true;
  }

  #syncing(provider: Provider): Promise<void> {
    return new Promise<void>((synced, gaveUp) => {
      const timer = setTimeout(() => gaveUp(new Error("never synced")), 30_000);
      const ready = () => (clearTimeout(timer), synced());
      if (provider.synced) return ready();
      provider.once("synced", ready);
    });
  }

  /**
   * The network goes away, and the document does not.
   *
   * Only the provider is torn down. The `Y.Doc` is this client's own, so it
   * goes on taking edits, and when a provider is attached again every one of
   * them syncs -- which is exactly what an unnoticed lapse looks like.
   */
  detach() {
    this.#unwatch?.();
    this.#provider?.destroy();
    this.#leave?.();
    this.#unwatch = undefined;
    this.#ahead = false;
    this.#provider = undefined;
    this.#leave = undefined;
    this.#attaching = undefined;
    this.attached = false;
  }

  /**
   * The network comes back, and the room does not speak straight away.
   *
   * Waited on rather than timed. Asking the server to bring the room up to
   * date while this client is still holding text would have it carry in what
   * is already on its way, and the room would say it twice.
   */
  async reattach(): Promise<void> {
    await this.attach();
    await this.#provider?.handedOver();
    await this.#handedOn();
    await this.catchUp();
  }

  /**
   * Put the document down, having finished writing it.
   *
   * The flush is awaited before the document is destroyed, because the whole
   * point of the rung below the room is that a tab going away does not take
   * the work with it -- and an update still on its way to storage when the
   * document is torn down is exactly that loss.
   */
  /**
   * Whether this room is on its way out.
   *
   * Set before the flush rather than after it, because the flush is the slow
   * part and shutting a tab and opening the same file again is something a
   * person does inside it. Anybody who finds this room in the register during
   * that window is finding one that is going, and must build its own.
   */
  going = false;

  async dispose(): Promise<void> {
    this.going = true;
    this.detach();
    await this.#stopKeeping?.();
    this.#stopKeeping = undefined;
    this.doc.destroy();
  }
}

/**
 * Every room one workspace is holding, and the stream that feeds them.
 *
 * ONE subscription for all of them rather than one each: the stream is a fact
 * about the workspace, and a room that subscribed for itself would have to be
 * open before it could hear anything.
 */
export class Rooms {
  readonly held = new Map<string, Room>();

  /**
   * Whether this registry has been put away.
   *
   * Opening a room is several round trips, and a workspace can be torn down
   * in the middle of one -- a tab closing, a panel unmounting, a test ending.
   * The open then fails, correctly, and it is NOT a fault: there is nobody
   * left to show the document to. Anything reporting a failed open asks this
   * first, so a normal teardown stops looking like an error.
   */
  #gone = false;
  get gone(): boolean {
    return this.#gone;
  }

  /**
   * Whether a document here speaks for this entry -- what `connect` asks
   * before letting anything write the file's text around it.
   *
   * A room that is detached or replaced still counts. Its text is in a CRDT
   * either way, and that is the whole reason the second route is closed.
   */
  speaksFor = (entry: string): boolean => this.held.has(entry);

  #watching: () => void;

  constructor(
    readonly workspace: Workspace,
    readonly enter: Enter,
    readonly host: Host,
    readonly persist: Persist,
  ) {
    this.#watching = workspace.watch((changes) => {
      for (const change of changes) this.#tell(change);
    });
  }

  /**
   * What one change means to the room holding that entry, if one is.
   *
   * A create counts, and not only a write: a client shows a file the moment
   * it is asked for and opens its room straight away, so a room can exist
   * before the server has heard of its entry -- and the host cannot fill a
   * room from a file it does not have yet.
   */
  #tell(change: Change) {
    const room = this.held.get(change.entry);
    if (room === undefined) return;
    if (change.kind === "appeared") return void room.catchUp();
    if (change.kind === "removed") return void room.standDown(change.by, null);
    if (change.kind === "written") room.heard(change.by);
  }

  /** The version the workspace believes this entry's content is at. */
  token(entry: string): contract.Version | null {
    return this.workspace.entries().get(entry)?.content_version ?? null;
  }

  /** Where this entry lives, for the calls that name a file by its path. */
  path(entry: string): string | undefined {
    const index = this.workspace.index();
    return index.paths().find((path) => index.at(path)?.id === entry);
  }

  get(entry: string): Room | undefined {
    return this.held.get(entry);
  }

  /**
   * Open a file's room and make it trustworthy before anything is shown.
   *
   * RECALLED, THEN SETTLED, THEN ATTACHED, and each waits for the last. What
   * this machine was holding comes back first, so a document that was ahead
   * when the tab closed is ahead again rather than looking empty; then the
   * server fills a room nobody has filled yet; then the provider syncs.
   *
   * There are TWO loads to wait for now, not one, and "the document is empty"
   * is only a fact after both.
   *
   * SETTLED BEFORE ATTACHED, ALWAYS. The server fills a room nobody has filled yet, so
   * that by the time a provider syncs, an empty document means an empty file
   * rather than one that has not arrived. Clients used to decide this among
   * themselves, which they cannot: a document that has not synced looks
   * exactly like an empty one, so both of two arrivals believe the file is
   * theirs to write, and the file ends up saying everything twice.
   */
  async open(entry: string): Promise<Room> {
    const already = this.held.get(entry);
    /** Never one that is being put down -- see `Room.going`. */
    const room =
      already !== undefined && !already.going ? already : new Room(entry, this);
    this.held.set(entry, room);
    room.opening = "recalling";
    await room.recall();
    room.opening = "settling";
    room.base = await this.host.settle(entry);
    room.opening = "attaching";
    await room.attach();
    /**
     * Catching up on whatever arrived while it was opening.
     *
     * A room hears the workspace's stream from the moment it exists, and a
     * write that lands before it is attached is recorded as missed and acted
     * on later -- deliberately, because a room reaching nobody must not
     * repair itself. Opening is exactly that window, and nothing else closes
     * it: without this the room stays behind for ever, refuses to write the
     * file back, and every save quietly becomes a draft.
     */
    room.opening = "catching up";
    await room.catchUp();
    room.ready = true;
    room.opening = "storing what nobody stored";
    await room.storeWhatNobodyStored();
    room.opening = "open";
    return room;
  }

  /**
   * Put this file's room down.
   *
   * OUT OF THE REGISTER FIRST, then closed -- and that order is the whole
   * point. Closing a room flushes what it is holding, which takes as long as
   * a write to storage takes, and shutting a tab and opening the same file
   * again is something a person does inside that. Deleting afterwards deleted
   * whatever was registered by THEN, which was the room the reopen had just
   * made: the file ended up with a live room and an editor bound to it that
   * the register did not know about, so nothing told it when the file
   * changed, no write was allowed to go around it, and the next close found
   * nothing to close and never flushed it.
   *
   * Taking it out first also means a reopen during the flush builds a fresh
   * room rather than adopting one that is being put down.
   */
  async close(entry: string): Promise<void> {
    const room = this.held.get(entry);
    if (room === undefined) return;
    await room.dispose();
    /**
     * ONLY IF IT IS STILL THIS ROOM.
     *
     * Closing flushes what the room was holding, which takes as long as a
     * write to storage takes, and shutting a tab and opening the same file
     * again is something a person does inside that. Deleting whatever was
     * registered by THEN deleted the room the reopen had just made: the file
     * ended up with a live room and an editor bound to it that the register
     * did not know about, so nothing told it when the file changed, the next
     * close found nothing to close and never flushed it, and -- worst --
     * writing text around the document stopped being refused, which is the
     * one rule that keeps the editor's buffer from being saved over the file.
     *
     * Removed after the flush rather than before it for that last reason: for
     * as long as anything here is holding this file, text must not go round
     * it.
     */
    if (this.held.get(entry) === room) this.held.delete(entry);
  }

  async dispose(): Promise<void> {
    this.#gone = true;
    this.#watching();
    /**
     * ALL of them, whatever any one of them does.
     *
     * Each room's last act is to flush what it is holding, and `Promise.all`
     * would abandon every flush after the first rejection -- so one room with
     * a store that had already gone would take the others' unsaved work with
     * it. Settled rather than all: put every one down, then carry on.
     */
    await Promise.allSettled(
      [...this.held.values()].map((room) => room.dispose()),
    );
    this.held.clear();
  }
}
