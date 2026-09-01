import { describe, expect, it, vi } from "vitest";

import { run } from "../../release/frontend/loop";

const settled = () => new Promise<void>((done) => setTimeout(done, 0));

describe("the sync loop", () => {
  it("re-enters at Initialize whenever a stream ends", async () => {
    const reconcile = vi.fn(async () => "token");
    let endStream: () => void = () => {};
    const loop = run(
      {
        reconcile,
        follow: () => new Promise<void>((ended) => (endStream = ended)),
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await settled();
    expect(reconcile).toHaveBeenCalledTimes(1);

    endStream();
    await settled();
    await settled();
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);

    loop.stop();
  });

  /**
   * A token the server never issued means this client's state is unsound, and
   * the only sound answer is to throw it away and start again. Nudging is how
   * it asks for that -- and a client that has just been told its state is
   * unsound is by definition one whose stream is working, so the case that
   * matters is exactly the one where there is no backoff to wake from.
   */
  it("re-enters at Initialize when nudged, stream or no stream", async () => {
    const reconcile = vi.fn(async () => "token");
    const loop = run(
      {
        reconcile,
        follow: (_token, _alive, until) =>
          new Promise<void>((ended) => until.addEventListener("abort", () => ended())),
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await settled();
    expect(reconcile).toHaveBeenCalledTimes(1);

    loop.nudge();
    await settled();
    await settled();
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);

    loop.stop();
  });

  it("treats a silent stream as a failed one", async () => {
    const reconcile = vi.fn(async () => "token");
    const loop = run(
      { reconcile, follow: () => new Promise<void>(() => {}) },
      { watchdogMs: 5, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 60));
    loop.stop();

    // A stream nothing ever arrives on is indistinguishable from no stream,
    // which is the failure the watchdog exists for.
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);
  });

  it("stays alive while traffic keeps arriving", async () => {
    const reconcile = vi.fn(async () => "token");
    const loop = run(
      {
        reconcile,
        follow: (_token, alive) =>
          new Promise<void>(() => {
            const beat = setInterval(alive, 5);
            setTimeout(() => clearInterval(beat), 200);
          }),
      },
      { watchdogMs: 40, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 100));
    loop.stop();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("gives the stream's connection back when it is stopped", async () => {
    let aborted = false;
    const loop = run(
      {
        reconcile: async () => "token",
        // A stream nothing ever ends: the case where only `stop` can reclaim
        // the socket. A page that opens and closes workspaces holds one per
        // closed workspace otherwise, and a browser lends an origin six.
        follow: (_token, _alive, until) =>
          new Promise<void>((ended) =>
            until.addEventListener("abort", () => ((aborted = true), ended())),
          ),
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await settled();
    loop.stop();
    await settled();

    expect(aborted).toBe(true);
  });

  it("gives the connection back when the watchdog gives up on it", async () => {
    let aborted = false;
    const loop = run(
      {
        reconcile: async () => "token",
        follow: (_token, _alive, until) =>
          new Promise<void>(() => until.addEventListener("abort", () => (aborted = true))),
      },
      { watchdogMs: 5, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 40));
    loop.stop();

    // The watchdog decides the stream is not there; nothing else is going to
    // close a fetch the server is perfectly happy to hold open.
    expect(aborted).toBe(true);
  });

  it("reports a failure instead of stopping over it", async () => {
    const failed = vi.fn();
    let attempts = 0;
    const loop = run(
      {
        reconcile: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return "token";
        },
        follow: () => new Promise<void>(() => {}),
        failed,
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 30));
    loop.stop();

    expect(failed).toHaveBeenCalledOnce();
    expect(attempts).toBeGreaterThan(1);
  });
});
