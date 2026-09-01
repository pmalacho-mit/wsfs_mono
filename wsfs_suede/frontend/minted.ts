/**
 * When something happened, out of the id it happened as -- and on whose clock.
 *
 * A UUIDv7 carries the Unix epoch MILLISECOND it was minted in its first 48
 * bits, and this client mints a transaction's id the moment the user acts. So
 * "when did this happen here" is already in the id, and the server reads it
 * back out of the primary key rather than being told it twice.
 *
 * WHAT A v7 DOES NOT CARRY IS A TIMEZONE, and that is the part worth being
 * clear about. Its timestamp is an INSTANT counted from the epoch, and an
 * instant is the same number everywhere on earth -- which is exactly the
 * property you want for ordering and storage, and exactly the wrong one for
 * "show me the time I saw on my own clock". Someone who works in Los Angeles on
 * Monday and in London on Tuesday mints ids that say nothing about which was
 * which, and rendering both in the reader's current zone moves Monday's work by
 * eight hours. So the offset travels beside the id, on the transaction, and
 * `localised` is what puts the two back together.
 */
import type { Occurrence, Transaction } from "./contract";

const MILLISECONDS_BEGIN_AT = 80n;

const V7 = "7";

const MINUTE = 60_000;

/**
 * Where a derived instant stops being sayable, and the bound is the WIRE's, not
 * this runtime's. A Date reaches the year 275760 and 48 bits of milliseconds
 * reach 10889, so JavaScript alone would happily read a broken clock's id as a
 * date in the hundred-and-eighth century -- but the server derives the same
 * number out of the same id and cannot express a year past 9999, so it would
 * answer "unknown" where this answered "10889". The client's optimistic entry
 * and the confirmed one behind it must not disagree about that, and the
 * cheapest way to guarantee it is for both to stop in the same place.
 */
const UNSAYABLE = Date.UTC(10_000, 0, 1);

/** A hex string of the whole 128 bits -- the dashes carry no information. */
const bits = (id: string) => BigInt(`0x${id.replace(/-/g, "")}`);

/**
 * The variant nibble, at index 19, whose top two bits must be `10` for an id to
 * be an RFC 4122 UUID at all -- so `8`, `9`, `a` or `b`.
 */
const RFC_4122 = new Set("89abAB");

/**
 * Both halves of the check, and the second half is not pedantry: the server
 * reads `UUID.version`, which Python reports as null unless the VARIANT is RFC
 * 4122 too. An id with a 7 in the version nibble and anything else in the
 * variant one would otherwise be a v7 here and not one there -- the same
 * disagreement between the optimistic entry and the confirmed one behind it
 * that `UNSAYABLE` exists to prevent.
 */
const isV7 = (id: string) => id[14] === V7 && RFC_4122.has(id[19] ?? "");

/**
 * The instant a UUIDv7 was minted, or undefined if it was not one.
 *
 * Undefined rather than a throw: the contract PREFERS v7 and does not require
 * it, so an id minted some other way is silence about when, not an error. It is
 * also whoever-minted-it's clock, which is worth remembering before showing it
 * next to `accepted` -- see `Occurrence`.
 */
export const mintedAt = (id: Transaction): Date | undefined => {
  if (!isV7(id)) return undefined;
  let milliseconds: number;
  try {
    milliseconds = Number(bits(id) >> MILLISECONDS_BEGIN_AT);
  } catch {
    // Shaped like a v7 in the two nibbles checked above and still not hex. The
    // server rejects such a string before it reaches its own reader; this runs
    // on the read path of every event and must not be the thing that throws.
    return undefined;
  }
  return milliseconds < UNSAYABLE ? new Date(milliseconds) : undefined;
};

