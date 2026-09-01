/**
 * One workspace, open.
 *
 * Everything a consumer touches hangs off this: the tree renders the effective
 * view, the editor and the kernel read content through the same chain, and all
 * three therefore cannot disagree about what a file contains.
 */
import { digestOf, inMemory, type Store } from "./bytes";
import * as changes from "./changes";
import * as confirmed from "./confirmed";
import { cache, type Content, type Payload } from "./content";
import {
  settledHere,
  UNSOUND,
  type Answering,
  type Asked,
  type Asking,
  type Body,
  type Judged,
  type Judging,
  type Id,
  type Metadata,
  type Response,
  type Submitted,
  type Transaction,
  type Transcript,
  type Version,
  type Write,
  type Accepted,
  type Detected,
  type Recorded,
} from "./contract";
import * as effective from "./effective";
import { merged, type Told } from "./history";
import { nothing, nowhere, type Kept, type Restored } from "./kept";
import { mint } from "./identity";
import { offset } from "./minted";
import * as loop from "./loop";
import * as outbox from "./outbox";
import { forget, stash, stashed, STALE_MS } from "./stash";
import * as paths from "./paths";
import * as writes from "./writes";
import { heldAs } from "./writes";
import type { Transport } from "./transport";

export type Options = {
  workspace: Id;
  transport: Transport;
  bytes?: Store;
  timing?: loop.Timing;
  /**
   * Whether a shared document here speaks for this entry.
   *
   * Answering yes closes `write` for it. Content that came out of an editor
   * moves as a CRDT update and reaches the file through the document that
   * holds it, because typing text in creates NEW characters and the same work
   * arriving twice survives twice. That is rule one, and until now it was a
   * convention -- nothing stopped a second route being added years later by
   * somebody who had not read this.
   *
   * No CRDT is named here. A consumer holding documents is the only party
   * that knows which entries have one.
   */
  shared?: (entry: Id) => boolean;
  /**
   * Where the queue is written down, and what it held when this client last
   * ran. Say nothing and the outbox lives and dies with the page, which loses
   * work and is the default only because a consumer must choose its storage.
   */
  kept?: Kept;
  restored?: Restored;
  /**
   * Queued work that can never be sent, because the bytes it named are gone.
   *
   * Reported rather than swallowed: it is the one loss this client cannot
   * undo, and a user who is told can retype a paragraph. One that is not told
   * finds out much later, from a file that is missing something.
   */
  lost?: (entries: outbox.Unreadable[]) => void;
};

/**
 * A listener is handed what changed. Consumers that only need to know THAT
 * something did can keep ignoring the argument.
 */
export type Changed = changes.Watching;

/**
 * A submitted transaction: its id, available before anything is announced,
 * and the server's answer, available much later.
 *
 * The id has to come back synchronously. Queueing the request recomputes the
 * view and announces the change it makes, and that happens before the request
 * is even sent -- so a caller that only learned its transaction id when the
 * promise resolved would learn it after being told about its own work.
 *
 * `settled` does not reject on a refusal: a refused transaction is taken back
 * by the same recomputation that showed it, and the reason is in the response
 * for a caller that wants to say something about it.
 */
export type Submitting = {
  transaction: Transaction;
  settled: Promise<Response>;
};

/** A create also names the entry it is bringing into existence. */
export type Creating = Submitting & { entry: Id };

