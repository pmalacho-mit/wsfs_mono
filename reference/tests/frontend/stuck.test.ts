/**
 * The nudge protocol: what counts as stuck, and what is allowed to be said.
 *
 * All of it in milliseconds. The class takes its clock and its coin from
 * outside precisely so a twenty-minute cooldown is a twenty-millisecond test
 * -- and so the randomization can be checked at all, which against
 * `Math.random` it could not be.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  errorNamed,
  settingsFrom,
  Stuck,
  tickFor,
  type Episode,
  type Settings,
} from "../../release/frontend/svelte/assistant/stuck";

const quick: Settings = {
  idle: 100,
  progress: 200,
  offerRate: 1,
  cooldown: 1000,
  window: 500,
  banner: 20,
  floor: 5,
};

/** A clock the test winds, a coin the test loads, and names it can predict. */
const rigged = (
  over: Partial<Settings> = {},
  lands = 0,
  looking?: () => { entry?: string; path: string; text: string } | undefined,
) => {
  let at = 0;
  const offered: Episode[] = [];
  const logged: Episode[] = [];
  let coin = lands;
  let named = 0;
  const stuck = new Stuck({
    settings: { ...quick, ...over },
    now: () => at,
    roll: () => coin,
    mint: () => `episode-${(named += 1)}`,
    offer: (episode) => offered.push(episode),
    record: (episode) => logged.push(episode),
    ...(looking === undefined ? {} : { looking }),
  });
  return {
    stuck,
    offered,
    logged,
    lands: (next: number) => (coin = next),
    wind: (by: number) => {
      at += by;
      stuck.check();
    },
    at: () => at,
  };
};

describe("what counts as stuck", () => {
  it("names the exception rather than the message", () => {
    expect(errorNamed("NameError: total is not defined")).toBe("NameError");
    expect(errorNamed("ZeroDivisionError: division by zero")).toBe(
      "ZeroDivisionError",
    );
    expect(errorNamed("StopIteration")).toBe("StopIteration");
    /** A traceback quotes the source above the exception, and source has
     *  colons in it -- so this is anchored and answers nothing for one. */
    expect(errorNamed("  File \"x.py\", line 2\n    print(1)")).toBeUndefined();
  });

  it("fires on the same error twice and not on two different ones", () => {
    const held = rigged();
    held.stuck.ran({ ok: false, because: "NameError: x is not defined" });
    expect(held.logged).toHaveLength(0);

    held.stuck.ran({ ok: false, because: "TypeError: bad operand" });
    expect(held.logged, "a different error is not a repeat").toHaveLength(0);

    held.stuck.ran({ ok: false, because: "TypeError: also bad" });
    expect(held.logged).toHaveLength(1);
    expect(held.logged[0]!.rule).toBe("the same error twice");
    expect(held.logged[0]!.detail).toContain("TypeError");
  });

  it("counts the message as the same mistake made twice", () => {
    const held = rigged();
    held.stuck.ran({ ok: false, because: "NameError: x is not defined" });
    held.stuck.ran({ ok: false, because: "NameError: y is not defined" });
    expect(
      held.logged,
      "fixing one name and tripping over the next is the case this is for",
    ).toHaveLength(1);
  });

  it("counts a failure nobody could name as a kind of its own", () => {
    const { stuck, logged } = rigged();
    stuck.ran({ ok: false, because: "Segmentation fault" });
    expect(logged, "one unreadable failure is a student working").toHaveLength(
      0,
    );
    stuck.ran({ ok: false, because: "the kernel went away" });
    expect(logged, "two in a row is the same corner twice").toHaveLength(1);
    expect(logged[0]?.rule).toBe("the same error twice");
    expect(logged[0]?.detail).toContain("unreadable");
  });

  it("an unreadable failure breaks a run of named ones", () => {
    const { stuck, logged } = rigged();
    stuck.ran({ ok: false, because: "NameError: x" });
    stuck.ran({ ok: false, because: "Segmentation fault" });
    stuck.ran({ ok: false, because: "NameError: x" });
    expect(logged, "something else happened in between").toHaveLength(0);
  });

  it("a run that worked forgets the error before it", () => {
    const held = rigged();
    held.stuck.ran({ ok: false, because: "NameError: x" });
    held.stuck.ran({ ok: true });
    held.stuck.ran({ ok: false, because: "NameError: x" });
    expect(held.logged).toHaveLength(0);
  });

  it("fires when nobody has done anything for long enough", () => {
    const held = rigged();
    held.wind(99);
    expect(held.logged).toHaveLength(0);
    held.wind(1);
    expect(held.logged).toHaveLength(1);
    expect(held.logged[0]!.rule).toBe("idle");
  });

  it("anything the person does puts the idle clock back", () => {
    const held = rigged();
    held.wind(90);
    held.stuck.acted();
    held.wind(90);
    expect(held.logged, "they typed 90ms in").toHaveLength(0);
    held.wind(10);
    expect(held.logged).toHaveLength(1);
  });

  it("running counts as doing something", () => {
    const held = rigged();
    held.wind(90);
    held.stuck.ran({ ok: true });
    held.wind(90);
    expect(held.logged).toHaveLength(0);
  });
});

