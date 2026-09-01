/**
 * The last thing typed, written down where writing it down cannot fail.
 *
 * WHY NOT THE OUTBOX, which is the durable queue everything else uses. The
 * outbox is IndexedDB, and IndexedDB is asynchronous: a write to it is a
 * request, a callback, and a transaction that commits on a later turn of the
 * event loop. Every one of those is a place where a document being torn down
 * simply stops, and the browser makes no promise to finish any of it.
 *
 * `localStorage` is the one store in a browser that is not like that. It is
 * synchronous by specification -- `setItem` returns when the value is
 * written, not when it has been scheduled -- so it is the only one that can
 * be trusted from a `pagehide` handler, which is a function that may never
 * get a second turn.
 *
 * That is the whole reason it is here, and it is why this holds so little:
 * `localStorage` is small (a few megabytes for the whole origin), shared with
 * everything else the app keeps, and it blocks the main thread while it
 * writes. It is a last-resort note, not a filesystem. The outbox remains
 * where work lives; this is what catches the seconds the outbox cannot.
 *
 * NOTHING HERE THROWS. Storage can be full, disabled by a policy, or absent
 * in a private window, and none of those are worth failing a page over -- a
 * stash that could not be written is exactly as bad as the situation before
 * there was one.
 */
import type { Id, Version } from "./contract";

export type Stashed = {
  entry: Id;
  /**
   * The version this text was typed on top of.
   *
   * What makes the note safe to act on later. Coming back to a workspace
   * whose entry still sits at this version means nobody -- not the server,
   * not another tab, not the rescue write this was taken beside -- has
   * written since, so replaying it adds this person's typing and takes
   * nothing away. An entry that has moved on is a different question, and
   * `recovered` below is where it is asked.
   */
  basis: Version;
  text: string;
  /** When it was taken, so a note nobody ever came back for can be aged out. */
  at: number;
};

const PREFIX = "wsfs:stash:";

const keyed = (workspace: Id, entry: Id) => `${PREFIX}${workspace}:${entry}`;

/** A note older than this is not worth acting on without being asked. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

const store = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Reading the property itself throws where site data is blocked.
    return undefined;
  }
};

/** Writes the note. Synchronous, and quiet about every way it can fail. */
export const stash = (workspace: Id, one: Stashed): void => {
  try {
    store()?.setItem(keyed(workspace, one.entry), JSON.stringify(one));
  } catch {
    /* Full, forbidden, or absent. Nothing here is worth a thrown page. */
  }
};

/** Drops the note for one entry, once somebody has taken responsibility. */
export const forget = (workspace: Id, entry: Id): void => {
  try {
    store()?.removeItem(keyed(workspace, entry));
  } catch {
    /* As above. */
  }
};

/**
 * Every note left for this workspace, newest first.
 *
 * Malformed rows are dropped rather than thrown over: the only way one gets
 * here is a version of this app that wrote a different shape, and refusing to
 * open the workspace over it would turn a lost paragraph into a lost session.
 */
export const stashed = (workspace: Id): Stashed[] => {
  const held = store();
  if (!held) return [];
  const prefix = `${PREFIX}${workspace}:`;
  const found: Stashed[] = [];
  try {
    /**
     * THE KEYS FIRST, IN FULL, and only then the reading.
     *
     * `Storage` is indexed, and `removeItem` renumbers what is left -- so
     * dropping a malformed row from inside a `key(at)` loop moves every row
     * after it down one and the loop steps straight over the next. Which is
     * how a good note ended up skipped by the pass that was only supposed to
     * be tidying up after a bad one.
     */
    const keys: string[] = [];
    for (let at = 0; at < held.length; at += 1) {
      const key = held.key(at);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }

    for (const key of keys) {
      const raw = held.getItem(key);
      if (raw === null) continue;
      try {
        const one = JSON.parse(raw) as Stashed;
        if (typeof one?.entry === "string" && typeof one?.text === "string")
          found.push(one);
        else held.removeItem(key);
      } catch {
        held.removeItem(key);
      }
    }
  } catch {
    return found;
  }
  return found.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
};