export type Workspace = {
  /**
   * Which workspace this is.
   *
   * Every scoped endpoint needs it, and a consumer holding only this object
   * would otherwise have to be handed the id separately and keep the two in
   * step -- which is exactly how a client goes on calling routes for the
   * wrong workspace, or for none.
   */
  id: Id;
  entries: () => effective.View;
  index: () => paths.Index;
  watch: (changed: Changed) => () => void;

  read: (path: paths.Path) => Promise<Payload | undefined>;
  holding: (path: paths.Path) => Payload | undefined;
  /**
   * What one file held at one version.
   *
   * `read` answers for a file as it stands, which is what almost everything
   * wants. This answers for a version by name, which is what a consumer
   * RECONCILING needs -- and it needs two of them at once, both older than
   * anything it is showing. A shared document catching up with a write that
   * did not go through it applies the difference between two SERVER versions,
   * because diffing from the document instead would describe the user's own
   * unsent work as text to delete. See `rooms.ts`.
   *
   * By entry rather than by path: the caller is holding a room open on an id,
   * and the file may have been renamed since the version it is asking about.
   */
  at: (entry: Id, version: Version) => Promise<Payload>;
  /**
   * What this file has said, newest first: queued work, then what the server
   * holds -- everything it accepted, and this user's own drafts and refusals.
   *
   * The queued half is the reason this is not just a call: a client with no
   * network still has a history, and it is the half nobody else can rebuild.
   */
  history: (
    entry: Id,
    asking?: { before?: string; limit?: number },
  ) => Promise<{ versions: Told[]; more: boolean; told: boolean }>;
  /**
   * Put back what this file said at that version.
   *
   * A NEW WRITE, not a rewind. It presents the token that is current now, so
   * it is refused if somebody moved the file on -- which is right, because
   * restoring over work you have not seen is how a restore loses more than it
   * recovers. The version restored from is still in the history afterwards.
   */
  restore: (entry: Id, version: Version) => Promise<Submitting>;
  /**
   * This file's collaboration room, as this host serves it.
   *
   * Here rather than reached for directly, because these calls are scoped by
   * workspace and authorised like every other -- and a caller holding this
   * object already has both.
   */
  room: {
    settle: (entry: Id) => Promise<Version | null>;
    warm: (entry: Id) => Promise<void>;
    stored: (entry: Id, version: Version) => Promise<void>;
    handOver: (entry: Id, update: Uint8Array) => Promise<void>;
  };
  /**
   * The tutor: ask it something, hear the answer, read back what was said.
   *
   * Grouped like `room` and for the same reason -- these are scoped by
   * workspace and authorised like everything else, and a caller holding this
   * object already has both.
   */
  tutor: {
    /**
     * `system`, if sent, is standing instructions for this question -- said
     * after the tutor's own system prompt and before any of the conversation.
     * Per-question and never written down, so a caller that wants it on the
     * next question sends it again. See `Asking.system` on the server.
     */
    ask: (asking: Omit<Asking, "message"> & { message?: Id }) => Promise<Asked>;
    hear: (token: string) => AsyncIterable<Answering>;
    said: (asking: { before?: string; limit?: number }) => Promise<Transcript>;
    /**
     * Whether a program has moved toward its goal.
     *
     * Here with the tutor because it is the same model answering, and NOT a
     * conversation: no transcript goes in and none comes out. See the route.
     */
    progressing: (asking: Judging) => Promise<Judged>;
  };
  /**
   * The nudge study's records: episodes, accepted offers, and what a student
   * did inside a post-episode window.
   *
   * POSTED AND FORGOTTEN, unlike everything else on this object. There is no
   * outbox behind these and there is not meant to be: losing a write loses a
   * student's program, and losing one of these loses one observation of one
   * term. Paying for the second with the machinery that guarantees the first
   * would be paying with the editor's responsiveness. See `study.py`.
   *
   * The clock is filled in here when a caller does not, like everywhere else.
   */
  study: {
    detected: (told: Detected) => Promise<void>;
    accepted: (told: Accepted) => Promise<void>;
    activity: (
      told: Recorded,
      options?: { keepalive?: boolean },
    ) => Promise<void>;
  };
  /**
   * Record that the workspace looked like this.
   *
   * A transaction, so it goes through the outbox and survives being offline
   * -- which is the whole reason it is one. It changes nothing, presents no
   * token and cannot conflict; what it can be refused for is naming a version
   * that was never issued.
   */
  snapshot: (entries: Id[]) => Submitting;
  /**
   * Record what running a file produced, against a snapshot.
   *
   * Output is only evidence if you can say what it was evidence ABOUT, which
   * is what the snapshot is for.
   */
  executed: (
    entry: Id,
    snapshot: Transaction,
    outputs: unknown[],
    ok: boolean,
  ) => Submitting;
  write: (
    path: paths.Path,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * Record this without making it the file's content.
   *
   * For a client whose text has reached nobody else. The token it presents is
   * not consumed and nothing rebases under it, so the write that eventually
   * shares the work presents the same one.
   *
   * BY ENTRY, NOT BY PATH, and that is the case it exists for: a file being
   * deleted underneath somebody is exactly when their unstored work needs
   * keeping, and by then it has no path to name.
   */
  keep: (
    entry: Id,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * The write a shared document makes for the file it speaks for.
   *
   * The same write `write` makes, minus the refusal -- this is the route rule
   * one leaves open, and it takes an ENTRY because the document holds an id
   * and the file may have been renamed under it since.
   */
  shares: (
    entry: Id,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * These drafts' work has since reached everybody else.
   *
   * Told to the server rather than remembered here: the case worth reporting
   * is a machine that never came back, and a note kept only on that machine
   * goes with it.
   */
  /**
   * THE LAST ATTEMPT, made as the page goes away.
   *
   * Every other write here is careful: it hashes the payload, puts the bytes
   * in the durable outbox, records the transaction, and only then goes to the
   * server -- so that a request lost to a flat battery or a closed lid is
   * still on the machine when the person comes back. Each of those steps is
   * an `await`, and that is exactly what makes them useless in the one moment
   * this is for. A document being torn down does not run the continuation
   * after an IndexedDB round trip, and the fetch at the end of it is
   * cancelled with the document even if it does.
   *
   * So this skips all of it. No hashing, no outbox, no bookkeeping: one
   * `keepalive` POST, made before anything can yield, which is the only kind
   * of request the browser promises to finish after the page is gone.
   *
   * WHAT IT GIVES UP. It is unacknowledged -- nothing here will ever learn
   * whether it landed -- and it is not retried, because there is no longer
   * anywhere to retry from. It can also lose to the 64KB the browser allows
   * all keepalive bodies together. It is a strictly better last resort than
   * an ordinary write, not a replacement for one: `store` remains what a
   * panel closing and an idle keyboard both use, and this runs after it.
   *
   * A duplicate is harmless. The transaction is minted fresh and the server
   * adjudicates writes against the version they claim to follow, so the worst
   * case is a second version holding the text the first one already had.
   */
  rescue: (entry: Id, text: string) => void;

  /**
   * Act on the notes the last session left behind. See `stash.ts`.
   *
   * Called once the first snapshot is in, because every question it asks is
   * about what the server currently holds. Answers what it did, so a caller
   * can say so.
   */
  recovered: () => Promise<Recovery>;

  cleared: (transactions: Transaction[]) => Promise<void>;
  create: (
    path: paths.Path,
    content: string | Uint8Array,
    mime?: string,
  ) => Creating;
  folder: (path: paths.Path) => Creating;
  move: (from: paths.Path, to: paths.Path) => Submitting;
  remove: (path: paths.Path) => Submitting;

  /**
   * Which of these transactions this client has not yet heard the server
   * confirm -- queued, in flight, or answered but not yet carried by the
   * stream.
   *
   * A snapshot names transactions, and a client shows its own work the
   * instant it makes it, so a snapshot can name work that has never left this
   * machine. Nothing anywhere else can rebuild that: the bytes are here and
   * nowhere. A consumer handing a snapshot to something that will read it
   * elsewhere asks this first, and an empty answer is what makes the snapshot
   * portable.
   */
  unsettled: (transactions: Iterable<Transaction>) => Transaction[];

  stop: () => void;
  nudge: () => void;
};

const TEXT = "text/plain";

const isText = (content: string | Uint8Array): content is string =>
  typeof content === "string";

/**
 * What a kernel produced, reduced to what can actually be stored.
 *
 * A queued transaction is WRITTEN DOWN, and IndexedDB stores it by structured
 * clone -- which refuses a class instance, a proxy, a function. Kernel output
 * is full of those, and the failure is not local: the clone throws, the whole
 * durable write fails, and the client reports that the outbox has stopped
 * reaching disk. One unstorable output turns into "your work is not being
 * saved".
 *
 * JSON is the right filter rather than a lucky one: the server stores these
 * as JSONB, so anything that does not survive the round trip was never going
 * to be kept anyway. Doing it HERE means the queue only ever holds what the
 * wire and the disk can both take.
 */
const plainly = (outputs: unknown[]): unknown[] => {
  try {
    return JSON.parse(JSON.stringify(outputs)) as unknown[];
  } catch {
    /** Circular, or holding a BigInt. Better to keep the run than the shape. */
    return outputs.map((one) => ({
      unstorable: Object.prototype.toString.call(one),
    }));
  }
};

/**
 * What became of the notes a previous session left. See `Workspace.recovered`.
 *
 * `replayed` is text that has been put back into the outbox and will arrive;
 * `landed` was already on the server, so the note was only ever a spare copy;
 * `contested` is the one worth telling somebody about -- the entry moved on
 * without this text, so putting it back would take somebody else's work away,
 * and it has been left where it is instead.
 */
export type Recovery = {
  replayed: Id[];
  landed: Id[];
  contested: { entry: Id; text: string }[];
};

export const connect = (options: Options): Workspace => {
  const { workspace, transport } = options;
  const bytes = options.bytes ?? inMemory();
  const kept = options.kept ?? nowhere;
  const restored = options.restored ?? nothing;
  const queue = outbox.queue(restored.entries, kept);
  const listeners = new Set<Changed>();

  let map = confirmed.empty();
  let shown = effective.of(map, []);
  let index = paths.index(shown.view);

  /**
   * Every transaction this client sent that the server answered.
   *
   * The confirmed map says what each entry is at NOW, which is a different
   * question from what the server can rebuild, and three things fall through
   * the gap: a draft, a refusal, and an applied write that a later write has
   * since superseded. None of them is any entry's current version; all three
   * are on the server and rebuildable from it.
   *
   * An answer is the proof. Whatever the server decided, it wrote the
   * transaction down before saying so.
   *
   * Written down with the queue, and NEVER PRUNED.
   *
   * It used to drop whatever the confirmed map covered, on the reasoning that
   * a current version is already answered for. That is true exactly until the
   * next write to that file: the map only ever holds what an entry is at NOW,
   * so a transaction pruned while it was current became, the moment something
   * superseded it, a transaction neither the map nor this set could speak for
   * -- and `unsettled` called work that was safely on the server unsettled,
   * for ever.
   *
   * Which is the opposite of this set's whole purpose. It is three ids per
   * answer; being complete is worth more than being small.
   */
  const recorded = new Set<Transaction>(restored.recorded);

  const answered = (transaction: Transaction) => {
    recorded.add(transaction);
    kept.answered([transaction]);
  };

  const content: Content = cache((entry, version) =>
    transport.content(workspace, entry, version),
  );

  /**
   * The one door state leaves by. What is announced is the difference between
   * the view that was showing and the one now showing -- so a recomputation
   * that changes nothing a consumer can see announces nothing, whatever
   * prompted it.
   */
  const recomputed = () => {
    const before = shown;
    shown = effective.of(map, queue.entries());
    index = paths.index(shown.view);
    const what = changes.between(before, shown);
    if (what.length === 0) return;
    listeners.forEach((changed) => changed(what));
  };

  /**
   * Content arrives before it is asked for, so the kernel's filesystem calls
   * are answered out of state rather than out of a request it must wait on.
   */
  const readied = (entry: Metadata | undefined) => {
    if (entry && entry.type === "file") void content.prefetch(entry);
  };

  const applied = (event: import("./contract").StreamEvent) => {
    map = confirmed.applied(map, event);
    if (event.type === "write") content.forget(event.id);
    bytes.forget(queue.evict([event.transaction]));
    recomputed();
    readied(map.get(event.id));
  };

  const entryAt = (path: paths.Path) => {
    const entry = index.at(path);
    if (entry === undefined) throw new Error(`No such entry: ${path}`);
    return entry;
  };

  /**
   * The offset is stamped HERE rather than at each mint, so that every
   * transaction this client sends carries one and none can be forgotten. It is
   * per-transaction and not per-connection because an outbox filled offline in
   * one zone may only be replayed after landing in another -- see
   * `Transacted.offset` on the wire.
   *
   * Queued work leaves the outbox when the STREAM carries it, not when the
   * response acknowledges it -- those are different moments, and dropping it
   * at the first one opens a window where the entry is in neither the outbox
   * nor the confirmed map, so a file blinks out of the tree just after it is
   * created. A rejection is the one answer no event will ever follow, so that
   * is one of the two this evicts itself; a draft, which was never going to
   * become content, is the other.
   */
  const submit = async (
    submitted: Submitted,
    payload?: string | Uint8Array,
    mime = TEXT,
  ): Promise<Response> => {
    const request = { ...submitted, offset: offset() };
    /**
     * Hashed, queued, and only then stored. The row that NAMES the payload
     * goes down first, because the two orders fail differently: bytes with no
     * row are work that is gone and cannot be noticed, a row with no bytes is
     * work that is gone and says so. Only one of those can be told to a user.
     */
    const digest = payload === undefined ? undefined : await digestOf(payload);
    queue.capture(request, digest);
    if (payload !== undefined) await bytes.put(payload, digest);
    if (payload !== undefined)
      content.remember(request.transaction, heldAs(payload, mime));
    recomputed();
    const response = await transport.submit(workspace, request);
    answered(request.transaction);
    if (settledHere(response)) {
      if (response.rejected && response.reason === UNSOUND) sync.nudge();
      bytes.forget(queue.evict([request.transaction]));
      recomputed();
    }
    return response;
  };

  /**
   * A write names bytes by hash, so the bytes have to be stored before the
   * write that names them -- and storing is idempotent, so a retry is free.
   */
  const staged = async (
    payload: string | Uint8Array,
    mime: string,
  ): Promise<Body> => {
    if (isText(payload)) return { type: "text", content: payload };
    const hash = await digestOf(payload);
    await transport.store(workspace, hash, payload, mime);
    return { type: "binary", hash, size: payload.byteLength, mime };
  };

  /**
   * Every mutation is minted, then sent. The two halves are separate because
   * the caller needs the first before the second has happened: `submit`
   * announces the change it makes before the request leaves.
   */
  /**
   * Content writes go through here rather than straight to `submit`, because
   * they are the one op whose token can be invalidated by this client's OWN
   * work in flight. See `writes.ts`.
   */
  const flight = writes.pump({
    queue,
    bytes,
    send: (request) => transport.submit(workspace, request),
    announced: recomputed,
    remembered: content.remember,
    token: (entry) => map.get(entry)?.content_version ?? null,
    unsound: () => sync.nudge(),
    /**
     * The same door Initialize reports through. Which path FINDS the loss is
     * an accident of whether the stream happened to drop, so a consumer that
     * implements one has implemented both.
     */
    lost: options.lost,
  });

  const written = (
    entry: Metadata,
    payload: string | Uint8Array,
    mime: string,
    draft = false,
  ): Submitting => {
    const seen = entry.content_version;
    if (seen == null) throw new Error(`Not a file: ${entry.name}`);
    const transaction = mint();
    /**
     * The token here is the one the CACHE knows, and it is only a starting
     * point: `flight` chooses what actually goes on the wire, because by the
     * time this leaves there may be a write of this client's own in front of
     * it that the confirmed view has not heard about yet.
     */
    const settled = (async () => {
      const answer = await flight.write(
        entry.id,
        {
          op: "write",
          transaction,
          id: entry.id,
          content_version: seen,
          content: await staged(payload, mime),
          draft,
        } as Write,
        payload,
        mime,
      );
      answered(transaction);
      return answer;
    })();
    return { transaction, settled };
  };

  const sync = loop.run(
    {
      reconcile: async () => {
        /**
         * What cannot be read is dropped BEFORE the batch goes, not after.
         * Its bytes are gone, so it can never be sent however many times this
         * comes round -- and leaving it in place used to stop everything
         * behind it from being sent either.
         */
        const { presented, unreadable } = await outbox.presenting(
          queue.entries(),
          queue,
          bytes,
        );
        if (unreadable.length > 0) {
          bytes.forget(
            queue.evict(unreadable.map(({ transaction }) => transaction)),
          );
          options.lost?.(unreadable);
        }
        const snapshot = await transport.initialize(workspace, presented);
        /**
         * Replay is an answer like any other, and it used to be the one that
         * was not written down. A draft sent during Initialize left the queue
         * and was recorded nowhere, so a client that had reloaded called its
         * own landed work unsettled for ever -- which is exactly the question
         * a consumer asks before handing a snapshot to anybody else.
         */
        const answers = [
          ...snapshot.applied,
          ...snapshot.rejected.map(({ transaction }) => transaction),
        ];
        answers.forEach(answered);
        bytes.forget(queue.evict(answers));
        map = confirmed.snapshot(snapshot.entries);
        recomputed();
        snapshot.entries.forEach(readied);
        flight.resume();
        return snapshot.token;
      },
      follow: (token, alive, until) =>
        new Promise<void>((ended) => {
          const done = () => (subscription.close(), ended());
          const subscription = transport.follow(workspace, token, {
            alive,
            event: applied,
            failed: done,
          });
          until.addEventListener("abort", done, { once: true });
        }),
    },
    options.timing,
  );

  return {
    id: workspace,
    entries: () => shown.view,
    index: () => index,
    watch: (changed) => (
      listeners.add(changed),
      () => listeners.delete(changed)
    ),

    read: (path) => content.read(entryAt(path)),
    holding: (path) => content.holding(entryAt(path)),
    /**
     * Straight to the transport, past the cache. The cache is keyed by the
     * token an entry is CURRENTLY at, which is exactly the version this is
     * never asked about -- and reconciling is rare enough that a read costs
     * less than a second cache keyed a second way.
     */
    at: async (entry, version) => {
      /**
       * The outbox first, because it holds versions the server has never
       * heard of. Asking the wire for one of those gets a 404, which is the
       * right answer to the wrong question: this client is the only place
       * that write exists, and it is right here.
       *
       * Safe for every other caller. A room reconciling asks about versions
       * it read off the STREAM, and those are applied by definition -- they
       * cannot be sitting in this queue.
       */
      const queued = queue.find(version);
      if (queued !== undefined) {
        const text = await outbox.textOf(queued, queue, bytes);
        return { kind: "text", text };
      }
      return transport.content(workspace, entry, version);
    },

    history: async (entry, asking = {}) => {
      /**
       * Queued work is only in front of the FIRST page. Later pages reach
       * further back than anything this client is still holding, so putting
       * the outbox in front of each would repeat it down the list.
       */
      const first = asking.before === undefined;
      try {
        const said = await transport.history(workspace, entry, asking);
        return {
          versions: first
            ? merged(queue.entries(), entry, said.versions)
            : said.versions.map((one) => one as Told),
          more: said.more,
          told: true,
        };
      } catch {
        /**
         * THE CASE THIS FEATURE IS MOST FOR. Somebody who cannot reach the
         * server is exactly the person asking where their work went, and the
         * answer is in the outbox -- which is here. Refusing to show it
         * because the other half is unreachable would withhold the only half
         * that was ever at risk.
         *
         * `told` is false so a reader can say the list is partial rather than
         * letting it look like the whole history.
         */
        return {
          versions: first ? merged(queue.entries(), entry, []) : [],
          more: false,
          told: false,
        };
      }
    },

    tutor: {
      ask: (asking) =>
        transport.ask(workspace, {
          ...asking,
          text: asking.text,
          /** Minted here when a caller does not, so a retry is free. */
          message: asking.message ?? mint(),
          offset: asking.offset ?? offset(),
        }),
      hear: (token) => transport.hear(workspace, token),
      said: (asking) => transport.conversation(workspace, asking),
      progressing: (asking) => transport.progress(workspace, asking),
    },

    study: {
      detected: (told) =>
        transport.detected(workspace, { ...told, offset: told.offset ?? offset() }),
      accepted: (told) =>
        transport.accepted(workspace, { ...told, offset: told.offset ?? offset() }),
      activity: (told, options) => transport.activity(workspace, told, options),
    },

    room: {
      settle: (entry) => transport.settleRoom(workspace, entry),
      warm: (entry) => transport.warmRoom(workspace, entry),
      stored: (entry, version) => transport.roomStored(workspace, entry, version),
      handOver: (entry, update) => transport.handOver(workspace, entry, update),
    },

    snapshot: (entries) => {
      const transaction = mint();
      const seen = entries
        .map((id) => map.get(id) ?? shown.view.get(id))
        .filter((held): held is Metadata => held !== undefined)
        .map((held) => ({
          id: held.id,
          name_version: held.name_version,
          parent_version: held.parent_version,
          deleted_version: held.deleted_version,
          content_version: held.content_version ?? null,
        }));
      const settled = submit({
        op: "snapshot",
        transaction,
        /**
         * The transaction names an entry because every transaction does. A
         * snapshot is about the workspace rather than about one of them, so
         * this is the first it holds -- enough for the server to scope it,
         * and never read as the subject.
         */
        id: seen[0]?.id ?? transaction,
        entries: seen,
      } as Submitted);
      return { transaction, settled };
    },

    executed: (entry, snapshot, outputs, ok) => {
      const transaction = mint();
      const settled = submit({
        op: "execute",
        transaction,
        id: entry,
        snapshot,
        outputs: plainly(outputs),
        ok,
      } as Submitted);
      return { transaction, settled };
    },

    restore: async (entry, version) => {
      const held = await transport.content(workspace, entry, version);
      if (held.kind !== "text")
        throw new Error(
          `Version ${version} of this file is ${held.mime}, and putting bytes ` +
            "back is a copy rather than a write. Not yet supported.",
        );
      /**
       * An ordinary write even when a document speaks for this entry, and
       * rule one is why that is allowed rather than in spite of it: the rule
       * closes the door on text that CAME OUT OF AN EDITOR, because typing it
       * back in creates new characters and the same work survives twice.
       * This text came out of the server's own history. Nobody's document
       * holds a second copy of it, so it is diffed in exactly as a script's
       * write is -- and the room hears about it the same way, by the server
       * carrying it in.
       */
      return written(heldEntry(entry), held.text, TEXT);
    },

    write: (path, payload, mime = TEXT) => {
      const entry = index.at(path);
      if (entry === undefined) return created(path, payload, mime);
      refuseIfShared(entry.id, path);
      return written(entry, payload, mime);
    },

    rescue: (entry, text) => {
      const held = shown.view.get(entry);
      const seen = held?.content_version;
      // Nothing to follow means nothing the server would accept, and there is
      // no time here to go and find out what it should have been.
      if (held === undefined || seen == null) return;
      /**
       * THE NOTE FIRST, THE REQUEST SECOND, and the order is the point.
       *
       * `stash` is synchronous, so it has finished by the time the next line
       * runs; the request may never be made at all -- no network, a server
       * that is down, a browser that decided this page had had enough. Doing
       * the certain thing before the uncertain one is what makes the text
       * survive the cases `keepalive` cannot reach.
       */
      stash(workspace, { entry, basis: seen, text, at: Date.now() });
      void transport
        .submit(
          workspace,
          {
            op: "write",
            transaction: mint(),
            id: entry,
            content_version: seen,
            content: { type: "text", content: text },
            draft: false,
            offset: offset(),
          } as Submitted,
          { keepalive: true },
        )
        .catch(() => undefined);
    },

    recovered: async () => {
      const answer: Recovery = { replayed: [], landed: [], contested: [] };
      for (const note of stashed(workspace)) {
        const held = shown.view.get(note.entry);

        /**
         * Gone, or too old to act on without being asked.
         *
         * A fortnight is not a judgement about how long work matters; it is
         * how long a note that nobody ever came back for should be allowed to
         * sit in a store this small before it is somebody else's problem.
         */
        if (held === undefined || Date.now() - (note.at ?? 0) > STALE_MS) {
          forget(workspace, note.entry);
          continue;
        }

        /**
         * NOBODY HAS WRITTEN SINCE. Then the difference between the note and
         * the file is this person's own last few seconds of typing, and
         * nothing else -- which is exactly what makes replaying it safe.
         */
        if (held.content_version === note.basis) {
          void written(held, note.text, TEXT).settled.catch(() => undefined);
          forget(workspace, note.entry);
          answer.replayed.push(note.entry);
          continue;
        }

        /**
         * Somebody has. Usually that somebody is the rescue write this note
         * was taken beside, which landed after all -- so the file already
         * says what the note says, and the note has done its job by being
         * unnecessary. Asked of the CONTENT rather than the version, because
         * the version moving is what both cases look like.
         */
        try {
          const now = await content.read(held);
          if (now?.kind === "text" && now.text === note.text) {
            forget(workspace, note.entry);
            answer.landed.push(note.entry);
            continue;
          }
        } catch {
          /* Cannot say. Then it is contested, which is the careful answer. */
        }

        /**
         * KEPT, NOT APPLIED. Something else is on top of this file, and
         * writing the note over it would be this session taking away work it
         * never saw. The note stays where it is so it can be offered.
         */
        answer.contested.push({ entry: note.entry, text: note.text });
      }
      return answer;
    },

    cleared: (transactions) => transport.cleared(workspace, transactions),

    keep: (entry, payload, mime = TEXT) => written(heldEntry(entry), payload, mime, true),

    shares: (entry, payload, mime = TEXT) =>
      written(heldEntry(entry), payload, mime),

    create: (path, payload, mime = TEXT) => created(path, payload, mime),

    folder: (path) => {
      const entry = mint();
      const transaction = mint();
      const settled = submit({
        op: "create",
        transaction,
        id: entry,
        type: "folder",
        name: paths.base(path),
        parent: parentOf(path),
        content: null,
      });
      return { entry, transaction, settled };
    },

    move: (from, to) => {
      const entry = entryAt(from);
      const transaction = mint();
      const settled = submit({
        op: "move",
        transaction,
        id: entry.id,
        name: paths.base(to),
        name_version: entry.name_version,
        parent: parentOf(to),
        parent_version: entry.parent_version,
      });
      return { transaction, settled };
    },

    remove: (path) => {
      const entry = entryAt(path);
      const transaction = mint();
      const settled = submit({
        op: "delete",
        transaction,
        id: entry.id,
        seen: {
          name_version: entry.name_version,
          parent_version: entry.parent_version,
          deleted_version: entry.deleted_version,
          content_version: entry.content_version ?? null,
        },
      });
      return { transaction, settled };
    },

    /**
     * Read off the CONFIRMED map rather than off the outbox, and the
     * difference matters. A transaction the outbox has never heard of is not
     * settled -- it is one this client has not got round to queueing, or one
     * whose bytes died with a tab, and answering "portable" for either would
     * be answering for something that does not exist anywhere.
     *
     * Every transaction a snapshot names is a property token of something it
     * was showing, so a token standing in the confirmed map is exactly the
     * question "has the server told me about this", asked completely.
     *
     * Plus everything the server has answered for, which the confirmed map
     * cannot speak to: drafts, refusals, and writes a later write has moved
     * past.
     */
    unsettled: (transactions) => {
      const settled = currentVersions();
      for (const transaction of recorded) settled.add(transaction);
      return [...transactions].filter(
        (transaction) => !settled.has(transaction),
      );
    },

    stop: sync.stop,
    nudge: sync.nudge,
  };

  function currentVersions(): Set<Transaction> {
    const held = new Set<Transaction>();
    for (const entry of map.values()) {
      held.add(entry.name_version);
      held.add(entry.parent_version);
      held.add(entry.deleted_version);
      if (entry.content_version != null) held.add(entry.content_version);
    }
    return held;
  }

  function heldEntry(entry: Id): Metadata {
    const held = shown.view.get(entry);
    if (held === undefined) throw new Error(`No such entry: ${entry}`);
    return held;
  }

  /**
   * Named rather than boolean, because the mistake this catches is somebody
   * reaching for the obvious method, and the error has to say which one is
   * not obvious.
   */
  function refuseIfShared(entry: Id, path: paths.Path): void {
    if (options.shared?.(entry) !== true) return;
    throw new Error(
      `${path} has a shared document open, so its text reaches the file ` +
        "through that document. Type into it, or call `shares` if you ARE " +
        "it. Writing text around it would say the same work twice.",
    );
  }

  function parentOf(path: paths.Path): Id | null {
    const holder = paths.parent(path);
    return holder === "" ? null : entryAt(holder).id;
  }

  function created(
    path: paths.Path,
    payload: string | Uint8Array,
    mime: string,
  ): Creating {
    const entry = mint();
    const transaction = mint();
    const parent = parentOf(path);
    const settled = (async () =>
      submit(
        {
          op: "create",
          transaction,
          id: entry,
          type: "file",
          name: paths.base(path),
          parent,
          content: await staged(payload, mime),
        },
        payload,
        mime,
      ))();
    return { entry, transaction, settled };
  }
};
