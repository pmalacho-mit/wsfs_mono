/**
 * Content pulled into the cache before anybody asks for it.
 *
 * Warming exists so the kernel's synchronous filesystem calls are answered
 * out of state rather than out of a request they would have to block on. That
 * makes it an OPTIMISATION, and the whole of this module follows from saying
 * so out loud: nothing here is on a correctness path, so every request it
 * makes is one it has to justify, and a request it can avoid is free.
 *
 * Two things it avoids.
 *
 * COALESCED PER ENTRY, and resolved late. A client that reconnects replays
 * every event it missed, and a file somebody was typing into produces one
 * write event per save. Warming on each of them fetched every version the
 * file passed through, of which all but the last were already superseded by
 * the time the answer arrived -- twenty-five requests to learn one thing.
 * Asking for an entry by ID and looking up its version at the moment the
 * request goes means a burst collapses to a single fetch of the version that
 * is current when the dust settles. The others are never asked for at all,
 * which is the difference between deferring a storm and not having one.
 *
 * BOUNDED. Coalescing per entry does nothing for a workspace being opened,
 * where every file wants warming at once and each is a different entry. A
 * hundred files is a hundred requests, and they arrive together because
 * nothing spaced them out.
 */

import { MappedDebouncer, type Config } from "./debounce";
import type { Id, Metadata } from "./contract";

export const SETTLING: Config = {
  /**
   * Short, because this delays a real thing: a file opened right now is
   * readable this much later than it would have been. Long enough to gather
   * a replay burst -- events arrive in chunks a few milliseconds apart --
   * and short enough not to be noticed by somebody clicking a file.
   */
  idleMs: 60,
  /**
   * A steady stream of writes -- somebody typing with a short save debounce
   * -- must not hold warming off for ever. This is the point at which a
   * burst is warmed whether or not it has finished.
   */
  maxWaitMs: 500,
};

/**
 * How many warming fetches are in the air at once.
 *
 * Not tuned. Small enough that opening a workspace does not look like an
 * attack, large enough that a hundred small files do not arrive one round
 * trip at a time.
 */
export const AT_ONCE = 6;

export type Warming = {
  /** This entry's current content, soon, and once however often it moves. */
  wanted: (entry: Metadata | undefined) => void;
  /** Warm everything outstanding now, without waiting out the debounce. */
  settle: () => void;
  stop: () => void;
};

export type Warm = {
  /** What this entry is now -- read when the request goes, not when it was asked for. */
  current: (entry: Id) => Metadata | undefined;
  fetch: (entry: Metadata) => Promise<unknown>;
  settling?: Config;
  atOnce?: number;
};

/**
 * At most `limit` at a time, in the order they were asked for.
 *
 * Small enough to write down rather than reach for, and the alternative is
 * worse than the code: an unbounded fan-out is what the server's admission
 * gate exists to refuse, and being refused is slower than having waited.
 */
const inTurn = (limit: number) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work: () => Promise<unknown>) => {
    /**
     * The count is taken BEFORE waiting and never released to a newcomer,
     * which is what makes `limit` a limit. Releasing the count and then
     * waking a waiter leaves a gap: a caller arriving in between sees room,
     * takes it, and the waking waiter takes it again -- one over, quietly.
     * Today's callers arrive on a timer and cannot hit that window, but a
     * bound that holds only because of who calls it is not a bound.
     */
    if (running >= limit) {
      await new Promise<void>((go) => waiting.push(go));
    } else {
      running += 1;
    }
    try {
      await work();
    } finally {
      const next = waiting.shift();
      if (next) next(); // hands this slot straight over, never releasing it
      else running -= 1;
    }
  };
};

export const warming = ({
  current,
  fetch,
  settling = SETTLING,
  atOnce = AT_ONCE,
}: Warm): Warming => {
  /**
   * `flushWhenHidden: false`, unlike everything else that debounces here.
   * Warming is work nobody asked for, so firing it as the tab goes away
   * spends a burst of requests on content that will never be read.
   */
  const soon = new MappedDebouncer<Id>({ ...settling, flushWhenHidden: false });
  let stopped = false;
  const oneAtATime = inTurn(atOnce);

  const warm = (id: Id) => {
    /**
     * Looked up HERE rather than captured when `wanted` was called. This is
     * the coalescing: whatever the entry was when the burst started, what
     * gets fetched is what it is now.
     *
     * `undefined` is ordinary -- the entry was deleted while the burst was
     * settling -- and means there is nothing to warm rather than that
     * something went wrong.
     */
    const entry = current(id);
    if (entry === undefined || entry.type !== "file") return;
    void oneAtATime(() => fetch(entry).catch(() => undefined));
  };

  return {
    wanted: (entry) => {
      // `enqueue` throws once disposed, and a stopped workspace still has a
      // stream in flight that may announce one more entry on its way down.
      if (stopped || entry === undefined || entry.type !== "file") return;
      soon.enqueue(entry.id, () => warm(entry.id));
    },
    /** Warm everything outstanding now. No production caller yet; see the type. */
    settle: () => soon.flushAll(),
    stop: () => {
      stopped = true;
      soon.dispose();
    },
  };
};
