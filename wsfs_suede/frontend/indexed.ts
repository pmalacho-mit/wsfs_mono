/**
 * The durable outbox: IndexedDB, one database, everything scoped by workspace.
 *
 * Three stores, and the split is the point. `queued` holds the rows of
 * pointers -- what was asked for and has not been answered. `answers` holds
 * the three things a snapshot cannot speak to. `bytes` holds the payloads
 * those rows point at, under their own digests.
 *
 * A ROW PER TRANSACTION, not a document per workspace. Two tabs share this
 * storage, and each appends and removes its own rows without either of them
 * reading a whole outbox and writing back a version that forgot the other's
 * work. Nothing here assumes the tab that finds a row is the tab that wrote it.
 */
import { asText, digestOf, type Digest, type Store } from "./bytes";
import type { Id, Transaction } from "./contract";
import { referenced, type Faltering, type Kept, type Restored } from "./kept";
import {
  alone,
  crowded,
  headroom,
  sweep,
  type Reclamation,
  type Sweepable,
} from "./reclaim";
import type { Entry } from "./outbox";

const DATABASE = "wsfs";
const VERSION = 2;

const QUEUED = "queued";
const ANSWERS = "answers";
const BYTES = "bytes";

const WORKSPACE = "workspace";

/** Scoped by construction: no key can be formed without naming its workspace. */
const keyed = (workspace: Id, id: string) => `${workspace}:${id}`;

type Queued = {
  key: string;
  workspace: Id;
  transaction: Transaction;
  entry: Entry;
};
type Answer = { key: string; workspace: Id; transaction: Transaction };
type Bytes = {
  key: string;
  workspace: Id;
  digest: Digest;
  bytes: Uint8Array;
  /**
   * When these bytes were written, as milliseconds since the epoch.
   *
   * DURABLE, and that is the point: a payload is stored before the row that
   * names it, so there is always a moment when it looks like garbage. The
   * in-memory guard that covers that moment is TAB-LOCAL, so a sweep in one
   * tab cannot see that another stored bytes a moment ago and has not
   * captured the row yet. A timestamp on the row is a fact both tabs read.
   *
   * Absent on rows written before this was added, which reads as "older than
   * any sweep" -- correct, because they are.
   */
  at?: number;
};

const awaited = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((done, failed) => {
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(request.error);
  });

const opened = (): Promise<IDBDatabase> =>
  new Promise((done, failed) => {
    if (typeof indexedDB === "undefined")
      return failed(
        new Error(
          "IndexedDB is unavailable, so a queue cannot outlive the page. " +
            "Connect with `bytes: inMemory()` and no `kept` to accept that, " +
            "knowing unsent work dies with the tab.",
        ),
      );
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [QUEUED, ANSWERS, BYTES]) {
        if (database.objectStoreNames.contains(name)) continue;
        database
          .createObjectStore(name, { keyPath: "key" })
          .createIndex(WORKSPACE, WORKSPACE, { unique: false });
      }
    };
    /**
     * A version change waits for every other tab to let go of the old one,
     * and without this it waits FOR EVER -- silently, with no error and no
     * timeout, so the app simply never finishes opening. Saying so is the
     * least this can do; the tab that is blocking is the user's own.
     */
    request.onblocked = () =>
      failed(
        new Error(
          "This workspace is open in another tab running an older version. " +
            "Close it, or reload it, and this one will finish opening.",
        ),
      );
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(request.error);
  });

const everythingIn = <T>(
  database: IDBDatabase,
  store: string,
  workspace: Id,
): Promise<T[]> =>
  awaited(
    database
      .transaction(store, "readonly")
      .objectStore(store)
      .index(WORKSPACE)
      .getAll(IDBKeyRange.only(workspace)),
  ) as Promise<T[]>;

/** Wall clock, in one place, so a test can hold it still. */
const now = () => Date.now();

const isFull = (reason: unknown) =>
  reason instanceof Error &&
  (reason.name === "QuotaExceededError" || /quota/i.test(reason.message));

const troubleFrom = (reason: unknown): Faltering =>
  isFull(reason)
    ? {
        says: "there is no room left to write down work that has not been sent",
        full: true,
      }
    : {
        says:
          "work that has not been sent is not being written down: " +
          (reason instanceof Error ? reason.message : String(reason)),
        full: false,
      };

