/**
 * The post-episode window's rich record: what is kept, and what is not.
 *
 * The clock is handed in for the same reason it is in `stuck.test.ts` -- a
 * ten-minute window is a ten-millisecond test -- and the flush is a function
 * the test holds, so "what got sent" is a list rather than a network.
 */
import { describe, expect, it } from "vitest";
import {
  Activity,
  type Batch,
} from "../../release/frontend/svelte/assistant/activity";

const rigged = (over: { every?: number; cap?: number; limit?: number } = {}) => {
  let at = 0;
  const sent: Batch[] = [];
  const closing: boolean[] = [];
  let answer: () => void = () => {};
  let hold = false;
  const activity = new Activity({
    now: () => at,
    every: 100,
    ...over,
    flush: (batch, isClosing) => {
      sent.push({ episode: batch.episode, moments: [...batch.moments] });
      closing.push(isClosing);
      return hold
        ? new Promise<void>((done) => (answer = done))
        : Promise.resolve();
    },
  });
  return {
    activity,
    sent,
    closing,
    /** Make the next flush hang, as a slow network does. */
    stall: () => (hold = true),
    release: () => (hold = false, answer()),
    /** The clock alone, WITHOUT the sweep -- the gap a real tick leaves. */
    advance: (by: number) => (at += by),
    wind: (by: number) => {
      at += by;
      activity.check();
    },
    at: () => at,
  };
};

const kinds = (sent: Batch[]) => sent.flatMap((one) => one.moments.map((m) => m.kind));

describe("what is recorded, and when", () => {
  it("records nothing until an episode opens a window", () => {
    const held = rigged();
    held.activity.note("edit", { inserted: "x" });
    held.wind(1000);
    expect(held.sent, "nobody was being observed").toHaveLength(0);
    expect(held.activity.recording).toBeUndefined();
  });

  it("records once a window is open, and stamps when each thing happened", () => {
    const held = rigged();
    held.activity.open("an-episode", 1000);
    held.activity.note("edit", { inserted: "x" });
    held.wind(40);
    held.activity.note("ran", { ok: false });

    held.wind(100);
    expect(held.sent).toHaveLength(1);
    expect(held.sent[0]!.episode).toBe("an-episode");
    expect(held.sent[0]!.moments.map((one) => [one.kind, one.at])).toEqual([
      ["edit", 0],
      ["ran", 40],
    ]);
  });

  it("keeps the recorder's timestamp when a payload carries its own `at`", () => {
    /** An edit's `at` is an offset into a document. If it could overwrite the
     *  moment it happened at, the whole window would be unreadable. */
    const held = rigged();
    held.activity.open("an-episode", 1000);
    held.wind(30);
    held.activity.note("edit", { at: 512, kind: "not this either" });
    held.wind(100);
    expect(held.sent[0]!.moments[0]).toMatchObject({ at: 30, kind: "edit" });
  });

  it("stops recording when the window is up, and sends the rest", () => {
    const held = rigged();
    held.activity.open("an-episode", 200);
    held.activity.note("edit");
    held.wind(250);

    expect(held.activity.recording, "the window closed itself").toBeUndefined();
    expect(kinds(held.sent)).toEqual(["edit"]);
    expect(held.closing.at(-1), "and said it was the last of them").toBe(true);

    held.activity.note("edit");
    held.wind(250);
    expect(held.sent, "nothing after a window is its business").toHaveLength(1);
  });

  it("takes over from a window whose time is up, rather than being turned away", async () => {
    /**
     * The caller's tick asks the stuck rules BEFORE it sweeps up expired
     * windows, so a detection can land in the gap between a window ending and
     * being closed. Turned away there, the server is told a window opened and
     * nothing is ever recorded in it -- which reads back as a student who sat
     * still for ten minutes.
     */
    const { activity, sent, advance } = rigged();
    activity.open("first", 100);
    activity.note("typed");

    advance(100);
    expect(activity.recording, "still here, not yet swept up").toBe("first");

    activity.open("second", 200);
    expect(activity.recording).toBe("second");
    expect(sent.at(-1)?.episode, "and the first one's moments went").toBe(
      "first",
    );

    /** One request at a time, so the handover's flush has to land before the
     *  next one can go -- which on a real network it does, long before the
     *  window it belongs to is over. */
    await Promise.resolve();

    activity.note("typed again");
    activity.close();
    expect(sent.at(-1)).toEqual({
      episode: "second",
      moments: [{ at: 100, kind: "typed again" }],
    });
  });

  it("does not open a second window inside the first", () => {
    /** "Overlapping post-episode windows are not created", said in the one
     *  place that would otherwise create one. */
    const held = rigged();
    held.activity.open("first", 1000);
    held.activity.open("second", 5000);
    held.activity.note("edit");
    held.wind(100);

    expect(held.sent[0]!.episode).toBe("first");
    held.wind(1000);
    expect(held.activity.recording, "and it ends when the FIRST does").toBeUndefined();
  });
});