/**
 * This client's minutes EAST of UTC, the sign the wire wants.
 *
 * The negative-zero check is not defensive padding: negating a zero in
 * JavaScript produces `-0`, so a client running in UTC would report a value
 * that is `0` over JSON and fails `Object.is(x, 0)` in every test and
 * comparison this side of it.
 *
 * Written as `Object.is` rather than the shorter `|| 0`, which catches the same
 * case and one more: an Invalid Date makes `getTimezoneOffset()` NaN, and NaN
 * is falsy, so `|| 0` would answer 0 -- a client claiming UTC because its clock
 * was unreadable. Wrong in a way nothing downstream could notice.
 */
export const offset = (at: Date = new Date()): number => {
  const minutes = -at.getTimezoneOffset();
  return Object.is(minutes, -0) ? 0 : minutes;
};

/** `+02:00`, `-07:00`, `Z` -- how an offset is written down. */
export const written = (minutes: number): string => {
  if (minutes === 0) return "Z";
  const pad = (value: number) => String(value).padStart(2, "0");
  const size = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
};

/**
 * A wall clock reading, in the zone the transaction was made in.
 *
 * SHIFTED INTO UTC, and read back with the UTC getters. `Date` renders in the
 * runtime's zone and nothing can talk it out of that, so the only way to show
 * another zone's clock through one is to move the instant until the runtime
 * agrees -- and the obvious move, shifting by the gap between the two zones,
 * has a hole in it. It lands the result in the RUNTIME's zone, which has DST,
 * and one hour every spring does not exist there at all: asked to render 02:30
 * on the morning the clocks go forward, a Los Angeles runtime answers 03:30,
 * because there is no instant it could mean. Shifting into UTC has no such
 * hour, because UTC has no transitions, so every wall clock in every zone is
 * representable and the answer does not depend on where the reader is sitting.
 *
 * The cost is the reading rule, and it is the whole of the contract here:
 *
 *     at.local.getUTCHours()                          // the hour they saw
 *     at.local.toLocaleString("en-GB", { timeZone: "UTC" })
 *     at.stamp                                        // or just use this
 *
 * `local` is therefore NOT the moment it came from and must never be compared
 * or sorted -- `instant` is the one that is real.
 *
 * With no offset recorded there is nothing to shift to, so the reading is in
 * the reader's own zone and `zoned` is false: a caller can say "shown in your
 * time" rather than claiming a zone nobody was in.
 */
export type Reading = {
  /** The real instant. Compare and sort with this one. */
  instant: Date;
  /** The wall clock they saw, readable through the UTC getters. Never compare. */
  local: Date;
  /** Minutes east of UTC that the reading is against. */
  offset: number;
  /** Whether that offset is the transaction's own or the reader's fallback. */
  zoned: boolean;
  /** RFC 3339 in that zone: `2026-08-19T19:30:00.000-07:00`. Unambiguous. */
  stamp: string;
};

export const reading = (instant: Date, minutes?: number | null): Reading => {
  const zoned = minutes !== undefined && minutes !== null;
  const held = zoned ? minutes : offset(instant);
  const local = new Date(instant.getTime() + held * MINUTE);
  return {
    instant,
    local,
    offset: held,
    zoned,
    stamp: `${local.toISOString().slice(0, -1)}${written(held)}`,
  };
};

/**
 * When a transaction happened on the client that made it, on that client's
 * clock -- which is the one to show a user their own history on.
 *
 * This is the boundary where wire data becomes a call to `reading`, so it is
 * where an unparseable one stops. `reading` itself stays strict: a Reading
 * built from an instant that is not one would carry NaN in every field and a
 * `stamp` that throws on the way out, and silence is only the right answer
 * for something that arrived from somewhere else.
 */
export const localised = (at: Occurrence): Reading | undefined => {
  if (at.minted == null) return undefined;
  const instant = new Date(at.minted);
  return Number.isNaN(instant.getTime()) ? undefined : reading(instant, at.offset);
};

/**
 * When the server accepted it. Always in the READER's zone: a server clock has
 * no zone anybody was standing in, and this is the half to trust when a client
 * that has been offline for a week disagrees with it.
 */
export const accepted = (at: Occurrence): Date | undefined =>
  at.accepted == null ? undefined : new Date(at.accepted);