/**
 * Whether the browser may clear this origin's storage to make room.
 *
 * Asked WITHOUT prompting. Storage a browser is willing to evict is storage
 * the outbox can be evicted from, and the answer is worth knowing even where
 * nothing is going to be done about it.
 */
export const evictable = async (): Promise<boolean> => {
  try {
    return !((await navigator.storage?.persisted?.()) ?? false);
  } catch {
    return true;
  }
};

/**
 * Ask the browser not to clear this origin's storage.
 *
 * SEPARATE FROM `persistenceMechanism`, and deliberately, because in some browsers this
 * shows the user a permission prompt -- and a library that made one appear as
 * a side effect of opening a queue would be deciding something that is not
 * its to decide. Call it at a moment that makes sense to the person looking
 * at the screen. Answers whether it worked; false is not an error, it is a
 * browser saying no.
 */
export const requestPersistence = async (): Promise<boolean> => {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
};

export type Persistence = {
  bytes: Store;
  kept: Kept;
  restored: Restored;
  /**
   * Whether the queue is actually reaching the disk, and what is wrong if not.
   *
   * `undefined` means it is. Anything else means work is being kept only in
   * memory, which is the one thing this module exists to prevent -- so it is
   * answered rather than logged, and `watch` says when it changes.
   */
  faltering: () => Faltering | undefined;
  watch: (changed: () => void) => () => void;
  /**
   * What the last pass at making room found, and whether one is running.
   *
   * Reported through the same `watch` as `faltering`, because a consumer is
   * watching one thing: whether the work it is holding is safe.
   */
  /**
   * Settles once everything asked for so far has reached the disk.
   *
   * The queue's own writes are fire-and-forget, because the copy in memory is
   * already right and making the outbox wait on a disk would pay at the wrong
   * time. That is fine while the page lives and wrong at the moment it stops:
   * a teardown that CAN wait -- a panel closing, a workspace being put away,
   * a tab reloading itself -- and does not, throws away answers that were on
   * their way. A tab that is killed cannot wait, and that is inherent; one
   * that is closing tidily has no excuse.
   */
  flushed: () => Promise<void>;
  reclamation: () => Reclamation;
  /** Make room now. Answers what it found; one pass at a time, per origin. */
  reclaim: () => Promise<Reclamation>;
  /**
   * Every workspace with unsent work written down here.
   *
   * A queue is drained by the stream of the workspace it belongs to, and a
   * client follows one workspace at a time -- so work queued somewhere the
   * user has navigated away from waits, correctly, for them to come back.
   * This is what lets a consumer say so rather than leaving it silent.
   */
  waiting: () => Promise<Id[]>;
};

/**
 * Open the durable outbox for one workspace and read back what it holds.
 *
 * Awaited once, before `connect`, because a client that started serving reads
 * and then discovered it had queued work would have shown a view that was
 * missing its own.
 */
