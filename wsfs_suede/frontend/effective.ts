/**
 * What the UI and the filesystem actually read.
 *
 *     effective = outbox.replayOver(confirmed)
 *
 * Optimistic updates are DERIVED, never applied. When a transaction is evicted
 * because its own event arrived, the confirmed change and the overlay's
 * removal cancel exactly and nothing flickers. When it is evicted by a
 * refusal, the view snaps back on its own -- undo is not an operation here,
 * it is a recomputation.
 *
 * An overlay never advances a version token: the token it presents has to stay
 * the one the SERVER has seen, or the next request would compare against a
 * value that was never issued. So the tokens cannot say who is responsible for
 * an optimistic value, and `overlaid` is what says it instead.
 */
import type { Confirmed } from "./confirmed";
import type {
  Create,
  Id,
  Metadata,
  Move,
  Occurrence,
  Rename,
  Reparent,
  Transaction,
} from "./contract";
import { mintedAt } from "./minted";
import type { Entry, Held } from "./outbox";

export type View = ReadonlyMap<Id, Metadata>;

/** The four things about an entry that can move independently. */
export type Property = "name" | "parent" | "deleted" | "content";

/**
 * Which queued transaction is responsible for each property it overlays.
 * A property absent here is showing the confirmed value, and the confirmed
 * value carries its own token.
 */
export type Overlaid = ReadonlyMap<Id, Partial<Record<Property, Transaction>>>;

export type Effective = {
  view: View;
  overlaid: Overlaid;
  /** Every transaction still waiting. A change whose author has left this set
   *  since is not taking effect -- it is being taken back. */
  queued: ReadonlySet<Transaction>;
};

/**
 * When a QUEUED transaction happened, as far as anyone can yet say.
 *
 * `accepted` is null, and that is the whole point of it being nullable: this
 * client acted, nobody has agreed yet, and a UI that wants to mark pending
 * work has the fact rather than having to consult the outbox for it. When the
 * event for this transaction arrives the overlay disappears and the confirmed
 * entry underneath carries a real `accepted` -- so the null resolves by the
 * same cancellation that makes every other optimistic change stop flickering.
 */
const pending = (request: Held): Occurrence => ({
  minted: mintedAt(request.transaction)?.toISOString() ?? null,
  offset: request.offset ?? null,
  accepted: null,
});

/**
 * What an op does, and what it does it to, in one place -- so a reader asking
 * "who set this" and a reader asking "what does it say" cannot disagree.
 *
 * Every one of them moves `modified`, `write` included -- it changes nothing
 * else about an entry, which is why it is absent from the confirmed path, and
 * it is the most ordinary reason a file's mtime moves. Only the mtime: a
 * queued write's transaction is NOT laid over `content_version`, because that
 * token is what invalidates the content cache, and the cache must not be told
 * a write landed before it did.
 */
type Overlay = {
  touches: readonly Property[];
  apply: (entry: Metadata, request: Held) => Metadata;
};

const OVERLAYS: Record<string, Overlay> = {
  rename: {
    touches: ["name"],
    apply: (entry, request) => ({ ...entry, name: (request as Rename).name }),
  },
  reparent: {
    touches: ["parent"],
    apply: (entry, request) => ({
      ...entry,
      parent: (request as Reparent).parent ?? null,
    }),
  },
  move: {
    touches: ["name", "parent"],
    apply: (entry, request) => ({
      ...entry,
      name: (request as Move).name,
      parent: (request as Move).parent ?? null,
    }),
  },
  delete: {
    touches: ["deleted"],
    apply: (entry) => ({ ...entry, deleted: true }),
  },
  write: { touches: ["content"], apply: (entry) => entry },
};

/** A create contributes an entry, so it is responsible for all of it. */
const CREATED: readonly Property[] = ["name", "parent", "deleted", "content"];

/**
 * A queued create has no confirmed entry to lay over, so it contributes one --
 * with its own transaction as every token, which is exactly what the server
 * will record if it accepts it.
 *
 * THE FIRST CLAUSE IS A PRECONDITION, not an observation. Called for an entry
 * the confirmed map already holds, this rewinds every version to the create.
 * Its one caller checks.
 */
const proposed = (request: Create): Metadata => ({
  id: request.id,
  type: request.type,
  name: request.name,
  parent: request.parent ?? null,
  name_version: request.transaction,
  parent_version: request.transaction,
  deleted_version: request.transaction,
  content_version: request.content ? request.transaction : null,
  modified: pending(request),
});

const credit = (
  overlaid: Map<Id, Partial<Record<Property, Transaction>>>,
  entry: Id,
  properties: readonly Property[],
  transaction: Transaction,
) => {
  const already = overlaid.get(entry) ?? {};
  for (const property of properties) already[property] = transaction;
  overlaid.set(entry, already);
};

export const of = (confirmed: Confirmed, queued: Entry[]): Effective => {
  const view = new Map(confirmed);
  const overlaid = new Map<Id, Partial<Record<Property, Transaction>>>();
  const waiting = new Set<Transaction>();

  for (const { request } of queued) {
    waiting.add(request.transaction);
    if (request.op === "create") {
      /**
       * Only when there is nothing to lay it over, which is the precondition
       * `proposed` is written for and did not used to check.
       *
       * A create leaves the outbox when the STREAM carries it, not when the
       * response acknowledges it, so there is a real window in which the
       * server has confirmed the create AND writes after it while the create
       * is still queued here. `proposed` sets all four of an entry's versions
       * to the create's own transaction -- right for an entry that exists
       * nowhere else, and a rewind for one the server has moved on. Laying it
       * over hid every write since, and because only the stream drains the
       * outbox it stayed hidden rather than righting itself.
       */
      if (!view.has(request.id)) {
        view.set(request.id, proposed(request));
        credit(overlaid, request.id, CREATED, request.transaction);
      }
      continue;
    }
    const entry = view.get(request.id);
    const overlay = OVERLAYS[request.op];
    if (entry === undefined || overlay === undefined) continue;
    view.set(request.id, {
      ...overlay.apply(entry, request),
      modified: pending(request),
    });
    credit(overlaid, request.id, overlay.touches, request.transaction);
  }

  return { view, overlaid, queued: waiting };
};

export const live = (view: View): Metadata[] =>
  [...view.values()].filter((entry) => !entry.deleted);
