/**
 * One content write per entry on the wire at a time.
 *
 * The server's compare-and-swap is exact: a write presents the token it
 * believes is current, and if it is not, the write is refused. That is the
 * right rule, and this client used to break it against itself. Two writes to
 * one file minted moments apart BOTH read the same token, because a queued
 * write is deliberately not laid over `content_version` -- see the note in
 * `effective.ts`, which is about keeping the content cache honest. So the
 * second one presented a token the first had already replaced, and lost.
 *
 * The fix is not to relax the swap. It is to stop asking two questions with
 * one answer:
 *
 *   - what token invalidates my cached bytes?   the confirmed one, still
 *   - what token do I write against?            the one in front of me
 *
 * The second question is this file's. Writes to one entry queue in order, one
 * goes out at a time, and the next presents the transaction of the one before
 * it once that one has been accepted. A chain of a client's own writes lands
 * as a chain. A write from somebody ELSE landing in the middle still refuses
 * everything behind it, because their token is one nobody here can name --
 * which is the protection the swap exists to give, kept intact.
 *
 * Waiting for the answer, rather than the stream event, is what makes the
 * queue affordable: only the head of a chain holds whole text, and the rest
 * are deltas against it, so the wait costs a diff rather than a document.
 */
import { digestOf, type Digest, type Store } from "./bytes";
import type { Payload } from "./content";
import {
  kept,
  UNSOUND,
  type Body,
  type Id,
  type Response,
  type Submitted,
  type Transaction,
  type Version,
  type Write,
} from "./contract";
import { offset } from "./minted";
import {
  chained,
  isElided,
  LostBytes,
  textOf,
  type Entry,
  type Queue,
  type Unreadable,
} from "./outbox";

export type Wiring = {
  queue: Queue;
  bytes: Store;
  /** Put one request on the wire. */
  send: (request: Submitted) => Promise<Response>;
  /** Recompute and announce -- the same door every other state change uses. */
  announced: () => void;
  /** Hold what a queued write says the file contains, under its own token. */
  remembered: (version: Transaction, payload: Payload) => void;
  /** The confirmed content token for an entry: what the stream last said. */
  token: (entry: Id) => Version | null;
  /** This client's state cannot be reconciled by rebasing; start over. */
  unsound: () => void;
  /** Queued work whose bytes are gone: it can never be sent, however often. */
  lost?: (entries: Unreadable[]) => void;
};

export type Pump = {
  /**
   * Queue a write and return the server's answer to it. The transaction is
   * the caller's already -- it minted it -- because the change is announced
   * before this promise has anything to say.
   */
  write: (
    entry: Id,
    request: Write,
    payload: string | Uint8Array,
    mime: string,
  ) => Promise<Response>;
  /**
   * Start the queue moving again for every entry holding one. Called after a
   * reconcile, which is the moment a queue restored from storage -- or one
   * stalled by a connection that went away mid-chain -- gets to carry on.
   */
  resume: () => void;
};

const isText = (payload: string | Uint8Array): payload is string =>
  typeof payload === "string";

export const heldAs = (payload: string | Uint8Array, mime: string): Payload =>
  isText(payload)
    ? { kind: "text", text: payload }
    : { kind: "binary", bytes: payload, mime };

