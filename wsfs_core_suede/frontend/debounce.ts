export type Config = { idleMs: number; maxWaitMs: number };

export type Options = Partial<Config> & {
  /**
   * Whether pending work is flushed when the page is hidden or unloaded.
   *
   * True is right for anything that is somebody's WORK -- a save held back a
   * few seconds must not be lost to a closing tab. It is backwards for work
   * that only exists to be fast, where flushing on hide fires a burst of
   * requests for results nobody is now going to read, at the moment the user
   * has left. See `warming.ts`.
   */
  flushWhenHidden?: boolean;
};

type Timer = ReturnType<typeof setTimeout>;

type Entry = {
  callback: () => void;
  idleTimer: Timer;
  maxTimer: Timer;
};

const DEFAULTS: Config = { idleMs: 5_000, maxWaitMs: 20_000 };

/**
 * Per-key debouncer with a maximum wait.
 *
 * A key's callback fires after `idleMs` with no further `enqueue` calls for
 * that key, but no later than `maxWaitMs` after the *first* `enqueue` of the
 * current burst. Pending work is also flushed when the page is hidden or
 * unloaded.
 */
export class MappedDebouncer<T> {
  readonly #entries = new Map<T, Entry>();
  #detach: () => void;
  #disposed = false;
  readonly #opts: Config;

  constructor({ flushWhenHidden = true, ...opts }: Options = {}) {
    this.#opts = MappedDebouncer.validateConfig({ ...DEFAULTS, ...opts });
    this.#detach = flushWhenHidden ? this.#attachTeardownListeners() : () => {};
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: T): boolean {
    return this.#entries.has(key);
  }

  enqueue(key: T, callback: () => void, config?: Partial<Config>): void {
    if (this.#disposed)
      throw new Error("MappedDebouncer: enqueue after dispose()");

    // Validate the *merged* config, not the partial override.
    const { idleMs, maxWaitMs } = config
      ? MappedDebouncer.validateConfig({ ...this.#opts, ...config })
      : this.#opts;

    const existing = this.#entries.get(key);
    if (existing) {
      // Only the idle timer resets; the max timer keeps running so a steady
      // stream of enqueues can't starve the callback indefinitely. A new
      // maxWaitMs passed here therefore has no effect until the next burst.
      clearTimeout(existing.idleTimer);
      existing.callback = callback;
      existing.idleTimer = setTimeout(() => this.flush(key), idleMs);
      return;
    }

    this.#entries.set(key, {
      callback,
      idleTimer: setTimeout(() => this.flush(key), idleMs),
      maxTimer: setTimeout(() => this.flush(key), maxWaitMs),
    });
  }

  /** Drop any pending callback for `key` without running it. */
  clear(key: T): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.maxTimer);
    this.#entries.delete(key);
    return true;
  }

  /**
   * Run `key`'s pending callback immediately, if any.
   *
   * State is torn down *before* the callback runs, so the callback may safely
   * re-enqueue itself, and a throwing callback can't leave a stale timer
   * behind that would invoke it a second time.
   */
  flush(key: T): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.clear(key);
    entry.callback();
  }

  /**
   * Flush every pending key. One throwing callback does not prevent the rest
   * from running; its error is rethrown asynchronously so it still reaches
   * window.onerror / reporting rather than being swallowed.
   */
  flushAll(): void {
    for (const key of [...this.#entries.keys()]) {
      try {
        this.flush(key);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /**
   * Detach listeners and release pending work. Pass `{ flush: true }` to run
   * pending callbacks first; the default drops them.
   */
  dispose({ flush = false }: { flush?: boolean } = {}): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detach();
    this.#detach = () => {};
    if (flush) this.flushAll();
    else for (const key of [...this.#entries.keys()]) this.clear(key);
  }

  /** Enables `using d = new MappedDebouncer()` where supported. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  #attachTeardownListeners(): () => void {
    // No-op under SSR / workers, where there is no document.
    if (typeof document === "undefined" || typeof window === "undefined")
      return () => {};

    const onVisibilityChange = () => {
      // Only on hide — flushing on the visible transition too would defeat
      // the debounce for anyone tabbing back and forth.
      if (document.visibilityState === "hidden") this.flushAll();
    };
    const onPageHide = () => this.flushAll();

    // `beforeunload` is deliberately omitted: registering it disqualifies the
    // page from the back/forward cache in several browsers, and `pagehide`
    // already covers teardown.
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }

  static validateConfig(config: Config): Config {
    const entries = [
      ["idleMs", config.idleMs],
      ["maxWaitMs", config.maxWaitMs],
    ] as const;

    for (const [name, value] of entries) {
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError(
          `MappedDebouncer: ${name} must be a finite, non-negative number (got ${value})`,
        );
    }
    if (config.maxWaitMs < config.idleMs)
      throw new RangeError(
        "MappedDebouncer: maxWaitMs must be greater than or equal to idleMs",
      );

    return config;
  }
}
