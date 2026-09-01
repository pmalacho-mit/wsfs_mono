/**
 * What one file has said, from both sides of the wire.
 *
 * The server holds what it accepted and what it declined; this client holds
 * what it has not managed to send. Neither half is the history, and the half
 * the server cannot see is the one a user most often wants -- somebody
 * offline asking where their work went is asking about the outbox.
 *
 * So the two are merged, queued work first, and a caller never has to know
 * there were two places to look.
 */
import type { Id, Standing, Transaction, Version_ } from "./contract";
import { isWrite, type Submitted } from "./contract";
import { mintedAt } from "./minted";
import type { Entry } from "./outbox";

/**
 * One thing a file has said, wherever it is recorded.
 *
 * FOUR standings, not the server's three. Queued work has not been decided
 * yet, so none of applied, draft or refused is true of it -- and it is the
 * one kind a user can still lose, which makes calling it something it is not
 * the worst available answer.
 */
export type Told = Omit<Version_, "standing" | "size"> & {
  standing: Standing | "queued";
  /**
   * Null for queued work. The outbox holds its payload by digest and the
   * length of a delta is not the length of the file -- see the server's own
   * note on the same question.
   */
  size: number | null;
};

/**
 * A queued write, described as a version.
 *
 * `accepted` is null and says so: nobody has accepted it, and inventing a
 * time here would sort unsent work among work that landed. `minted` is real
 * -- it is when the user acted, which is the only clock an outbox has.
 */
const fromOutbox = (entry: Entry): Told | undefined => {
  const request = entry.request as Submitted;
  if (!isWrite(request)) return undefined;
  return {
    transaction: request.transaction,
    at: {
      minted: mintedAt(request.transaction)?.toISOString() ?? null,
      offset: request.offset ?? null,
      accepted: null,
    },
    standing: "queued",
    kind: "text",
    size: null,
    why: null,
  };
};

/**
 * The two halves, queued first and each newest-first within itself.
 *
 * A transaction the server has now answered is dropped from the queued half
 * rather than shown twice: the outbox is emptied by the stream, and for the
 * moment between an answer and the event that carries it the same write is
 * in both places.
 */
export const merged = (
  queued: Entry[],
  entry: Id,
  told: Version_[],
): Told[] => {
  const answered = new Set<Transaction>(told.map((one) => one.transaction));
  const mine = queued
    .filter((held) => (held.request as Submitted).id === entry)
    .map(fromOutbox)
    .filter((one): one is Told => one !== undefined)
    .filter((one) => !answered.has(one.transaction))
    .reverse();
  return [...mine, ...told.map((one): Told => ({ ...one, size: one.size ?? null }))];
};
