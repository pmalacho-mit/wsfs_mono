/**
 * A wsfs server, in process, with a switch on the wire.
 *
 * The suite had no way to make a server say anything. Two things went untested
 * because of it: what the client does when a token it presents was never
 * issued (invariant 6 -- the server's half was covered and the client's was
 * not), and what a client does when it can reach the collaboration server but
 * not this one. Both are about the WIRE, so a fake document or a fake room
 * could never have reached them.
 *
 * It adjudicates for real. A write lands only if the token it presents is the
 * one that is current, a create mints its own versions, a draft is recorded
 * and changes nothing -- because a lenient fake would prove that the client
 * works against a server nobody is going to run.
 */
import type { Payload } from "../../release/frontend/content";
import { UNSOUND, type Id, type Metadata, type Response, type Seen, type Snapshot, type StreamEvent, type Submitted, type Transaction, type Version } from "../../release/frontend/contract";
import type { Reading, Subscription, Transport } from "../../release/frontend/transport";

export type Fake = Transport & {
  /** Whether anything can reach this server at all. */
  reachable: (now: boolean) => void;
  /** How many times a client has thrown its state away and started again. */
  initializes: () => number;
  submitted: () => Submitted[];
  entries: () => Metadata[];
  text: (entry: Id) => string | undefined;
  drafts: () => Transaction[];
  cleared: (workspace: Id, transactions: Transaction[]) => Promise<void>;
  /** Everything the server has been told, drafts included, in order. */
  answered: () => Transaction[];
  /** Snapshots and executions kept, in order. */
  recorded: () => Transaction[];
  /**
   * Stop admitting to having issued this version.
   *
   * What a client holding a token from a server that was rolled back, or
   * restored, or served by a different deployment is holding: a version that
   * looks current to it and that this server has no record of minting.
   */
  disown: (version: Version) => void;
  /**
   * Hold the stream, so a write can land that this client has not heard about.
   *
   * The state every conflict is actually reached from: somebody else moved the
   * file on, and the token you are holding was current when you read it.
   */
  silence: () => void;
  release: () => void;
};

class Unreachable extends Error {
  constructor() {
    super("the server cannot be reached");
  }
}

const now = () => ({ at: new Date().toISOString(), offset: null });

const conflict = (version: Version | null): Response => ({
  rejected: true,
  reason: "the version presented is not the current one",
  version,
});

const unsound = (): Response => ({ rejected: true, reason: UNSOUND });

