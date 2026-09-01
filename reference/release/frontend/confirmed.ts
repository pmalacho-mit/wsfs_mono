/**
 * This client's replica of server truth.
 *
 * ONE DOOR: it is mutated by an Initialize snapshot (replace-all) and by
 * stream events, and by nothing else. A response to a request never touches it
 * -- responses adjudicate the outbox. That is what makes the ordering question
 * disappear: a response and its event may arrive in either order, because only
 * one of them carries state.
 */
import type { Id, Metadata, StreamEvent } from "./contract";

export type Confirmed = ReadonlyMap<Id, Metadata>;

type Applied = (entry: Metadata, event: StreamEvent) => Metadata;

const named: Applied = (entry, { transaction, value }) => ({
  ...entry,
  name: value as string,
  name_version: transaction,
});

const reparented: Applied = (entry, { transaction, value }) => ({
  ...entry,
  parent: (value as string | null) ?? null,
  parent_version: transaction,
});

const moved: Applied = (entry, { transaction, value }) => {
  const { name, parent } = value as { name: string; parent?: string | null };
  return {
    ...entry,
    name,
    parent: parent ?? null,
    name_version: transaction,
    parent_version: transaction,
  };
};

const deleted: Applied = (entry, { transaction, value }) => ({
  ...entry,
  deleted: value as boolean,
  deleted_version: transaction,
});

/**
 * A write says only that content changed. It carries no payload by design, so
 * what it advances is the token -- and the token is what invalidates a cache.
 */
const written: Applied = (entry, { transaction }) => ({
  ...entry,
  content_version: transaction,
});

const CHANGES: Record<Exclude<StreamEvent["type"], "create">, Applied> = {
  name: named,
  parent: reparented,
  move: moved,
  delete: deleted,
  write: written,
};

const born = (event: StreamEvent) => event.value as Metadata;

/**
 * The map after one event. Nothing is mutated: a caller holding the previous
 * map still sees what it saw, which is what lets a render compare the two.
 */
export const applied = (map: Confirmed, event: StreamEvent): Confirmed => {
  const next = new Map(map);
  if (event.type === "create") return next.set(event.id, born(event)), next;
  const entry = next.get(event.id);
  if (entry === undefined) return map; // an entry this client never saw created
  return next.set(event.id, CHANGES[event.type](entry, event)), next;
};

/** Replace-all. A snapshot is the whole truth, tombstones included. */
export const snapshot = (entries: Metadata[]): Confirmed =>
  new Map(entries.map((entry) => [entry.id, entry]));

export const empty = (): Confirmed => new Map();
