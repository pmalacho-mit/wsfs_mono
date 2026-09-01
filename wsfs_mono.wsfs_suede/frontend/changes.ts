/**
 * What moved, and who moved it.
 *
 * `watch` used to say only that SOMETHING had changed, which left every
 * consumer to work out what -- and the only general way to do that is to
 * re-derive the whole view and compare it, which is what a file tree resetting
 * itself on every keystroke actually is.
 *
 * A change names one entry, one thing about it, and the transaction
 * responsible for what it says now. That last part is what lets a consumer
 * recognise its own work: it minted the transaction, so a change carrying it
 * is one it has already made and need not make again.
 *
 * Changes are DERIVED, by comparing the effective view before and after --
 * never emitted from the request or the event that caused them. Two
 * consequences fall out of that and both are wanted:
 *
 *   - a stream event that merely confirms this client's own queued work
 *     announces NOTHING, because the overlay's removal and the confirmed
 *     value cancel exactly;
 *   - a refusal announces the change that takes it back, without anybody
 *     having to model undo.
 */
import type { Id, Metadata, Transaction } from "./contract";
import type { Effective, Overlaid, Property } from "./effective";

/** What every change carries, whatever kind it is. */
type Attributed = {
  entry: Id;
  /** The transaction responsible for what this says now. */
  by: Transaction;
  /**
   * Set when a queued transaction is being TAKEN BACK rather than taking
   * effect: the server refused it, and the view snapped back on its own.
   *
   * A consumer skips its own work taking effect, because it has already done
   * it. It must never skip the undoing of that work, which it did not do and
   * did not ask for -- and `by` alone cannot tell the two apart, because the
   * value a refusal restores can perfectly well be one this client asserted
   * earlier and is still waiting on.
   */
  retracting?: Transaction;
};

export type Change = Attributed &
  (
    /**
     * An entry this client had never seen. `now.deleted` may be set: a
     * snapshot carries tombstones, and a consumer that only draws live
     * entries skips those rather than adding and removing them.
     */
    | { kind: "appeared"; now: Metadata }
    /** An entry that stopped existing rather than being deleted. */
    | { kind: "vanished"; was: Metadata }
    | { kind: "renamed"; from: string; to: string }
    | { kind: "reparented"; from: Id | null; to: Id | null }
    | { kind: "removed" }
    | { kind: "restored" }
    /** The content token moved. What it moved TO is read, never carried. */
    | { kind: "written" }
    /**
     * The server agreed to something this client had only proposed.
     *
     * Nothing else says so. Confirming your own work changes no value a
     * reader can see -- that is the whole point of the overlay and the
     * confirmation cancelling -- but `modified.accepted` stops being null at
     * exactly this moment, and anything marking work as pending has to hear
     * about it to stop.
     */
    | { kind: "accepted" }
  );

export type Watching = (changes: readonly Change[]) => void;

/** The token each property carries when it is showing a confirmed value. */
const TOKENS = {
  name: "name_version",
  parent: "parent_version",
  deleted: "deleted_version",
  content: "content_version",
} as const satisfies Record<Property, keyof Metadata>;

/**
 * The transaction responsible for what a property currently says: the queued
 * one if an overlay is showing, and the property's own token otherwise.
 */
const responsible = (
  entry: Metadata,
  overlaid: Overlaid,
  property: Property,
): Transaction | null =>
  overlaid.get(entry.id)?.[property] ?? entry[TOKENS[property]] ?? null;

/**
 * What a property SAYS -- which is not always its value.
 *
 * For a name, a parent and a tombstone it is the value, with the wire's
 * optionality flattened: an absent parent and a null one are the same root,
 * and an absent tombstone is alive. Comparing the raw fields would announce a
 * change every time the server spelled the same fact differently.
 *
 * For content it is the transaction that wrote it, because that is all the
 * metadata holds -- a write advances a token and nothing else, and an overlay
 * cannot advance that token without presenting the server one it never issued.
 */
