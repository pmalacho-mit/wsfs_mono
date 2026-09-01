/**
 * Every id this client sends, it mints.
 *
 * UUIDv7, from `uuid` -- the package rather than a hand-rolled one, for two
 * reasons that are not "it is fewer lines".
 *
 * It is monotonic WITHIN a millisecond. A hand-rolled v7 re-randomises the
 * tail on every call, so two ids minted in the same tick have no order between
 * them; `uuid` carries a sequence counter, so a queue read back in id order is
 * the order it was written. That is a property this client leans on rather
 * than a nicety.
 *
 * And it needs only `crypto.getRandomValues`, not `crypto.randomUUID`. The
 * latter is the one that breaks on older browsers and in every non-secure
 * context; the former has been there since IE11.
 */
import { v7 } from "uuid";

export const mint = v7;

/**
 * A page load's identity, stamped on outbox entries and drafts. An entry
 * carrying this session already produced an optimistic change on screen; one
 * carrying an older session survived a reload and certainly did not.
 */
export const session = mint();
