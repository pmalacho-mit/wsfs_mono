/**
 * What a shared document is, to this package -- and nothing about how one is
 * drawn.
 *
 * A room is one file's Yjs document, and joining one is a protocol rather than
 * a widget: which provider, where the document is kept between visits, when
 * this client may write the file back, and what to say when it may not. All of
 * that is filesystem behaviour, so it is declared here and implemented by
 * whoever is rendering.
 *
 * NO VENDOR IS NAMED. `Provider` is five members chosen because they are what
 * the protocol asks, not because a client library has them; a y-websocket
 * provider and a hosted one satisfy it equally. Yjs itself IS named, because
 * text carried into a document is what a room holds -- see the note in
 * `rooms.ts` about which half of this is a rule and which is a vendor.
 */
import type * as Y from "yjs";

import { deltaBetween, editsFor } from "./delta";
import type * as contract from "./contract";

/** What a room needs a provider to be able to do. */
export type Provider = {
  readonly synced: boolean;
  once: (event: "synced", handler: () => void) => void;
  /** Calls back whenever `ahead` may have changed. Returns an unsubscribe. */
  watch: (changed: () => void) => () => void;
  /**
   * Whether this client is holding changes the server has not confirmed.
   *
   * The `ahead` of `SCENARIOS.md`, and the question a store turns on. Being
   * BEHIND -- missing somebody else's typing -- is harmless and is not this.
   */
  ahead: () => boolean;
  /** Settles once nothing this client holds is still on its way. */
  handedOver: () => Promise<void>;
  destroy: () => void;
};

/**
 * Joining the shared document for one entry.
 *
 * The DOCUMENT IS THE ROOM'S, and is handed in rather than taken from the
 * provider. A room outlives its providers -- that is what makes a network
 * lapse survivable -- so a document owned by the provider would be thrown away
 * with it, taking everything typed during the lapse.
 */
export type Enter = (
  entry: string,
  doc: Y.Doc,
) => { provider: Provider; leave: () => void };

/** What a room asks of the host that keeps it. */
export type Host = {
  /**
   * Make this entry's room exist and say what the file says, and answer where
   * it now stands.
   *
   * Where it stands is the host's to keep, not the document's: in the
   * document, advancing it is a write, so one person saving would cost a
   * round trip to the collaboration server for every client that heard.
   */
  bringRoomUpToFile: (entry: string) => Promise<string | null>;

  /** A member of this room wrote the file, so the room already holds the text. */
  stored: (entry: string, version: string) => Promise<void>;

  /**
   * Put this client's own update into the room for it.
   *
   * The one thing a client cannot do for itself when it can reach the host
   * and not the collaboration server, and losing that connection should cost
   * the direct route to everybody else rather than everybody else.
   */
  handOver: (entry: string, update: Uint8Array) => Promise<void>;
};

/**
 * Keeping this document on THIS MACHINE, so a tab closing does not lose it.
 *
 * The rung below the room. Work reaches here the moment it is typed, before
 * anybody else could possibly have it, and it is what makes a crash survivable
 * -- see `SCENARIOS.md`, E2 and E3.
 */
export type Persist = (
  entry: string,
  doc: Y.Doc,
) => { loaded: Promise<void>; stop: () => Promise<void> };

/**
 * Why a room is not writing its file back, when it is not.
 *
 * One statement of the rule, read by the thing that decides and by the thing
 * that tells the person -- the decision and its explanation drifting apart is
 * how a user ends up looking at a banner that is no longer true.
 */
export type Trouble = {
  /** What to tell the person at the keyboard. */
  message: string;
  /**
   * Whether this passes on its own.
   *
   * True for everything that is a connection: the work is kept, and it
   * becomes the file when the room comes back. False when the file stopped
   * being this room's text, which nothing here undoes.
   */
  passing: boolean;
};

/** What ended a room that was showing text. */
export type Replacement = {
  entry: string;
  at: contract.Version;
  /** The mime the file became, or `null` when it was deleted instead. */
  mime: string | null;
  /** Where the text it was showing went, so that it is not lost with the room. */
  savedAs: contract.Transaction | null;
};

/**
 * Why a room out of touch did not write the file back, and where the work went.
 *
 * Held from the FILE, not from the server: the text is recorded as a draft, so
 * it is durable and recoverable the moment it is typed. Nothing is waiting to
 * be retried.
 */
export type Withheld = {
  withheld: true;
  why: string;
  /** The draft the text went into, or `null` when there was no text to keep. */
  draft: contract.Transaction | null;
  /**
   * The draft reaching the server, for a caller that needs it to have.
   *
   * Named alongside the transaction rather than awaited before returning it,
   * because `send` answers synchronously -- a caller describing what the user
   * is looking at needs the id at the moment it asks. `store` waits.
   */
  response: Promise<contract.Response> | null;
};

/**
 * A write on its way, named before it is answered.
 *
 * The transaction is known SYNCHRONOUSLY, because a caller describing what the
 * user is looking at needs it at the moment it asks -- waiting on the answer
 * would describe a later moment than the one it was asked about.
 */
export type Sending =
  | Withheld
  | {
      withheld: false;
      transaction: contract.Transaction;
      response: Promise<contract.Response>;
    };

/** The same write, once the server has ruled on it. */
export type Written =
  | Withheld
  | { withheld: false; transaction: contract.Transaction; rejected: boolean };

const CONTENT = "content";

/** Where a room's text lives inside its document, and the only place it does. */
export const contentKey = CONTENT;

/**
 * Make a shared text say `next`, changing as little as possible.
 *
 * Never a replacement. The positions a CRDT hands out are what let two people
 * type in one paragraph at once, and clearing the text throws every one of
 * them away -- so a "replace" between two clients is how one of them silently
 * undoes the other.
 */
export const become = (text: Y.Text, next: string) => {
  const edits = editsFor(deltaBetween(text.toString(), next));
  if (edits.length === 0) return;
  (text.doc as Y.Doc).transact(() => {
    for (const edit of edits) {
      if ("insert" in edit) text.insert(edit.at, edit.insert);
      else text.delete(edit.at, edit.remove);
    }
  });
};