const says = (
  property: Property,
  entry: Metadata,
  overlaid: Overlaid,
): string | boolean | null =>
  property === "name"
    ? entry.name
    : property === "parent"
      ? (entry.parent ?? null)
      : property === "deleted"
        ? entry.deleted === true
        : responsible(entry, overlaid, "content");

const differ = (
  property: Property,
  before: Effective,
  after: Effective,
  was: Metadata,
  now: Metadata,
) => says(property, was, before.overlaid) !== says(property, now, after.overlaid);

/**
 * Whether the transaction that was speaking for this has since left the queue
 * WITHOUT its value surviving -- which is a refusal, and the only case where a
 * consumer has to act on a transaction of its own.
 */
const retraction = (
  property: Property,
  before: Effective,
  after: Effective,
  was: Metadata,
): Transaction | undefined => {
  const spoke = responsible(was, before.overlaid, property);
  if (spoke === null) return undefined;
  return before.queued.has(spoke) && !after.queued.has(spoke) ? spoke : undefined;
};

const changed = (
  before: Effective,
  after: Effective,
  was: Metadata,
  now: Metadata,
): Change[] => {
  const changes: Change[] = [];

  const attribution = (property: Property) => ({
    entry: now.id,
    by: responsible(now, after.overlaid, property)!,
    ...(retraction(property, before, after, was) === undefined
      ? {}
      : { retracting: retraction(property, before, after, was) }),
  });

  if (differ("name", before, after, was, now))
    changes.push({ ...attribution("name"), kind: "renamed", from: was.name, to: now.name });

  if (differ("parent", before, after, was, now))
    changes.push({
      ...attribution("parent"),
      kind: "reparented",
      from: was.parent ?? null,
      to: now.parent ?? null,
    });

  if (differ("deleted", before, after, was, now))
    changes.push({
      ...attribution("deleted"),
      kind: now.deleted === true ? "removed" : "restored",
    });

  // A folder has no content token at all, so it never moves.
  if (now.content_version != null && differ("content", before, after, was, now))
    changes.push({ ...attribution("content"), kind: "written" });

  return changes;
};

/**
 * Every change between two effective views, in an order a consumer can apply
 * one at a time: departures first, so a name a departing entry held is free
 * before an arriving one asks for it.
 */
export const between = (before: Effective, after: Effective): Change[] => {
  const gone: Change[] = [];
  const arrived: Change[] = [];
  const altered: Change[] = [];

  for (const [entry, was] of before.view) {
    if (after.view.has(entry)) continue;
    const by = responsible(was, before.overlaid, "name")!;
    const retracting = before.queued.has(by) && !after.queued.has(by) ? by : undefined;
    gone.push({ entry, by, ...(retracting ? { retracting } : {}), kind: "vanished", was });
  }

  for (const [entry, now] of after.view) {
    const was = before.view.get(entry);
    if (was === undefined) {
      arrived.push({
        entry,
        by: responsible(now, after.overlaid, "name")!,
        kind: "appeared",
        now,
      });
      continue;
    }
    altered.push(...changed(before, after, was, now));
  }

  return [...gone, ...arrived, ...altered, ...accepted(before, after, [
    ...gone,
    ...arrived,
    ...altered,
  ])];
};

/**
 * Every queued transaction that has left the outbox with its value intact.
 *
 * Leaving is either an acceptance or a refusal, and a refusal has already
 * said so: it is the `retracting` on the change that took it back. What is
 * left over landed.
 *
 * A refusal that happened to change nothing a reader can see would be counted
 * here as an acceptance. It takes a transaction whose value was already the
 * confirmed one, which is a request that asked for nothing.
 */
const accepted = (
  before: Effective,
  after: Effective,
  said: readonly Change[],
): Change[] => {
  const takenBack = new Set(
    said.map((change) => change.retracting).filter((by) => by !== undefined),
  );
  const landed: Change[] = [];

  for (const [entry, properties] of before.overlaid) {
    for (const by of new Set(Object.values(properties))) {
      if (by === undefined || after.queued.has(by) || takenBack.has(by)) continue;
      landed.push({ kind: "accepted", entry, by });
    }
  }
  return landed;
};
