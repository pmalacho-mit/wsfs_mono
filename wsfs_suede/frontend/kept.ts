/**
 * The outbox, across page loads.
 *
 * WHY THIS IS NOT OPTIONAL. Everything else in this client exists so that work
 * reaches the server: the queue holds what has not been answered, chained
 * writes keep every snapshot rather than only the last, drafts keep text that
 * has reached nobody. All of it lived in one closure, and a reload emptied it.
 * A design whose whole claim is "a user never loses work" cannot keep the only
 * copy of that work in memory.
 *
 * BY WORKSPACE, and that is not tidiness. Queued work leaves the outbox when
 * the STREAM carries it, and a client only follows the stream of the workspace
 * it is looking at. Navigate to another one and the first one's queue has no
 * route to be drained -- so it must survive being unattended, and drain when
 * the user comes back. Every record here is scoped to a workspace for exactly
 * that reason.
 *
 * ROWS, NOT A DOCUMENT. Each queued item is its own record under its own
 * transaction. Two tabs on one workspace share this storage, and appending and
 * removing single rows is something they can both do without either of them
 * reading a whole outbox and writing back a version that forgot the other's
 * work.
 */
import type { Digest } from "./bytes";
import type { Transaction } from "./contract";
import type { Entry } from "./outbox";

/**
 * The queue is not being written down.
 *
 * The one failure that must never be quiet. Everything else here degrades
 * into "sent later"; this degrades into "kept nowhere", and a client that
 * swallowed it would go on looking exactly like one that was safe. Quota is
 * called out by name because it is both the likeliest cause and the only one
 * a person can do something about.
 */
export type Faltering = {
  says: string;
  /** Whether the store is simply full, which a person can act on. */
  full: boolean;
};

/** What a client starts with, having been here before. */
export type Restored = {
  entries: Entry[];
  /**
   * Answers the confirmed map cannot speak to: drafts, refusals, and writes a
   * later write has moved past -- and every answer besides, because which of
   * those a transaction IS changes as the workspace moves on. Kept whole for
   * that reason: see the note on `recorded` in `workspace.ts`.
   */
  recorded: Transaction[];
};

export const nothing: Restored = { entries: [], recorded: [] };

/**
 * One change to the queue, whole.
 *
 * `written` and `gone` travel TOGETHER, and that is the entire reason this is
 * a record rather than two methods. Evicting a queued write hands the digest
 * it was holding to the chained write behind it -- so an eviction is a removal
 * and an amendment at once, and a store that applied them separately could be
 * killed between the two. What comes back then is a delta against a
 * predecessor that is gone and bytes it can no longer name: work that was on
 * disk, and is now unreadable. It happened, in both browsers.
 */
export type Change = { written?: Entry[]; gone?: Transaction[] };

/**
 * Where the queue is written down.
 *
 * Every method is fire-and-forget. A caller that awaited each one would make
 * the outbox's own bookkeeping wait on a disk, and the queue in memory is
 * already correct -- what this buys is the NEXT page load, not this one.
 */
export type Kept = {
  /** The queue moved. Applied as one indivisible change. */
  moved: (change: Change) => void;
  /** The server answered these, and no stream event may ever mention them. */
  answered: (transactions: Transaction[]) => void;
};

/** Kept nowhere. What a consumer gets by saying nothing, and what tests use. */
export const nowhere: Kept = {
  moved: () => {},
  answered: () => {},
};

/**
 * A `Kept` and a `Restored` over ordinary maps.
 *
 * For tests, and for the shape of the thing: the durable implementation does
 * this against IndexedDB and differs in nothing else.
 */
export const remembering = (restored: Restored = nothing) => {
  const entries = new Map<Transaction, Entry>(
    restored.entries.map((entry) => [entry.request.transaction, entry]),
  );
  const recorded = new Set<Transaction>(restored.recorded);

  const kept: Kept = {
    moved: ({ written = [], gone = [] }) => {
      for (const entry of written)
        entries.set(entry.request.transaction, entry);
      for (const transaction of gone) entries.delete(transaction);
    },
    answered: (transactions) => {
      for (const transaction of transactions) recorded.add(transaction);
    },
  };

  return {
    kept,
    /** What a fresh client would be handed, were it to start now. */
    restored: (): Restored => ({
      entries: [...entries.values()],
      recorded: [...recorded],
    }),
  };
};

/**
 * The digests a set of queued items still needs.
 *
 * Read off what is WRITTEN DOWN rather than off one queue in memory, because
 * a second tab on this workspace has its own queue and its chained writes are
 * deltas against bytes this one is about to call unreferenced.
 */
export const referenced = (entries: Iterable<Entry>): Set<Digest> => {
  const held = new Set<Digest>();
  for (const entry of entries) {
    if (entry.content !== undefined) held.add(entry.content);
    if (entry.basis?.content !== undefined) held.add(entry.basis.content);
  }
  return held;
};
