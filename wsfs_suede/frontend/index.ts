/**
 * A workspace filesystem, client side.
 *
 * One object holds the state and says what moved; three adapters read it, so
 * the tree, the editor and the kernel are looking at the same entries. What a
 * file contains WHILE somebody is typing into it is not decided here -- only
 * a consumer knows it has a buffer open, so preferring it is its rule to make.
 */
export { connect } from "./workspace";
export type { Recovery } from "./workspace";
/**
 * Whether anything typed here is still only here.
 *
 * The `beforeunload` prompt is raised by the package on its own -- see
 * `unsaved.ts` -- but a SvelteKit host navigating WITHIN the app never fires
 * that event, so it has to ask this and stop the navigation itself.
 */
export { anythingUnsaved } from "./unsaved";
export type {
  Changed,
  Creating,
  Options,
  Submitting,
  Workspace,
} from "./workspace";

/** What a `watch` listener is handed: one entry, one thing about it, and who. */
export type { Change, Watching } from "./changes";

/** The tutor's half of the wire, for a panel that draws a conversation. */
export type {
  Answering,
  Asked,
  Asking,
  Attached,
  Attaching,
  Id,
  Transcript,
  Turn,
} from "./contract";

export { http } from "./transport";
export type { Authorized, Transport } from "./transport";

export { mint, session } from "./identity";
export {
  mintedAt,
  localised,
  accepted,
  offset,
  reading,
  written,
} from "./minted";
export type { Reading } from "./minted";
export { inMemory } from "./bytes";

/**
 * The queue, across page loads and across workspaces.
 *
 * `keeping` is awaited once before `connect`, and what it hands back is the
 * three things a durable outbox needs: where payloads live, where the queue is
 * written down, and what was there last time.
 */
export {
  evictable,
  persistenceMechanism,
  requestPersistence,
  startPersistence,
  type OnPersistenceChange,
} from "./indexed";

/**
 * Making room for work that has not been sent, and the verdict when there is
 * none to make. `Reclamation` is what a consumer renders; the rest is here
 * because the rule for what may be discarded is worth being able to test.
 */
export { CROWDED, crowded, headroom } from "./reclaim";
export type { Headroom, Reclamation } from "./reclaim";
export type { Persistence as Keeping } from "./indexed";
export { nothing, nowhere, remembering } from "./kept";
export type { Faltering, Kept, Restored } from "./kept";
export type { Unreadable } from "./outbox";

/**
 * Text diffing, as the outbox uses it to store a chained write as an edit
 * script rather than another copy of the file -- and as a consumer holding a
 * CRDT document needs it, to turn "the file now says this" into the smallest
 * set of edits that makes it say that.
 */
export { deltaBetween, applyDelta, invertDelta, editsFor } from "./delta";
export type { Delta, Operation, Edit } from "./delta";
export type { Digest, Store } from "./bytes";

export type { Payload as Held } from "./content";
export type { Path, Index } from "./paths";
export type { View } from "./effective";

export * as contract from "./contract";
export { DEFAULTS as timing } from "./loop";
export type { Timing } from "./loop";

/**
 * Whether a shared document still speaks for the file underneath it. No CRDT
 * is named here -- the rule is small, easy to get subtly wrong, and worth
 * being able to test without a network.
 */
export * as rooms from "./rooms";
export type { Reach } from "./rooms";

export { provider } from "./adapters/files";
export type { FileProvider } from "./adapters/files";
export { filesystem } from "./adapters/kernel";
export type { FileOverride } from "./adapters";
/**
 * Per-key debouncing, for a consumer that holds an open buffer and decides
 * when it becomes a write. This client no longer has an opinion about that.
 */
export { MappedDebouncer } from "./debounce";

export { createClient } from "@liveblocks/client";