describe("what is allowed to be said", () => {
  it("offers or stays silent by the coin, and records which", () => {
    const held = rigged({ offerRate: 0.5 }, 0.4);
    held.wind(100);
    expect(held.logged[0]!.became).toBe("offered");
    expect(held.offered, "a prompt was shown").toHaveLength(1);

    /** Past the cooldown, so the next one is randomized afresh. */
    held.lands(0.6);
    held.wind(1000);
    expect(held.logged.at(-1)!.became).toBe("silent");
    expect(held.offered, "and nothing was shown for it").toHaveLength(1);
  });

  it("the prompt is shown for as long as the settings say", () => {
    const held = rigged({ banner: 1234 });
    held.wind(100);
    expect(held.offered).toHaveLength(1);
    /** The duration goes with the offer rather than being read from a
     *  constant at the far end, so it is configurable in one place. */
    const shownFor: number[] = [];
    const again = new Stuck({
      settings: { ...quick, banner: 4321 },
      now: () => 0,
      roll: () => 0,
      offer: (_episode, forMs) => shownFor.push(forMs),
    });
    again.ran({ ok: false, because: "NameError: a" });
    again.ran({ ok: false, because: "NameError: b" });
    expect(shownFor).toEqual([4321]);
  });

  it("a shown prompt starts a cooldown that nothing else gets through", () => {
    const held = rigged();
    held.wind(100);
    expect(held.offered).toHaveLength(1);

    /** Detections keep coming and keep being written down -- that is what
     *  the log is for -- but none of them reaches a screen. */
    held.wind(100);
    held.wind(100);
    held.stuck.ran({ ok: false, because: "NameError: a" });
    held.stuck.ran({ ok: false, because: "NameError: b" });
    expect(held.logged.length, "still detecting").toBeGreaterThan(3);
    expect(held.offered, "and still saying nothing").toHaveLength(1);
    expect(
      held.logged.at(-1)!.became,
      "the cooldown is the reason, and it says so",
    ).toBe("held back by the cooldown");
  });

  it("guarantees the cooldown as a minimum gap between two prompts", () => {
    const held = rigged();
    held.wind(100);
    const first = held.at();
    while (held.offered.length < 2 && held.at() < 5000) held.wind(50);
    expect(held.offered, "a second prompt eventually").toHaveLength(2);
    expect(
      held.at() - first,
      "and not before the cooldown was up",
    ).toBeGreaterThanOrEqual(quick.cooldown);
  });

  it("a silent episode opens the same window an offered one does", () => {
    /** The comparison the study rests on: both conditions are followed by
     *  the same undisturbed stretch. */
    const held = rigged({ offerRate: 0 });
    held.wind(100);
    expect(held.logged[0]!.became).toBe("silent");

    held.wind(100);
    expect(held.logged.at(-1)!.became).toBe(
      "held back by a post-episode window",
    );
    expect(held.offered).toHaveLength(0);
  });

  it("a window is not reset or extended by what happens inside it", () => {
    const held = rigged({ offerRate: 0 });
    held.wind(100);
    const opened = held.at();

    /** Detections all the way through it, none of which move the end. */
    while (held.at() < opened + quick.window - 50) held.wind(50);
    expect(held.logged.every((one, at) => at === 0 || one.became !== "silent")).toBe(
      true,
    );

    /** And the moment it is up, a new episode is counted again. */
    held.wind(100);
    expect(held.logged.at(-1)!.became).toBe("silent");
    expect(
      held.at() - opened,
      "which is one window later, not two",
    ).toBeLessThan(quick.window * 2);
  });

  it("reports the cooldown rather than the window where they overlap", () => {
    /** The cooldown outlasts the window, so for the ten minutes they share
     *  the window is true and the cooldown is the reason. */
    const held = rigged();
    held.wind(100);
    held.wind(quick.window + 50);
    expect(held.logged.at(-1)!.became).toBe("held back by the cooldown");
  });
});

