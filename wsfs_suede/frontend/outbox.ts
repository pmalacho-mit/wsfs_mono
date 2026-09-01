/**
 * The queue of work this client has accepted and the server has not yet
 * answered.
 *
 * Successive writes to one entry CHAIN. They used to coalesce -- a later write
 * replaced an earlier one and inherited its token -- which kept the queue at
 * one item per file but threw away every snapshot but the last. A consumer
 * that writes at particular moments, so it can later say what the code was
 * when the user did some thing, needs all of them to reach the server. So each
 * one is kept, in order, and `writes.ts` puts one on the wire at a time.
 *
 * What keeps that from costing a document per keystroke is that a chained
 * write is stored as a DELTA against the one before it -- see `delta.ts`. The
 * head of a chain holds whole text; everything behind it holds an edit script,
 * which is the size of what changed rather than the size of the file. A queue
 * that has been offline all afternoon is a document and a pile of diffs.
 *
 * And an item is a row of POINTERS: content lives in the byte store under its
 * hash, never inline on the request. That was the claim this file already
 * made, and for text it was false -- the text sat in `request.content` AND
 * under its digest, so the store bought nothing on the commonest payload
 * there is. `content: null` on a queued write means "the bytes are the store's
 * business", and `writes.ts` puts them back on the way out.
 */
import type { Digest, Store } from "./bytes";
import { nowhere, type Kept } from "./kept";
import { applyDelta, deltaBetween, type Delta } from "./delta";
import {
  isWrite,
  type Body,
  type Id,
  type Submitted,
  type Transaction,
  type Write,
} from "./contract";
import { session } from "./identity";
import { mintedAt } from "./minted";

/**
 * A text write with its body elided while it waits. `null` is the marker, and
 * it is a marker rather than an empty string so that a request which somehow
 * escapes without being filled in is refused by the server rather than
 * silently blanking a file.
 */
export type Elided = Omit<Write, "content"> & { content: Body | null };

export type Held = Exclude<Submitted, Write> | Elided;

/**
 * What a chained write's stored bytes are a delta against.
 *
 * `content` is empty while the predecessor is still queued -- its digest is
 * simply read off it. It gets filled in when the predecessor LEAVES, because
 * at that moment this delta becomes the only thing that can still read those
 * bytes back, and the byte store would otherwise be told to forget them.
 */
export type Basis = { after: Transaction; content?: Digest };

export type Entry = {
  /** Which page load queued this. An older one never reached the screen. */
  session: string;
  /**
   * When the user acted, ISO 8601 with an explicit Z: sortable, unambiguous,
   * and for humans.
   *
   * READ OUT OF THE REQUEST'S OWN ID rather than off the clock a second time.
   * The transaction is a UUIDv7, so it already carries the millisecond it was
   * minted -- and that is the number the server will derive when it records
   * this. Two clock reads here would be two answers to one question, and the
   * one this client showed would be the one nobody else could see.
   */
  at: string;
  request: Held;
  /** Set when the request's payload lives in the byte store. */
  content?: Digest;
  /** Set when those bytes are a delta rather than the payload itself. */
  basis?: Basis;
};

export type Queue = {
  entries: () => Entry[];
  capture: (request: Submitted, content?: Digest, basis?: Transaction) => Entry;
  evict: (transactions: Iterable<Transaction>) => Digest[];
  /** Every queued write for one entry, oldest first. */
  chain: (entry: Id) => Entry[];
  find: (transaction: Transaction) => Entry | undefined;
  /**
   * Replace a chained write's delta with the whole text it works out to, now
   * that it is the one going on the wire. Returns the digests that stopped
   * being needed.
   */
  promote: (transaction: Transaction, content: Digest) => Digest[];
  size: () => number;
};

const stamped = (
  request: Held,
  content?: Digest,
  basis?: Transaction,
): Entry => ({
  session,
  at: (mintedAt(request.transaction) ?? new Date()).toISOString(),
  request,
  ...(content === undefined ? {} : { content }),
  ...(basis === undefined ? {} : { basis: { after: basis } }),
});

