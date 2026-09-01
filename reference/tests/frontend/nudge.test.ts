/**
 * The offer on screen: when it goes, and what is not allowed to take it away.
 *
 * `svelte-sonner` stands in for the screen, because what is being checked is
 * the protocol's arithmetic and not a toast's rendering: which calls happen,
 * in what order, and how much of the clock has passed when they do. The clock
 * and the waiting are handed in for the reason `stuck.ts` gives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dismissed: (string | number)[] = [];
const shown: { message: string; options: Record<string, any> }[] = [];

vi.mock("svelte-sonner", () => ({
  toast: Object.assign(
    (message: string, options: Record<string, any>) => {
      shown.push({ message, options });
      return `toast-${shown.length}`;
    },
    { dismiss: (id: string | number) => void dismissed.push(id) },
  ),
}));

const { AT_LEAST, Nudge } = await import(
  "../../release/frontend/svelte/assistant/nudge"
);

/** A clock the test winds and a wait the test ends. */
const rigged = () => {
  let at = 0;
  let due: { when: number; done: () => void } | undefined;
  const nudge = new Nudge({
    now: () => at,
    after: (ms, done) => {
      due = { when: at + ms, done };
      return () => (due = undefined);
    },
  });
  return {
    nudge,
    pending: () => due,
    wind: (by: number) => {
      at += by;
      if (due !== undefined && at >= due.when) {
        const { done } = due;
        due = undefined;
        done();
      }
    },
  };
};

beforeEach(() => {
  dismissed.length = 0;
  shown.length = 0;
});

describe("the offer", () => {
  it("says the protocol's words and stays for as long as it was given", () => {
    rigged().nudge.offer(() => {}, 20_000);
    expect(shown[0]?.message).toBe("Want a hint?");
    expect(shown[0]?.options.duration).toBe(20_000);
    expect(shown[0]?.options.action.label).toBe("Yes, show me");
  });

  it("is not snatched away by somebody who was already typing", () => {
    const { nudge, wind, pending } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);

    /** A keystroke in the same instant the banner arrived. */
    nudge.withdraw();
    expect(dismissed, "still on screen, and readable").toHaveLength(0);
    expect(pending()?.when).toBe(1_500);

    wind(1_499);
    expect(dismissed).toHaveLength(0);
    wind(1);
    expect(dismissed).toEqual(["toast-1"]);
  });

  it("goes at once for somebody who had already had their look", () => {
    const { nudge, wind } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);
    wind(1_500);
    nudge.withdraw();
    expect(dismissed, "no waiting left to do").toEqual(["toast-1"]);
  });

  it("keeps the first keystroke's deadline rather than the last one's", () => {
    const { nudge, wind, pending } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);
    nudge.withdraw();
    wind(500);
    nudge.withdraw();
    nudge.withdraw();
    expect(pending()?.when, "not pushed back to 2000").toBe(1_500);
    wind(1_000);
    expect(dismissed).toEqual(["toast-1"]);
  });

  it("is taken the moment somebody takes it, floor or no floor", () => {
    const { nudge } = rigged();
    let helped = 0;
    nudge.offer(() => (helped += 1), 20_000, 1_500);
    shown[0]?.options.action.onClick();
    expect(helped).toBe(1);
    expect(dismissed, "the floor stops it being snatched away, not taken").toEqual([
      "toast-1",
    ]);
  });

  it("a floor longer than the offer itself cannot outlive it", () => {
    const { nudge, pending } = rigged();
    nudge.offer(() => {}, 400, 1_500);
    nudge.withdraw();
    expect(pending()?.when).toBe(400);
  });

  it("a new offer replaces the old one now, not after its floor", () => {
    const { nudge } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);
    nudge.offer(() => {}, 20_000, 1_500);
    expect(dismissed).toEqual(["toast-1"]);
    expect(shown).toHaveLength(2);
  });

  it("closing takes it down whatever the floor says", () => {
    const { nudge, pending } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);
    nudge.withdraw();
    expect(pending()).toBeDefined();
    nudge.close();
    expect(dismissed).toEqual(["toast-1"]);
    expect(pending(), "and the waiting is called off").toBeUndefined();
  });

  it("forgets an offer that ended on its own, and does not dismiss it twice", () => {
    const { nudge } = rigged();
    nudge.offer(() => {}, 20_000, 1_500);
    shown[0]?.options.onAutoClose();
    expect(nudge.offered).toBe(false);
    nudge.withdraw();
    nudge.close();
    expect(dismissed).toHaveLength(0);
  });

  it("has a floor short enough not to be in the way", () => {
    expect(AT_LEAST).toBeGreaterThanOrEqual(1_000);
    expect(AT_LEAST).toBeLessThanOrEqual(2_000);
  });
});