describe("the settings", () => {
  it("come from the URL in seconds, and fall back when they are nonsense", () => {
    const said = settingsFrom("?nudge.idle=5&nudge.cooldown=60&nudge.offer=0.25");
    expect(said.idle).toBe(5_000);
    expect(said.cooldown).toBe(60_000);
    expect(said.offerRate).toBe(0.25);
    expect(said.progress, "untouched ones keep the default").toBe(
      DEFAULTS.progress,
    );

    const nonsense = settingsFrom("?nudge.idle=banana&nudge.offer=7");
    expect(nonsense.idle).toBe(DEFAULTS.idle);
    expect(nonsense.offerRate, "a rate is a share, not a count").toBe(
      DEFAULTS.offerRate,
    );
  });

  it("defaults to what the customer asked for", () => {
    expect(DEFAULTS.idle).toBe(180_000);
    expect(DEFAULTS.progress).toBe(240_000);
    expect(DEFAULTS.offerRate).toBe(0.5);
    expect(DEFAULTS.cooldown).toBe(20 * 60_000);
    expect(DEFAULTS.window).toBe(10 * 60_000);
    expect(DEFAULTS.banner).toBe(20_000);
    expect(DEFAULTS.floor, "long enough to read, short enough to ignore").toBe(
      1_500,
    );
  });

  it("lets somebody set the floor without a deploy, like everything else", () => {
    expect(settingsFrom("?nudge.floor=2").floor).toBe(2_000);
    expect(settingsFrom("?nudge.floor=0", DEFAULTS).floor, "zero is a floor").toBe(
      0,
    );
    expect(settingsFrom("?nudge.floor=banana").floor).toBe(DEFAULTS.floor);
  });
});