export const pump = (wiring: Wiring): Pump => {
  const { queue, bytes } = wiring;

  /** Answers owed to callers, by the transaction they are about. */
  const owed = new Map<Transaction, (answer: Response) => void>();
  const failed = new Map<Transaction, (error: unknown) => void>();
  /** Sent and still unanswered, or answered and not yet off the queue. */
  const sent = new Set<Transaction>();
  /**
   * Sent and accepted AS CONTENT: the tokens a follower may write against.
   *
   * A draft is answered without being rejected and is still not one of these.
   * It never became the file's content, so the server never issued its
   * transaction as a version -- presenting it would be presenting a token
   * nobody has heard of.
   */
  const accepted = new Set<Transaction>();
  const draining = new Set<Id>();
  /** One entry's captures, in the order they were asked for. */
  const queueing = new Map<Id, Promise<unknown>>();

  /**
   * Queueing a write is not instantaneous -- the payload is hashed, and a
   * chained one is diffed against the text in front of it -- so two writes
   * asked for in the same tick would otherwise race to be captured. That is
   * not a nicety: the loser would be stored as a delta against a tail that is
   * no longer the tail, and the chain would say the user typed things in an
   * order they did not. The order they were ASKED for is the only order that
   * means anything here, so it is the one this holds them to.
   */
  const inOrder = async <T>(entry: Id, work: () => Promise<T>): Promise<T> => {
    const before = queueing.get(entry) ?? Promise.resolve();
    const mine = before.then(work, work);
    queueing.set(
      entry,
      mine.catch(() => undefined),
    );
    return mine;
  };

  /**
   * Bookkeeping about transactions the queue no longer holds is bookkeeping
   * about nothing. Dropped here rather than on a hook, so no caller has to
   * remember to tell this file that an eviction happened.
   */
  const tidy = () => {
    const queued = new Set(
      queue.entries().map(({ request }) => request.transaction),
    );
    for (const set of [sent, accepted])
      for (const transaction of [...set])
        if (!queued.has(transaction)) set.delete(transaction);
  };

  const released = (digests: Digest[]) => {
    if (digests.length > 0) void bytes.forget(digests);
  };

  /**
   * Where a write's payload goes. Text behind another write for the same entry
   * is stored as the edit script from that one to this; everything else is
   * stored whole.
   */
  const staged = async (
    entry: Id,
    payload: string | Uint8Array,
  ): Promise<{
    held: string | Uint8Array;
    content: Digest;
    basis?: Transaction;
  }> => {
    const chain = queue.chain(entry);
    const tail = chain[chain.length - 1];
    const whole = async () => ({
      held: payload,
      content: await digestOf(payload),
    });
    if (!isText(payload) || tail === undefined || !isElided(tail.request))
      return whole();

    /**
     * A tail whose bytes are gone cannot be diffed against, and refusing on
     * its account would stop the person typing over a write that is already
     * lost. Stored whole instead: the tail is no more readable than it was,
     * `drain` still drops it on the way out, and this write does not need it.
     */
    let before: string;
    try {
      before = await textOf(tail, queue, bytes);
    } catch (reason) {
      if (!(reason instanceof LostBytes)) throw reason;
      return whole();
    }

    const delta = chained(before, payload);
    /**
     * A delta is only worth having if it is smaller. A rewrite diffs to
     * remove-everything/insert-everything, and JSON-encoding that is bigger
     * than the text it describes -- so chaining it would cost space AND make
     * the write unreadable if its predecessor were ever lost.
     */
    return delta.length >= payload.length
      ? whole()
      : {
          held: delta,
          content: await digestOf(delta),
          basis: tail.request.transaction,
        };
  };

  /**
   * Staged and queued with nothing in between, and retried if the tail moved.
   *
   * Staging is not instantaneous -- it reads the write in front, diffs against
   * it, and stores the result -- and the answer to that write can arrive
   * during it. The tail then leaves the queue, taking the hand-off that would
   * have given this delta the bytes it needs, and what gets queued is a delta
   * against a predecessor that is not there: unreadable, and unreadable
   * FOREVER once the queue survives the page that made it.
   *
   * The check and the capture have no `await` between them, which is what
   * makes them one step. Nothing is thrown away but a delta that turned out to
   * describe nothing.
   */
  const chainedIn = async (
    entry: Id,
    request: Write,
    payload: string | Uint8Array,
  ): Promise<void> => {
    for (;;) {
      const { held, content, basis } = await staged(entry, payload);
      if (basis !== undefined && queue.find(basis) === undefined) continue;
      /**
       * Row first, bytes second, and no `await` between the check and the
       * capture. Bytes with no row are work that is gone unnoticed; a row
       * with no bytes is work that is gone and SAYS so, which `presenting`
       * can report and drop.
       *
       * That is the right order for a tab that dies, and the wrong thing to
       * leave behind when the store simply REFUSES. This row is the entry's
       * chain tail, so the next write diffs against it, cannot read it, and
       * throws -- and so does every write to that file after it, for the life
       * of the page. Saying "the work is gone" is not the same as being right
       * to leave a poisoned tail behind, so the row comes back with it.
       */
      const captured = queue.capture(
        { ...request, offset: offset() },
        content,
        basis,
      );
      try {
        await bytes.put(held, content);
      } catch (reason) {
        released(queue.evict([captured.request.transaction]));
        throw reason;
      }
      return;
    }
  };

  /**
   * The request as it goes out: body filled back in, token chosen now rather
   * than when it was queued.
   *
   * Promoting first is what keeps the chain readable. This item's delta is
   * about to stop being the shortest description of it -- the one in front is
   * leaving -- so it is written out whole while the bytes it needs are still
   * there, and whatever that frees is handed back to the store.
   */
  const materialised = async (item: Entry, ahead: Entry | undefined) => {
    const request = item.request as Write;
    let body: Body = request.content;

    if (isElided(item.request)) {
      const text = await textOf(item, queue, bytes);
      body = { type: "text", content: text };
      if (item.basis !== undefined) {
        /**
         * BYTES FIRST HERE, and the asymmetry with `chainedIn` is the point.
         *
         * There the row is the only record that the user asked for anything,
         * so it goes first. Here the row already exists and is already
         * readable -- as a delta against the write in front of it -- so
         * nothing is recorded only in the bytes at any moment, and the order
         * is chosen by what a refusal costs instead.
         *
         * `promote` re-points the row at whole text AND deletes the basis, so
         * running it first and then failing to store destroys both readings
         * of a write that was valid and durable a moment earlier. Run last it
         * cannot fail, and until it runs the delta is still the truth.
         *
         * The cost is an orphaned payload if this dies in between: a leak,
         * not a loss. See TODO.md.
         */
        const whole = await digestOf(text);
        await bytes.put(text, whole);
        released(queue.promote(request.transaction, whole));
      }
    }

    /**
     * The token in front, but only while it is still in the queue: once the
     * stream has carried it the confirmed answer is the same one, and it is
     * the one that stays right if this chain is picked up after a reload.
     *
     * With nothing in front, the confirmed token -- and where there is no
     * confirmed token at all, the one the request was minted with. That is a
     * file whose CREATE is itself still queued: the entry exists nowhere but
     * this outbox, and the only name its content has is the transaction that
     * is bringing it into existence.
     */
    const against =
      ahead !== undefined && accepted.has(ahead.request.transaction)
        ? ahead.request.transaction
        : (wiring.token(request.id) ?? request.content_version);

    /**
     * What the server diffs this against if it has to keep it. Only ever the
     * write in front of THIS chain, and only a hint: naming it cannot make
     * this land, and leaving it out costs the server space rather than
     * correctness. See `refusals` on the backend.
     */
    const predecessor = ahead?.request.transaction ?? null;

    return {
      ...request,
      content: body,
      content_version: against,
      predecessor,
    } as Submitted;
  };

  const drain = async (entry: Id) => {
    if (draining.has(entry)) return;
    draining.add(entry);
    try {
      for (;;) {
        tidy();
        const chain = queue.chain(entry);
        const at = chain.findIndex(
          (item) => !sent.has(item.request.transaction),
        );
        if (at < 0) return;

        const item = chain[at]!;
        const transaction = item.request.transaction;
        sent.add(transaction);

        const abandoned = (error: unknown) => {
          sent.delete(transaction);
          failed.get(transaction)?.(error);
          owed.delete(transaction);
          failed.delete(transaction);
        };

        let outgoing: Submitted;
        try {
          outgoing = await materialised(item, chain[at - 1]);
        } catch (error) {
          /**
           * Bytes that are GONE, rather than a store that refused. Retrying
           * cannot help and this is the only place that finds out: Initialize
           * names and drops these, but a client whose stream is healthy never
           * reaches Initialize, so without this the entry stops here and is
           * retried identically for ever.
           *
           * `continue`, not `return`, and it cascades on its own: evicting
           * hands the write behind this one the digest it was holding, so
           * that one fails the same way on the next turn and is dropped too,
           * until the poison is out and the rest of the chain goes.
           */
          if (error instanceof LostBytes) {
            released(queue.evict([error.transaction]));
            wiring.lost?.([{ transaction: error.transaction, why: error.message }]);
            abandoned(error);
            continue;
          }
          /**
           * Never left this machine, and nothing about the item changed:
           * `materialised` writes the whole text down before it re-points the
           * row at it, so a store that refused leaves the delta that was
           * already there. Still queued, still readable, tried again on the
           * next drain. This entry stops here so nothing behind it overtakes
           * it.
           */
          abandoned(error);
          return;
        }

        let answer: Response;
        try {
          answer = await wiring.send(outgoing);
        } catch (error) {
          /**
           * Nothing was answered, so nothing is known -- least of all whether
           * the server saw it. The item stays queued for reconcile to replay,
           * and this entry stops here so that what is behind it cannot
           * overtake it.
           */
          abandoned(error);
          return;
        }

        owed.get(transaction)?.(answer);
        owed.delete(transaction);
        failed.delete(transaction);

        if (kept(answer)) {
          /**
           * Kept, not applied. It leaves the queue like a refusal -- no event
           * will follow it either -- but it is not a failure and the writes
           * behind it carry on against the token it presented.
           */
          released(queue.evict([transaction]));
          continue;
        }

        if (!answer.rejected) {
          accepted.add(transaction);
          continue;
        }

        if (answer.reason === UNSOUND) wiring.unsound();
        released(queue.evict([transaction]));
        wiring.announced();
      }
    } finally {
      draining.delete(entry);
    }
  };

  return {
    resume: () => {
      const entries = new Set(
        queue.entries().map(({ request }) => request.id as Id),
      );
      for (const entry of entries) void drain(entry);
    },

    write: (entry, request, payload, mime) => {
      const answered = new Promise<Response>((settle, broke) => {
        owed.set(request.transaction, settle);
        failed.set(request.transaction, broke);
      });
      /**
       * Registered before anything is awaited, and the place in the queue is
       * taken before anything is awaited, so a caller that issues two writes
       * without waiting for the first gets them in the order it issued them.
       */
      void inOrder(entry, async () => {
        try {
          await chainedIn(entry, request, payload);
          wiring.remembered(request.transaction, heldAs(payload, mime));
          wiring.announced();
          void drain(entry);
        } catch (error) {
          /**
           * Nothing is queued. Either the capture never happened, or the
           * bytes it named could not be stored and `chainedIn` took the row
           * back with them -- so there is nothing here to undo, only to say.
           */
          failed.get(request.transaction)?.(error);
          owed.delete(request.transaction);
          failed.delete(request.transaction);
        }
      });
      return answered;
    },
  };
};