/**
 * A text write goes in without its body. A binary one goes in whole, because
 * its body is ALREADY a pointer -- a hash, a size and a mime type -- so there
 * is no bulk on the request to take off it.
 */
const elided = (request: Submitted): Held =>
  isWrite(request) && request.content.type === "text"
    ? { ...request, content: null }
    : request;

export const isElided = (request: Held): request is Elided =>
  isWrite(request as Submitted) && (request as Elided).content === null;

/**
 * `kept` is told by the queue rather than by its callers.
 *
 * There are six places that move an item, three of them inside `writes.ts`,
 * and one of them is not a call at all -- evicting an item hands the digest it
 * was holding to the chained write behind it. A rule spread over six call
 * sites is one that gets five of them.
 */
export const queue = (held: Entry[] = [], kept: Kept = nowhere): Queue => {
  const items = [...held];

  /**
   * Two items can name one digest -- the store is content-addressed, so
   * identical text hashes to one place -- and a chained write names its
   * predecessor's. Nothing is released while anything still points at it.
   */
  const referenced = (digest: Digest) =>
    items.some(
      (item) => item.content === digest || item.basis?.content === digest,
    );

  const freeing = (digests: (Digest | undefined)[]) => {
    const released: Digest[] = [];
    for (const digest of digests)
      if (digest !== undefined && !referenced(digest) && !released.includes(digest))
        released.push(digest);
    return released;
  };

  return {
    entries: () => [...items],
    size: () => items.length,
    find: (transaction) =>
      items.find((item) => item.request.transaction === transaction),
    chain: (entry) =>
      items.filter(
        (item) => isWrite(item.request as Submitted) && item.request.id === entry,
      ),

    capture: (request, content, basis) => {
      const captured = stamped(elided(request), content, basis);
      items.push(captured);
      kept.moved({ written: [captured] });
      return captured;
    },

    promote: (transaction, content) => {
      const item = items.find(
        (queued) => queued.request.transaction === transaction,
      );
      if (item === undefined) return [];
      const stale = [item.content, item.basis?.content];
      item.content = content;
      delete item.basis;
      kept.moved({ written: [item] });
      return freeing(stale);
    },

    evict: (transactions) => {
      const answered = new Set(transactions);
      const stale: (Digest | undefined)[] = [];
      const gone: Transaction[] = [];
      const amended: Entry[] = [];
      for (let at = items.length - 1; at >= 0; at -= 1) {
        const item = items[at]!;
        if (!answered.has(item.request.transaction)) continue;
        items.splice(at, 1);
        gone.push(item.request.transaction);
        /**
         * A chained write behind this one is a delta against bytes that are
         * about to be forgotten. Hand it the digest on the way past: it is now
         * the only reason those bytes are worth keeping.
         */
        const behind = items.find(
          (queued) => queued.basis?.after === item.request.transaction,
        );
        if (behind?.basis !== undefined && item.content !== undefined) {
          behind.basis.content = item.content;
          amended.push(behind);
        }
        stale.push(item.content, item.basis?.content);
      }
      /**
       * One change, not two. A store told to remove these and separately to
       * amend those could be killed between the two, and what came back would
       * be a delta against a predecessor that is gone.
       */
      if (gone.length > 0) kept.moved({ written: amended, gone });
      return freeing(stale);
    },
  };
};

/**
 * The bytes a queued write named are not there, and never will be.
 *
 * Told apart from every other failure a read can have, because the answers
 * are opposite: a store that REFUSED will likely answer next time, so the
 * write waits. Bytes that are GONE will not, so the write has to be given up
 * and said out loud -- and anything that keeps retrying it stops the queue
 * behind it moving at all.
 */
export class LostBytes extends Error {
  constructor(
    readonly transaction: Transaction,
    message: string,
  ) {
    super(message);
    this.name = "LostBytes";
  }
}