describe("how it is sent", () => {
  it("batches rather than sending a request per keystroke", () => {
    const held = rigged();
    held.activity.open("an-episode", 10_000);
    for (let index = 0; index < 20; index += 1) {
      held.activity.note("edit", { index });
      held.wind(1);
    }
    expect(held.sent, "nothing yet -- the interval has not passed").toHaveLength(0);
    held.wind(100);
    expect(held.sent).toHaveLength(1);
    expect(held.sent[0]!.moments).toHaveLength(20);
  });

  it("sends early when enough is waiting, whatever the clock says", () => {
    const held = rigged({ cap: 3 });
    held.activity.open("an-episode", 10_000);
    held.activity.note("a");
    held.activity.note("b");
    expect(held.sent).toHaveLength(0);
    held.activity.note("c");
    expect(kinds(held.sent)).toEqual(["a", "b", "c"]);
  });

  it("sends nothing when there is nothing to send", () => {
    const held = rigged();
    held.activity.open("an-episode", 10_000);
    held.wind(500);
    held.wind(500);
    expect(held.sent).toHaveLength(0);
  });

  it("holds what is noted while a slow send is in flight, and sends it next", async () => {
    const held = rigged();
    held.activity.open("an-episode", 10_000);
    held.activity.note("a");
    held.stall();
    held.wind(100);
    expect(kinds(held.sent)).toEqual(["a"]);

    held.activity.note("b");
    held.wind(100);
    expect(held.sent, "one request at a time, or batches interleave").toHaveLength(1);

    held.release();
    await Promise.resolve();
    await Promise.resolve();
    held.wind(100);
    expect(kinds(held.sent)).toEqual(["a", "b"]);
  });

  it("a send that fails costs its batch and nothing else", async () => {
    /** Telemetry, not somebody's program. A retry queue that grew without
     *  bound would be the worse bug. */
    const sent: Batch[] = [];
    let at = 0;
    const activity = new Activity({
      now: () => at,
      every: 100,
      flush: (batch) => {
        sent.push(batch);
        return Promise.reject(new Error("the server cannot be reached"));
      },
    });
    activity.open("an-episode", 10_000);
    activity.note("a");
    at = 200;
    activity.check();
    await Promise.resolve();
    await Promise.resolve();

    activity.note("b");
    at = 400;
    activity.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((one) => one.moments.map((m) => m.kind))).toEqual([["a"], ["b"]]);
  });

  it("says how much a runaway window could not hold", () => {
    const held = rigged({ limit: 2, cap: 1_000 });
    held.activity.open("an-episode", 10_000);
    held.activity.note("a");
    held.activity.note("b");
    held.activity.note("c");
    held.activity.note("d");
    held.activity.close();

    expect(kinds(held.sent)).toEqual(["a", "b", "dropped"]);
    expect(held.sent[0]!.moments.at(-1)).toMatchObject({ moments: 2 });
  });

  it("gives whatever is buffered one last go when the panel goes away", () => {
    const held = rigged();
    held.activity.open("an-episode", 10_000);
    held.activity.note("edit");
    held.activity.dispose();
    expect(kinds(held.sent)).toEqual(["edit"]);
    expect(held.closing.at(-1)).toBe(true);
  });
});