export const server = (): Fake => {
  const held = new Map<Id, Metadata>();
  const content = new Map<Id, string>();
  const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  const versions = new Map<Id, Map<Version, string>>();
  const issued = new Set<Transaction>();
  const drafted: Transaction[] = [];
  /** Snapshots and executions, which change nothing and are simply kept. */
  const recorded: Transaction[] = [];
  const told: Transaction[] = [];
  const seen: Submitted[] = [];
  const listeners = new Set<(event: StreamEvent) => void>();

  let reaching = true;
  let started = 0;
  let quiet = false;
  const withheld: StreamEvent[] = [];

  const reach = () => {
    if (!reaching) throw new Unreachable();
  };

  const announce = (event: StreamEvent) => {
    if (quiet) return void withheld.push(event);
    for (const listener of [...listeners]) listener(event);
  };

  const remember = (entry: Id, version: Version, text: string) => {
    const kept = versions.get(entry) ?? new Map<Version, string>();
    kept.set(version, text);
    versions.set(entry, kept);
  };

  /**
   * A token this server never minted means the client is reasoning about a
   * state that never existed. Told apart from an ordinary conflict, because
   * the client's answer to the two is different: rebase, or start again.
   */
  const judged = (presented: Version | null, current: Version | null): Response | undefined => {
    if (presented === current) return undefined;
    if (presented !== null && !issued.has(presented)) return unsound();
    return conflict(current);
  };

  const stale = (request: Submitted, entry: Metadata): Response | undefined => {
    if (request.op === "write")
      return judged(request.content_version ?? null, entry.content_version ?? null);
    if (request.op === "move")
      return (
        judged(request.name_version, entry.name_version) ??
        judged(request.parent_version, entry.parent_version)
      );
    if (request.op === "delete") {
      const asked = request.seen as Seen;
      return (
        judged(asked.name_version, entry.name_version) ??
        judged(asked.parent_version, entry.parent_version) ??
        judged(asked.deleted_version, entry.deleted_version) ??
        judged(asked.content_version ?? null, entry.content_version ?? null)
      );
    }
    return undefined;
  };

  const textOf = (body: unknown): string =>
    (body as { type: string; content?: string }).type === "text"
      ? ((body as { content: string }).content ?? "")
      : "";

  const created = (request: Submitted): Response => {
    const transaction = request.transaction;
    const entry: Metadata = {
      id: request.id,
      type: (request as { type: "file" | "folder" }).type,
      name: (request as { name: string }).name,
      parent: (request as { parent: Id | null }).parent,
      deleted: false,
      name_version: transaction,
      parent_version: transaction,
      deleted_version: transaction,
      content_version: (request as { content: unknown }).content === null ? null : transaction,
      modified: now(),
    } as Metadata;
    held.set(entry.id, entry);
    if (entry.content_version !== null) {
      const text = textOf((request as { content: unknown }).content);
      content.set(entry.id, text);
      remember(entry.id, transaction, text);
    }
    issued.add(transaction);
    announce({ type: "create", id: entry.id, transaction, value: entry, user: null, at: now() } as StreamEvent);
    return { rejected: false };
  };

  const adjudicate = (request: Submitted): Response => {
    seen.push(request);
    told.push(request.transaction);
    if (issued.has(request.transaction)) return { rejected: false };
    if (request.op === "create") return created(request);

    /**
     * Recorded and nothing else. Neither changes an entry, so neither takes a
     * version, writes an event, or can lose a compare-and-swap -- and a fake
     * that fell through to the mutation branch would answer a snapshot by
     * deleting the file it named.
     */
    if (request.op === "snapshot" || request.op === "execute") {
      recorded.push(request.transaction);
      return { rejected: false };
    }

    const entry = held.get(request.id);
    if (entry === undefined)
      return { rejected: true, reason: "no such entry", version: null };

    const refusal = stale(request, entry);
    if (refusal !== undefined) return refusal;

    /**
     * A draft is recorded and nothing moves: no version is issued, no event
     * follows, and the token it presented is still the current one -- so the
     * write that eventually shares the work presents the very same token.
     */
    if (request.op === "write" && (request as { draft?: boolean }).draft === true) {
      drafted.push(request.transaction);
      remember(request.id, request.transaction, textOf((request as { content: unknown }).content));
      return { rejected: false, draft: true };
    }

    const transaction = request.transaction;
    issued.add(transaction);
    const moved = { ...entry, modified: now() } as Metadata;
    if (request.op === "write") {
      const text = textOf((request as { content: unknown }).content);
      content.set(entry.id, text);
      remember(entry.id, transaction, text);
      moved.content_version = transaction;
      held.set(entry.id, moved);
      announce({ type: "write", id: entry.id, transaction, value: transaction, user: null, at: now() } as StreamEvent);
    } else if (request.op === "move") {
      moved.name = (request as { name: string }).name;
      moved.parent = (request as { parent: Id | null }).parent;
      moved.name_version = transaction;
      moved.parent_version = transaction;
      held.set(entry.id, moved);
      announce({ type: "move", id: entry.id, transaction, value: { name: moved.name, parent: moved.parent }, user: null, at: now() } as StreamEvent);
    } else {
      moved.deleted = true;
      moved.deleted_version = transaction;
      held.set(entry.id, moved);
      announce({ type: "delete", id: entry.id, transaction, value: true, user: null, at: now() } as StreamEvent);
    }
    return { rejected: false };
  };

  return {
    reachable: (value) => (reaching = value),
    disown: (version) => issued.delete(version),
    silence: () => (quiet = true),
    release: () => {
      quiet = false;
      while (withheld.length > 0) announce(withheld.shift()!);
    },
    initializes: () => started,
    submitted: () => [...seen],
    entries: () => [...held.values()],
    text: (entry) => content.get(entry),
    drafts: () => [...drafted],
    answered: () => [...told],
    recorded: () => [...recorded],

    initialize: async (_workspace, replayed) => {
      reach();
      started += 1;
      const applied: Transaction[] = [];
      const rejected: Snapshot["rejected"] = [];
      for (const request of replayed) {
        const answer = adjudicate(request);
        if (answer.rejected)
          rejected.push({ transaction: request.transaction, reason: answer.reason, version: answer.version ?? null });
        else applied.push(request.transaction);
      }
      return {
        token: `token-${started}`,
        entries: [...held.values()],
        applied,
        rejected,
      };
    },

    submit: async (_workspace, request) => {
      reach();
      return adjudicate(request);
    },

    content: async (_workspace, entry, version) => {
      reach();
      const text = version === undefined ? content.get(entry) : versions.get(entry)?.get(version);
      const blob = blobs.get(text ?? "");
      if (blob !== undefined) return { kind: "binary", bytes: blob.bytes, mime: blob.mime } as Payload;
      return { kind: "text", text: text ?? "" } as Payload;
    },

    store: async (_workspace, digest, bytes, mime) => {
      reach();
      blobs.set(digest, { bytes, mime });
    },

    cleared: async () => {
      reach();
    },

    follow: (_workspace, _token, reading: Reading): Subscription => {
      const listener = (event: StreamEvent) => (reading.alive(), reading.event(event));
      listeners.add(listener);
      return { close: () => listeners.delete(listener) };
    },
  };
};