/**
 * The text a queued write would send, whether it is holding the whole thing or
 * a delta against the one in front of it.
 *
 * A delta's basis is read from the entry the chain names while that entry is
 * still queued, and from the digest it left behind once it is gone.
 */
export const textOf = async (
  item: Entry,
  queue: Queue,
  bytes: Store,
): Promise<string> => {
  const stored = item.content === undefined ? undefined : await bytes.text(item.content);
  if (stored === undefined)
    throw new LostBytes(
      item.request.transaction,
      `Queued write ${item.request.transaction} has lost its bytes`,
    );
  if (item.basis === undefined) return stored;

  /**
   * Resolved through the entry the chain names while it is still queued, so a
   * chain three deep unwinds all the way to the whole text at its head. The
   * digest left behind by an entry that has gone needs no unwinding: nothing
   * leaves without being promoted first, so those bytes are already whole.
   */
  const ahead = queue.find(item.basis.after);
  const before =
    item.basis.content !== undefined
      ? await bytes.text(item.basis.content)
      : ahead === undefined
        ? undefined
        : await textOf(ahead, queue, bytes);
  if (before === undefined)
    throw new LostBytes(
      item.request.transaction,
      `Queued write ${item.request.transaction} is a delta against ` +
        `${item.basis.after}, which is no longer readable`,
    );
  return applyDelta(before, JSON.parse(stored) as Delta);
};

/** The edit script from one queued text to the next, ready to be stored. */
export const chained = (before: string, after: string): string =>
  JSON.stringify(deltaBetween(before, after));

/**
 * What a queued item could not say, and why.
 *
 * Its bytes are gone: the browser cleared the store, or the tab died between
 * the payload landing and the row that names it. The work is not recoverable
 * from anywhere -- but it is ONE transaction, and the queue behind it is
 * fine, so this is reported rather than thrown.
 */
export type Unreadable = { transaction: Transaction; why: string };


export type Presented = { presented: Submitted[]; unreadable: Unreadable[] };

/**
 * What Initialize is given: the requests themselves, in the order they were
 * queued, with elided bodies filled back in.
 *
 * Only the FIRST queued write per entry is presented. The rest are chained
 * behind it, and each one's token is the transaction of the one in front --
 * which is a token the server can only agree with after it has accepted that
 * one. Replay is a single batch with no answers in it, so there is nowhere for
 * that agreement to happen; the followers go out afterwards, through the pump,
 * one answer at a time.
 *
 * NOTHING HERE THROWS. It used to, and the cost was the whole workspace: an
 * item whose bytes could not be read failed Initialize, the loop backed off
 * and re-entered at Initialize, and failed the same way for ever. One
 * unreadable transaction stopped every OTHER queued transaction from ever
 * being sent -- turning a single lost write into a queue that never drains
 * again. What cannot be read is named and left for the caller to evict.
 */
export const presenting = async (
  items: Entry[],
  queue: Queue,
  bytes: Store,
): Promise<Presented> => {
  const led = new Set<Id>();
  const presented: Submitted[] = [];
  const unreadable: Unreadable[] = [];
  for (const item of items) {
    if (isWrite(item.request as Submitted)) {
      if (led.has(item.request.id)) continue;
      led.add(item.request.id);
    }
    if (!isElided(item.request)) {
      presented.push(item.request as Submitted);
      continue;
    }
    try {
      presented.push({
        ...(item.request as Elided),
        content: { type: "text", content: await textOf(item, queue, bytes) },
      });
    } catch (reason) {
      /**
       * The transaction the READ blames, which for a broken chain is not the
       * one being presented: a delta three deep fails on whichever ancestor
       * lost its bytes, and that is the one there is nothing left of.
       */
      unreadable.push({
        transaction:
          reason instanceof LostBytes
            ? reason.transaction
            : item.request.transaction,
        why: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }
  return { presented, unreadable };
};
