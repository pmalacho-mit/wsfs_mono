/**
 * The sync loop. Cold start, reconnect and recovery are the same path: every
 * disruption re-enters at Initialize.
 *
 *   Initialize(workspace, outbox)   -- adjudicates and snapshots, one server tx
 *   evict applied and rejected; replace confirmed
 *   follow the stream with the token it minted
 *   consume until the stream fails or the watchdog expires
 *   back off, jittered; re-enter
 *
 * Backoff resets only once a stream is ESTABLISHED, not once one is attempted,
 * or a server refusing connections instantly would be retried in a tight loop.
 */
export type Timing = {
  /** No traffic at all for this long means the stream is not really there. */
  watchdogMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
};

export const DEFAULTS: Timing = {
  watchdogMs: 45_000,
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
};

export type Cycle = {
  /** Runs Initialize, applies its answer, and returns the stream token. */
  reconcile: () => Promise<string>;
  /**
   * Resolves when the stream fails; rejects nothing. Stops reading when
   * `until` aborts, which is how the loop gets the connection back rather
   * than leaving it open for a server that has no reason to close it.
   */
  follow: (token: string, alive: () => void, until: AbortSignal) => Promise<void>;
  failed?: (reason: unknown) => void;
};

export type Loop = { stop: () => void; nudge: () => void };

const jittered = (delay: number) => delay / 2 + Math.random() * (delay / 2);

const sleep = (ms: number) => new Promise<void>((wake) => setTimeout(wake, ms));

/**
 * A promise that settles when nothing has reported life for `after`, so a
 * proxy that accepts the connection and then swallows it looks like what it
 * is rather than like a quiet workspace.
 */
const watchdog = (after: number) => {
  let bark: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<void>((wake) => (bark = wake));
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => bark(), after);
  };
  reset();
  return { expired, reset, stop: () => clearTimeout(timer) };
};

export const run = (cycle: Cycle, timing: Timing = DEFAULTS): Loop => {
  let stopped = false;
  let backoff = timing.minBackoffMs;
  let wake: (() => void) | undefined;
  let reading: AbortController | undefined;

  const rest = async () => {
    const waited = new Promise<void>((resume) => (wake = resume));
    await Promise.race([sleep(jittered(backoff)), waited]);
    wake = undefined;
    backoff = Math.min(backoff * 2, timing.maxBackoffMs);
  };

  const once = async () => {
    const token = await cycle.reconcile();
    if (stopped) return; // stopped mid-reconcile: do not open a stream nobody wants
    const guard = watchdog(timing.watchdogMs);
    reading = new AbortController();
    backoff = timing.minBackoffMs; // a stream that reconciled is established
    try {
      await Promise.race([
        cycle.follow(token, guard.reset, reading.signal),
        guard.expired,
      ]);
    } finally {
      guard.stop();
      // Whichever side of the race won, this stream is over. A watchdog that
      // fires on a proxy holding the connection open is the case that matters:
      // nothing else would ever hand the socket back.
      reading.abort();
      reading = undefined;
    }
  };

  void (async () => {
    while (!stopped) {
      try {
        await once();
      } catch (reason) {
        cycle.failed?.(reason);
      }
      if (!stopped) await rest();
    }
  })();

  return {
    stop: () => {
      stopped = true;
      reading?.abort();
      wake?.();
    },
    /**
     * Re-enter at Initialize now.
     *
     * What a tab becoming visible or coming online means -- and what a client
     * means when the server tells it a token it presented was never issued,
     * which says its state is unsound and the only sound answer is to throw
     * it away and start again.
     *
     * Waking the backoff is not enough, and the case that matters is exactly
     * the one it misses: a client whose state has just been called unsound is
     * one whose stream is working, so there is no backoff to wake from. The
     * stream has to be given back for the loop to come round again.
     */
    nudge: () => {
      backoff = timing.minBackoffMs;
      wake?.();
      reading?.abort();
    },
  };
};