describe("whether the code moved", () => {
  /** Idleness off, so only the rule under test can fire. Winding the clock
   *  without typing is otherwise being idle, which is its own detection. */
  const patient: Settings = { ...quick, idle: Number.MAX_SAFE_INTEGER };

  const watching = (
    answers: { progressing: boolean; why: string }[],
    goals: Record<string, string> = { "demo.py": 'display "hello world" twice' },
  ) => {
    let at = 0;
    let text = "print(1)";
    const asked: { goal: string; before: string; after: string }[] = [];
    const logged: Episode[] = [];
    const stuck = new Stuck({
      settings: patient,
      now: () => at,
      roll: () => 0,
      offer: () => {},
      record: (episode) => logged.push(episode),
      looking: () => ({ path: "demo.py", text }),
      goalFor: (path) => goals[path],
      judging: async (asking) => {
        asked.push(asking);
        return answers.shift() ?? { progressing: true, why: "" };
      },
    });
    return {
      logged,
      asked,
      types: (next: string) => (text = next),
      wind: async (by: number) => {
        at += by;
        stuck.check();
        /** The judgement is a round trip; let it land before asserting. */
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  };

  it("asks only once the interval has passed, and with both versions", async () => {
    const held = watching([{ progressing: true, why: "added a print" }]);
    await held.wind(100);
    expect(held.asked, "too early").toHaveLength(0);

    held.types("print(1)\nprint(2)");
    await held.wind(150);
    expect(held.asked).toHaveLength(1);
    expect(held.asked[0]!.before).toBe("print(1)");
    expect(held.asked[0]!.after).toBe("print(1)\nprint(2)");
    expect(held.asked[0]!.goal).toContain("hello world");
    expect(held.logged, "progress is not being stuck").toHaveLength(0);
  });

  it("counts as stuck when the model says the code has not moved", async () => {
    const held = watching([{ progressing: false, why: "same code as before" }]);
    await held.wind(250);
    expect(held.logged).toHaveLength(1);
    expect(held.logged[0]!.rule).toBe("no progress");
    expect(held.logged[0]!.detail).toBe("same code as before");
  });

  it("says nothing about a file nobody set a goal for", async () => {
    const held = watching([{ progressing: false, why: "no" }], {});
    await held.wind(250);
    expect(held.asked, "not worth a round trip").toHaveLength(0);
    expect(held.logged).toHaveLength(0);
  });

  it("starts the clock again when the person switches file", async () => {
    let at = 0;
    let path = "demo.py";
    const asked: unknown[] = [];
    const stuck = new Stuck({
      settings: patient,
      now: () => at,
      roll: () => 0,
      offer: () => {},
      looking: () => ({ path, text: "x = 1" }),
      goalFor: (path) => ({ "demo.py": "a", "Test.py": "b" })[path],
      judging: async (asking) => (asked.push(asking), { progressing: true, why: "" }),
    });
    at = 150;
    path = "Test.py";
    stuck.check();
    await Promise.resolve();
    expect(asked, "the before belonged to the other file").toHaveLength(0);

    at = 400;
    stuck.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked, "and the new file's own window has now passed").toHaveLength(1);
  });

  it("a judgement that fails is not evidence of anything", async () => {
    let at = 0;
    const logged: Episode[] = [];
    const stuck = new Stuck({
      settings: patient,
      now: () => at,
      roll: () => 0,
      offer: () => {},
      record: (episode) => logged.push(episode),
      looking: () => ({ path: "demo.py", text: "x" }),
      goalFor: () => "a",
      judging: async () => {
        throw new Error("the model could not be reached");
      },
    });
    at = 250;
    stuck.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(logged).toHaveLength(0);
  });
});

describe("what an episode is, for whoever reads it back", () => {
  it("names itself, so everything about it can name it too", () => {
    /** The offer somebody accepted, the cooldown it started, the window it
     *  opened and every keystroke inside that window are four tables joined
     *  by this and nothing else. */
    const held = rigged();
    held.wind(100);
    held.wind(1000);
    const [first, second] = held.logged;
    expect(first!.id).toBe("episode-1");
    expect(second!.id).toBe("episode-2");
    expect(held.offered[0]!.id, "and the offer is handed the same one").toBe(
      first!.id,
    );
  });

  it("carries the code as it stood at onset", () => {
    let text = "print(1)";
    const held = rigged({}, 0, () => ({
      entry: "an-entry",
      path: "demo.py",
      text,
    }));
    held.wind(100);
    text = "print(2)";
    held.wind(1000);

    expect(held.logged[0]!.code).toEqual({
      entry: "an-entry",
      path: "demo.py",
      text: "print(1)",
    });
    expect(
      held.logged[1]!.code!.text,
      "the second episode is evidence about the second program",
    ).toBe("print(2)");
  });

  it("says nothing about code when nothing was on screen", () => {
    const held = rigged({}, 0, () => undefined);
    held.wind(100);
    expect(held.logged[0]!.code).toBeUndefined();
  });

  it("carries both ends of every period it opened", () => {
    /** Precalculated, and recorded, because the settings that decide the
     *  lengths are configurable -- so recomputing them later would describe
     *  today's configuration rather than the student's afternoon. */
    const held = rigged();
    held.wind(100);
    const episode = held.logged[0]!;
    expect(episode.window).toEqual({ from: 100, until: 100 + quick.window });
    expect(episode.cooldown).toEqual({
      from: 100,
      until: 100 + quick.cooldown,
    });
  });

  it("a silent episode opens a window and starts no cooldown", () => {
    const held = rigged({ offerRate: 0 });
    held.wind(100);
    expect(held.logged[0]!.window).toEqual({
      from: 100,
      until: 100 + quick.window,
    });
    expect(held.logged[0]!.cooldown).toBeUndefined();
  });

  it("an episode the protocol held back opens neither", () => {
    const held = rigged();
    held.wind(100);
    held.wind(100);
    const heldBack = held.logged.at(-1)!;
    expect(heldBack.became).toBe("held back by the cooldown");
    expect(heldBack.window, "there is already one open").toBeUndefined();
    expect(heldBack.cooldown).toBeUndefined();
    expect(
      heldBack.code,
      "and it is still evidence about a student being stuck",
    ).toBeUndefined();
  });
});

describe("how often the rules are asked", () => {
  it("is half the shortest rule, so a short one is honoured", () => {
    /** The bug this exists for: a fixed five-second tick against
     *  `?nudge.idle=4` -- a threshold the tick cannot resolve, which looks
     *  from the outside like a setting that does nothing. */
    expect(tickFor({ ...DEFAULTS, idle: 4_000 })).toBe(2_000);
    expect(tickFor({ ...DEFAULTS, progress: 6_000 })).toBe(3_000);
  });

  it("is never slower than five seconds, whatever the rules are set to", () => {
    expect(tickFor(DEFAULTS)).toBe(5_000);
  });

  it("is never fast enough to spin the page", () => {
    /** `?nudge.idle=0` is a legitimate thing to ask for -- see the note in
     *  `settingsFrom` about zero being a number of seconds. */
    expect(tickFor({ ...DEFAULTS, idle: 0 })).toBe(250);
  });
});
