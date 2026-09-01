/**
 * Whether a shared document still speaks for its file.
 *
 * WHAT USED TO BE HERE, and why it is not. This module once decided what a
 * room OWED its file: a pure rule over two tokens, plus the bookkeeping a
 * client kept to work out whether a write it had just been told about was its
 * own. A client acted on that verdict by reading the file at two versions,
 * diffing them, and typing the difference into its own document.
 *
 * That is the one thing a CRDT cannot survive. Typing text in creates NEW
 * characters, so when the original author's edits arrived carrying their own
 * identity, both copies lived and the file said everything twice. Content
 * authored in a document now travels only as Yjs updates, and the server is
 * the only party that carries text into a room -- so there is no verdict for
 * a client to reach, and nothing for it to remember about whose write was
 * whose.
 *
 * One rule survived all of it, because it was never about transport.
 */

/** Where a room stands with respect to everybody else holding the file. */
export type Reach = {
  /** Whether this room is reaching the others right now. */
  attached: boolean;
  /** Whether it heard about a change while it was away and has not caught up. */
  behind: boolean;
};

/**
 * Whether this room may write the file back to the server right now.
 *
 * `behind` is the obvious half. `attached` is the half that is not obvious at
 * all, and it is the reason this exists as a rule rather than a check on one
 * flag.
 *
 * A member that has lost the room can still reach the server perfectly well,
 * and what it holds is not wrong -- it is simply not shared yet. Storing it
 * publishes one member's private state as the file, and the others are then
 * told about a write whose content is still in flight: the server carries it
 * into their documents, and this member's own copy arrives afterwards and
 * says it a second time.
 *
 * So a lapse costs the right to write around the room as well as the right to
 * be told about it. Nothing is lost by that -- the work stays in the
 * document, is kept as a draft, and is stored properly when the room comes
 * back.
 */
export const speaking = ({ attached, behind }: Reach) => attached && !behind;
