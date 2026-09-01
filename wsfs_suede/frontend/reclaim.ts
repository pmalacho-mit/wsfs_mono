/**
 * Making room for work that has not been sent, and saying so when there is
 * none to make.
 *
 * THE CEILING ON THIS IS LOW, and that has to be said before the mechanism.
 * If somebody is offline with a lot of genuinely unsent work, NONE OF IT IS
 * DISCARDABLE -- that is what the outbox is for. What a sweep can free is
 * garbage. When the answer is "nothing can be freed", that is not a failure
 * of the sweep, it is the true answer, and the person needs to hear it as an
 * instruction rather than as an apology.
 *
 * So this is two things, and the verdict is the more important one.
 *
 * WHAT IT COLLECTS. Payloads that no queued row names. They are pure garbage:
 * a payload is stored before the row that names it, and a tab that dies in
 * between leaves one behind -- as does `materialised`, which stores whole text
 * before it re-points a row at it, deliberately (see TODO.md). Nothing has
 * ever collected them.
 *
 * WHAT IT DOES NOT TOUCH, and why:
 *
 *   - Rows in `answers`. They are three ids each and every reconcile prunes
 *     them to the few a snapshot cannot answer for. Dropping them would cost
 *     the accuracy of `unsettled` to save almost nothing.
 *   - Yjs documents. Compacting one means enumerating databases this module
 *     did not create, which `indexedDB.databases()` does not offer in every
 *     browser this is tested in, and rewriting a store another tab may hold
 *     open. Worth doing, not worth doing blind.
 *   - Anything a queued row names. That is the work.
 *
 * DELETE-ONLY, throughout. Writing to a full disk is what failed in the first
 * place, so a pass that recorded its own progress could fail at exactly the
 * moment it is needed.
 */
import type { Digest } from "./bytes";
import type { Id } from "./contract";
import { referenced } from "./kept";
import type { Entry } from "./outbox";

/** Where a pass got to, and what it found. */
export type Reclamation =
  | { phase: "idle" }
  | { phase: "sweeping" }
  /** There was nothing to do: usage is under target. */
  | { phase: "clear" }
  /** There was, and now there is not. */
  | { phase: "freed"; freed: number }
  /**
   * Everything discardable is gone and the store is still nearly full.
   *
   * What is left is work that has not been sent, so the only thing that frees
   * it is sending it. `workspaces` is where it is, for a consumer that can
   * offer to go there and let it drain.
   */
  | { phase: "short"; holding: number; workspaces: Id[] };

/** A payload names its workspace as well as its digest: the store is scoped. */
type Payload = { workspace: Id; digest: Digest; size: number; at?: number };

/** What one pass needs from the store, and nothing else. */
export type Sweepable = {
  /** Every queued row, across every workspace this origin holds. */
  queued: () => Promise<{ workspace: Id; entry: Entry }[]>;
  /** Every stored payload: what it belongs to, how big, and when written. */
  payloads: () => Promise<Payload[]>;
  /** Delete these payloads. Nothing else is ever deleted. */
  drop: (of: { workspace: Id; digest: Digest }[]) => Promise<void>;
};

/** How full the browser says this origin is, or `undefined` if it will not say. */
export type Headroom = { usage: number; quota: number } | undefined;

/**
 * Above this share of the quota, a pass is worth making.
 *
 * Below it there is nothing to say: a store with room in it is not a problem
 * even when it holds garbage, and sweeping on every write would cost more
 * than the space it recovered.
 */
export const CROWDED = 0.85;

export const crowded = (room: Headroom): boolean =>
  room !== undefined && room.quota > 0 && room.usage / room.quota > CROWDED;

/**
 * What the browser will say about this origin, if anything.
 *
 * Absence means "cannot tell", never "fine": a browser that withholds the
 * estimate is not a browser with room to spare, so the caller falls back to
 * reacting to a failure rather than anticipating one.
 */
export const headroom = async (): Promise<Headroom> => {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const { usage, quota } = estimate ?? {};
    return usage === undefined || quota === undefined
      ? undefined
      : { usage, quota };
  } catch {
    return undefined;
  }
};

/**
 * Payloads nothing points at, and old enough to be sure of it.
 *
 * The age is what makes this safe across tabs. A payload is written before
 * the row naming it, so one that has just arrived looks exactly like garbage
 * -- and the guard that knows better is held in the tab that wrote it. Only
 * bytes that predate this pass are considered, so a payload another tab is
 * mid-way through capturing is never in scope. A row with no timestamp
 * predates timestamps, and therefore predates this pass.
 */
export const collectable = (
  payloads: Payload[],
  rows: { workspace: Id; entry: Entry }[],
  started: number,
): Payload[] => {
  const wanted = new Map<Id, Set<Digest>>();
  for (const { workspace, entry } of rows) {
    const held = wanted.get(workspace) ?? new Set<Digest>();
    for (const digest of referenced([entry])) held.add(digest);
    wanted.set(workspace, held);
  }
  return payloads.filter(
    (payload) =>
      (payload.at ?? 0) < started &&
      !wanted.get(payload.workspace)?.has(payload.digest),
  );
};

const named = ({ workspace, digest }: { workspace: Id; digest: Digest }) =>
  `${workspace}:${digest}`;

/** What is left once the garbage is gone, and which workspaces are holding it. */
const stillHeld = (payloads: Payload[], gone: Set<string>) => {
  const kept = payloads.filter((payload) => !gone.has(named(payload)));
  return {
    holding: kept.reduce((total, one) => total + one.size, 0),
    workspaces: [...new Set(kept.map(({ workspace }) => workspace))],
  };
};

/**
 * One pass.
 *
 * `room` is asked again at the end rather than assumed: what a sweep freed is
 * not the only thing that moved while it ran, and the verdict is about the
 * store as it now stands rather than about this pass's arithmetic.
 */
export const sweep = async (
  store: Sweepable,
  room: () => Promise<Headroom>,
  now: () => number,
): Promise<Reclamation> => {
  const started = now();
  const [rows, payloads] = await Promise.all([store.queued(), store.payloads()]);

  const garbage = collectable(payloads, rows, started);
  const freed = garbage.reduce((total, one) => total + one.size, 0);
  if (garbage.length > 0)
    await store.drop(garbage.map(({ workspace, digest }) => ({ workspace, digest })));

  const after = await room();
  if (!crowded(after)) return freed > 0 ? { phase: "freed", freed } : { phase: "clear" };

  /**
   * Still crowded with nothing left to take. Everything below is work that
   * has not been sent, so this names where it is rather than pretending
   * another pass would help.
   */
  return { phase: "short", ...stillHeld(payloads, new Set(garbage.map(named))) };
};

/**
 * One sweep at a time, across every tab on this origin.
 *
 * A sweep is the most destructive thing any tab does to this store, and two
 * at once would each be deciding what is garbage from a half-deleted picture.
 * `ifAvailable` rather than queueing: a tab that cannot get the lock is not
 * kept waiting behind one that is already doing the work -- there is nothing
 * left for it to do.
 */
export const alone = async <T>(
  work: () => Promise<T>,
  otherwise: T,
): Promise<T> => {
  const locks = navigator.locks;
  if (locks?.request === undefined) return work();
  return (await locks.request(
    "wsfs:reclaim",
    { ifAvailable: true },
    async (lock) => (lock === null ? otherwise : work()),
  )) as T;
};
