/**
 * The client half: reading a time out of an id, and showing it on the clock
 * that saw it.
 *
 * The interesting question is not "can a v7 be parsed" -- it is what a v7
 * REFUSES to tell you. Its timestamp is an instant, so it is the same number
 * wherever it was minted, and the offset that makes it readable as a wall clock
 * has to travel beside it. Most of what is below is about that.
 */
import { describe, expect, it } from "vitest";

import { mint } from "../../release/frontend/identity";
import {
  accepted,
  localised,
  mintedAt,
  offset,
  reading,
  written,
} from "../../release/frontend/minted";
import type { Occurrence } from "../../release/frontend/contract";

const BERLIN_IN_SUMMER = 120;
const LOS_ANGELES = -420;
const NEPAL = 345;

/** A v4, which is what a client that ignored the recommendation would send. */
const notAV7 = "f3a2b1c0-1234-4567-89ab-cdef01234567";

describe("the instant inside a minted id", () => {
  it("is the millisecond the client acted", () => {
    const before = Date.now();
    const at = mintedAt(mint())!;
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("orders ids the way they were minted", () => {
    const ids = Array.from({ length: 5 }, () => mint());
    const times = ids.map((id) => mintedAt(id)!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("says nothing when the id was not minted as a v7", () => {
    expect(mintedAt(notAV7)).toBeUndefined();
  });

  it("stops where the server stops, not where JavaScript stops", () => {
    // Every timestamp bit set: the year 10889. A Date holds it happily and a
    // Python datetime does not, so a client that read it would show a date the
    // confirmed record could never agree with. Both sides stop at year 9999.
    const beyond = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    expect(new Date(0xffffffffffff).getUTCFullYear()).toBe(10889); // it IS a Date
    expect(mintedAt(beyond)).toBeUndefined(); // and it is still silence
  });

  it("reads the same instant out of an id whatever zone minted it", () => {
    // The property the whole feature works around: an instant has no zone, so
    // two clients acting at once mint the same timestamp however far apart
    // their clocks read. Nothing here can tell them apart -- which is why the
    // offset is carried, and why it is carried per transaction.
    const one = mint();
    expect(mintedAt(one)!.getTime()).toBe(mintedAt(one.toUpperCase())!.getTime());
  });

  it("agrees with the server about what is not a v7 at all", () => {
    // A 7 in the version nibble is only half of it: the VARIANT nibble has to
    // read 8, 9, a or b, or the id is not an RFC 4122 UUID and the server's
    // reader (which goes through `UUID.version`) answers unknown. Reading an
    // instant out of this one here would put a `minted` on the optimistic
    // entry that the confirmed entry behind it does not have.
    expect(mintedAt("01924f8a-1b2c-7def-0123-456789abcdef")).toBeUndefined();
    expect(mintedAt("01924f8a-1b2c-7def-cdef-456789abcdef")).toBeUndefined();
    expect(mintedAt("01924f8a-1b2c-7def-89ab-456789abcdef")).toBeDefined();
  });

  it("says unknown rather than throwing on an id shaped like one", () => {
    // This runs on the read path of every event, so the failure mode for a
    // string that passes the nibble checks and is still not hex has to be
    // silence -- the server rejects such an id before its own reader sees it.
    expect(mintedAt("zzzzzzzz-zzzz-7zzz-8zzz-zzzzzzzzzzzz")).toBeUndefined();
  });
});

describe("showing a time on the clock that saw it", () => {
  const instant = new Date("2026-08-19T02:30:00Z");

  it("renders the wall clock of the recorded zone, not the reader's", () => {
    // Read with the UTC getters: the instant is shifted into UTC precisely so
    // that these numbers are the same whatever TZ the suite runs under.
    const berlin = reading(instant, BERLIN_IN_SUMMER);
    const angeles = reading(instant, LOS_ANGELES);

    expect(berlin.local.getUTCHours()).toBe(4); // 02:30Z is 04:30 in Berlin
    expect(angeles.local.getUTCHours()).toBe(19); // ...and 19:30 the day before
    expect(angeles.local.getUTCDate()).toBe(18);
  });

  it("writes the same reading down unambiguously", () => {
    expect(reading(instant, BERLIN_IN_SUMMER).stamp).toBe("2026-08-19T04:30:00.000+02:00");
    expect(reading(instant, LOS_ANGELES).stamp).toBe("2026-08-18T19:30:00.000-07:00");
    expect(reading(instant, NEPAL).stamp).toBe("2026-08-19T08:15:00.000+05:45");
    expect(reading(instant, 0).stamp).toBe("2026-08-19T02:30:00.000Z");
  });

  it("keeps the real instant untouched however it is rendered", () => {
    for (const zone of [BERLIN_IN_SUMMER, LOS_ANGELES, NEPAL, 0]) {
      expect(reading(instant, zone).instant.getTime()).toBe(instant.getTime());
    }
  });

  it("handles a zone that is not a whole number of hours", () => {
    const kathmandu = reading(instant, NEPAL);
    expect(kathmandu.local.getUTCHours()).toBe(8);
    expect(kathmandu.local.getUTCMinutes()).toBe(15);
  });

  it("is right for every hour of a year, in every zone, wherever it is read", () => {
    // A property rather than examples, because this is where the first attempt
    // was wrong. Shifting into the READER's zone instead of into UTC lands the
    // result in a zone that has DST, and the hour that spring-forward deletes
    // is then not representable at all: a Los Angeles runtime asked for 02:30
    // that morning answers 03:30, because no instant means it. UTC has no such
    // hour, and this sweep says so under any TZ the suite is run with.
    const HOUR = 60 * 60 * 1000;
    const start = Date.UTC(2026, 0, 1);
    for (const zone of [-720, LOS_ANGELES, 0, NEPAL, 780]) {
      for (let hour = 0; hour < 365 * 24; hour += 1) {
        const at = new Date(start + hour * HOUR);
        const wall = at.getTime() + zone * 60_000;
        const { local } = reading(at, zone);
        expect(local.getUTCHours() * 60 + local.getUTCMinutes()).toBe(
          Math.floor((((wall % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR)) / 60_000),
        );
      }
    }
  });

  it("falls back to the reader's zone and says so when none was recorded", () => {
    const unknown = reading(instant, null);
    expect(unknown.zoned).toBe(false);
    expect(unknown.offset).toBe(offset(instant));
    // Read the same way as any other reading, and it comes out as the clock in
    // front of whoever is looking -- which is all anybody can honestly show.
    expect(unknown.local.getUTCHours()).toBe(instant.getHours());
    expect(unknown.local.getUTCMinutes()).toBe(instant.getMinutes());
  });

  it("marks a reading as zoned when the transaction did say", () => {
    expect(reading(instant, LOS_ANGELES).zoned).toBe(true);
    expect(reading(instant, 0).zoned).toBe(true); // UTC is a zone, not an absence
  });
});

describe("an occurrence, as a client reads it", () => {
  const at: Occurrence = {
    minted: "2026-08-19T02:30:00.000Z",
    offset: LOS_ANGELES,
    accepted: "2026-08-26T09:00:00.000Z",
  };

  it("shows the client's time on the client's clock", () => {
    const local = localised(at)!;
    expect(local.local.getUTCHours()).toBe(19);
    expect(local.offset).toBe(LOS_ANGELES);
    expect(local.stamp).toBe("2026-08-18T19:30:00.000-07:00");
  });

  it("keeps the two clocks apart when an offline week separates them", () => {
    // The gap is the point: `minted` is when the user acted, `accepted` is when
    // anybody else could see it, and neither approximates the other.
    const gap = accepted(at)!.getTime() - localised(at)!.instant.getTime();
    expect(gap).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  it("has nothing to show for a transaction nobody has accepted yet", () => {
    expect(accepted({ ...at, accepted: null })).toBeUndefined();
  });

  it("has nothing to show when the id said nothing about when", () => {
    expect(localised({ ...at, minted: null })).toBeUndefined();
  });

  it("has nothing to show for a `minted` that will not parse either", () => {
    // Same standard as `mintedAt`: this is on the read path of every entry a
    // UI renders, and `reading` would build NaN into every field and then
    // throw producing `stamp`. Unreachable from this server, which is also
    // true of the hex floor in `mintedAt`.
    expect(localised({ ...at, minted: "the day before yesterday" })).toBeUndefined();
    expect(() => localised({ ...at, minted: "2026-08-19T02:30:00Z" })).not.toThrow();
  });
});

describe("an offset, written down", () => {
  it("is ISO 8601", () => {
    expect(written(BERLIN_IN_SUMMER)).toBe("+02:00");
    expect(written(LOS_ANGELES)).toBe("-07:00");
    expect(written(NEPAL)).toBe("+05:45");
    expect(written(0)).toBe("Z");
  });
});

describe("this client's own offset", () => {
  it("is minutes EAST of UTC, which is the sign the wire wants", () => {
    // getTimezoneOffset() reports the opposite sign; getting this backwards
    // would silently render every timestamp twice the offset away.
    const at = new Date();
    expect(offset(at)).toBe(at.getTimezoneOffset() === 0 ? 0 : -at.getTimezoneOffset());
  });

  it("is never negative zero", () => {
    // Negating a zero gives -0, which survives every arithmetic comparison,
    // serialises as 0, and fails Object.is against the 0 that comes back.
    expect(Object.is(offset(new Date()), -0)).toBe(false);
  });
});