export const persistenceMechanism = async (
  workspace: Id,
): Promise<Persistence> => {
  const database = await opened();

  /**
   * One chain, and everything that WRITES or reads-to-decide is on it.
   *
   * The queue in memory is already right, so no caller waits for a disk --
   * but the order matters between two of these. Evicting a queued write hands
   * the digest it was holding to the chained write behind it, and the byte
   * store then asks what is still referenced. Ask that before the hand-over
   * has landed and the answer is "nothing", the bytes go, and the delta
   * behind them can never be read back. That is not hypothetical: it is what
   * happened, in both browsers, the first time a real store was underneath.
   */
  let writing: Promise<unknown> = Promise.resolve();
  let faltering: Faltering | undefined;
  const watchers = new Set<() => void>();

  const nowSaying = (trouble: Faltering | undefined) => {
    const before = faltering?.says;
    faltering = trouble;
    if (before !== trouble?.says)
      for (const changed of [...watchers]) changed();
    /**
     * A store that has just said it is FULL is the one moment worth sweeping
     * without waiting to be asked -- and the last moment at which sweeping
     * can still help, because everything after this needs room to work in.
     */
    if (trouble?.full === true) void reclaim();
  };

  /**
   * Every failure is caught, and NONE is swallowed.
   *
   * This used to end `.catch(() => undefined)`, which meant a full disk, a
   * blocked store or a browser clearing site data made the queue stop being
   * durable in total silence -- the client went on looking exactly like one
   * that was safe. The chain still has to survive a failure, or one bad write
   * would stop every later one; what changed is that somebody is told.
   */
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = writing.then(work, work);
    writing = mine.then(
      () => nowSaying(undefined),
      (reason) => nowSaying(troubleFrom(reason)),
    );
    return mine;
  };

  const put = (store: string, value: Queued | Answer) => {
    maybeReclaim();
    void inOrder(() =>
      awaited(
        database.transaction(store, "readwrite").objectStore(store).put(value),
      ),
    );
  };

  const remove = (store: string, keys: string[]) =>
    void inOrder(async () => {
      const held = database.transaction(store, "readwrite").objectStore(store);
      await Promise.all(keys.map((key) => awaited(held.delete(key))));
    });

  const queued = await everythingIn<Queued>(database, QUEUED, workspace);
  const answers = await everythingIn<Answer>(database, ANSWERS, workspace);

  const row = (entry: Entry): Queued => ({
    key: keyed(workspace, entry.request.transaction),
    workspace,
    transaction: entry.request.transaction,
    entry,
  });

  const kept: Kept = {
    /**
     * ONE IndexedDB transaction, which is what makes it indivisible. The
     * amendment an eviction makes to the write behind it is the only thing
     * standing between that write and bytes it can no longer name, so it must
     * not be possible to observe the removal without it.
     */
    moved: ({ written = [], gone = [] }) =>
      void inOrder(async () => {
        const store = database
          .transaction(QUEUED, "readwrite")
          .objectStore(QUEUED);
        await Promise.all([
          ...written.map((entry) => awaited(store.put(row(entry)))),
          ...gone.map((one) => awaited(store.delete(keyed(workspace, one)))),
        ]);
      }),
    answered: (transactions) => {
      for (const transaction of transactions)
        put(ANSWERS, {
          key: keyed(workspace, transaction),
          workspace,
          transaction,
        });
    },
  };

  /**
   * When each digest was last stored.
   *
   * A release is decided from what the queue held when it was ASKED for, and
   * it runs later. Between the two, the same bytes can be stored again --
   * routinely, because the store is content-addressed and identical text
   * hashes to one place. Deleting them then would take bytes a live entry has
   * just claimed, and the entry that named them would come back unreadable.
   */
  let tick = 0;
  const stamped = new Map<Digest, number>();

  const held = (digest: Digest) =>
    awaited(
      database
        .transaction(BYTES, "readonly")
        .objectStore(BYTES)
        .get(keyed(workspace, digest)),
    ) as Promise<Bytes | undefined>;

  const bytes: Store = {
    /**
     * ON THE SAME CHAIN as the rows, which is what makes "the row first, then
     * the bytes" mean anything. Stored the other way round, a tab dying in
     * between leaves bytes that nothing points at -- lost, and undetectably
     * so. This way it leaves a row naming bytes that are not there, which is
     * lost and SAYS so, and `presenting` reports it and drops it.
     */
    put: async (content, at) => {
      const digest = at ?? (await digestOf(content));
      const stored =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      stamped.set(digest, (tick += 1));
      await inOrder(() =>
        awaited(
          database
            .transaction(BYTES, "readwrite")
            .objectStore(BYTES)
            .put({
              key: keyed(workspace, digest),
              workspace,
              digest,
              bytes: stored,
              at: now(),
            }),
        ),
      );
      return digest;
    },
    read: async (digest) => (await held(digest))?.bytes,
    text: async (digest) => {
      const found = await held(digest);
      return found === undefined ? undefined : asText(found.bytes);
    },
    /**
     * Checked against what is WRITTEN DOWN, not against one queue in memory.
     * Another tab on this workspace has its own queue, and its chained writes
     * are deltas against bytes this one is about to call unreferenced.
     */
    forget: (digests) => {
      const wanted = [...digests];
      const asked = (tick += 1);
      return inOrder(async () => {
        if (wanted.length === 0) return;
        const still = referenced(
          (await everythingIn<Queued>(database, QUEUED, workspace)).map(
            (row) => row.entry,
          ),
        );
        const releasable = wanted.filter(
          (digest) => !still.has(digest) && (stamped.get(digest) ?? 0) < asked,
        );
        if (releasable.length === 0) return;
        const store = database
          .transaction(BYTES, "readwrite")
          .objectStore(BYTES);
        await Promise.all(
          releasable.map((digest) =>
            awaited(store.delete(keyed(workspace, digest))),
          ),
        );
        for (const digest of releasable) stamped.delete(digest);
      });
    },
  };

  /**
   * Everything on this origin, not just this workspace.
   *
   * A sweep decides what is garbage by what NOTHING names, so it has to see
   * every row there is. Reading one workspace's rows and deleting another's
   * payloads on the strength of it is how a sweep destroys a queue.
   */
  const everywhere: Sweepable = {
    queued: async () => {
      const rows = (await awaited(
        database.transaction(QUEUED, "readonly").objectStore(QUEUED).getAll(),
      )) as Queued[];
      return rows.map((row) => ({
        workspace: row.workspace,
        entry: row.entry,
      }));
    },
    payloads: async () => {
      const rows = (await awaited(
        database.transaction(BYTES, "readonly").objectStore(BYTES).getAll(),
      )) as Bytes[];
      return rows.map((row) => ({
        workspace: row.workspace,
        digest: row.digest,
        size: row.bytes.byteLength,
        at: row.at,
      }));
    },
    drop: (of) =>
      inOrder(async () => {
        const store = database
          .transaction(BYTES, "readwrite")
          .objectStore(BYTES);
        await Promise.all(
          of.map(({ workspace: where, digest }) =>
            awaited(store.delete(keyed(where, digest))),
          ),
        );
        for (const { digest } of of) stamped.delete(digest);
      }),
  };

  let reclamation: Reclamation = { phase: "idle" };
  let sweeping: Promise<Reclamation> | undefined;

  const nowReclaiming = (state: Reclamation) => {
    reclamation = state;
    for (const changed of [...watchers]) changed();
  };

  const reclaim = (): Promise<Reclamation> =>
    (sweeping ??= (async () => {
      nowReclaiming({ phase: "sweeping" });
      try {
        return await alone(
          () => sweep(everywhere, headroom, now),
          /** Another tab has it; its answer is the one that counts. */
          reclamation,
        );
      } finally {
        sweeping = undefined;
      }
    })().then((found) => (nowReclaiming(found), found)));

  /**
   * Measured rather than waited for.
   *
   * Reacting to a store that has already refused is reacting too late: at that
   * point there may not be room to write down what a sweep decided. So the
   * counter checks occasionally -- often enough to notice a store filling up,
   * rarely enough to stay off the hot path.
   */
  let written = 0;
  const EVERY = 64;
  const maybeReclaim = () => {
    if ((written += 1) % EVERY !== 0) return;
    headroom().then((room) => {
      if (crowded(room)) reclaim();
    });
  };

  return {
    bytes,
    kept,
    faltering: () => faltering,
    watch: (changed) => (watchers.add(changed), () => watchers.delete(changed)),
    flushed: async () => {
      await writing;
    },
    reclamation: () => reclamation,
    reclaim,
    restored: {
      entries: queued.map((row) => row.entry),
      recorded: answers.map((row) => row.transaction),
    },
    waiting: async () => {
      const rows = (await awaited(
        database.transaction(QUEUED, "readonly").objectStore(QUEUED).getAll(),
      )) as Queued[];
      return [...new Set(rows.map((row) => row.workspace))];
    },
  };
};

export type OnPersistenceChange = (
  issue: Faltering | undefined,
  reclaiming: Reclamation,
) => void;

export const startPersistence = async (
  workspace: Id,
  onChange: OnPersistenceChange,
) => {
  const database = await persistenceMechanism(workspace);
  requestPersistence();
  const unwatch = database.watch(() =>
    onChange(database.faltering(), database.reclamation()),
  );
  /**
   * Once at startup, because a store that filled up during the last visit
   * is still full at the start of this one and nothing else would notice
   * until the first write failed.
   */
  database.reclaim();
  return { database, unwatch };
};
