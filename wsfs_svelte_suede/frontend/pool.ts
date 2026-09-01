/**
 * WarmPool — a pool of expensive-to-create, single-use ("throwaway") resources.
 *
 * Policy: keep exactly `max` resources alive at all times. "Alive" counts
 * resources being created, sitting ready, checked out, and being disposed.
 * Any time there's headroom, a replacement starts coming up immediately.
 *
 * A resource is never reused: `release()` disposes it and frees its slot, which
 * the pool refills at once — handing the fresh one to the longest-waiting
 * caller, if any. Waiters are served FIFO.
 */

export interface DisposableResource {
  dispose(): void | Promise<void>;
}

export interface WarmPoolOptions<T> {
  /** Build a resource. May be sync or async. */
  create(): Promise<T> | T;
  /** Hard ceiling on concurrently alive resources. Default 2. */
  max?: number;
  /** Backoff before retrying after a failed `create`. Default 1000ms. */
  retryDelayMs?: number;
  onError?(error: unknown, phase: "create" | "dispose"): void;
}

export interface Lease<T> {
  /** The checked-out resource. Do not use it after release(). */
  readonly value: T;
  readonly released: boolean;
  /** Disposes the resource and frees its slot. Idempotent. */
  release(): void;
}

export interface WarmPoolStats {
  ready: number;
  creating: number;
  inUse: number;
  disposing: number;
  waiting: number;
  alive: number;
}

interface Waiter<T> {
  done: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class WarmPool<T extends DisposableResource> {
  readonly #create: WarmPoolOptions<T>["create"];
  readonly #max: number;
  readonly #retryDelayMs: number;
  readonly #onError?: WarmPoolOptions<T>["onError"];

  #ready: T[] = [];
  #waiters: Waiter<T>[] = [];
  #creating = 0;
  #inUse = 0;
  #disposing = 0;

  #closed = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = new Set<Promise<void>>();

  constructor(options: WarmPoolOptions<T>) {
    this.#create = options.create;
    this.#max = Math.max(1, options.max ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#onError = options.onError;

    this.#pump(); // start filling up front
  }

  get stats(): WarmPoolStats {
    return {
      ready: this.#ready.length,
      creating: this.#creating,
      inUse: this.#inUse,
      disposing: this.#disposing,
      waiting: this.#waiters.length,
      alive: this.#alive,
    };
  }

  get #alive(): number {
    return this.#ready.length + this.#creating + this.#inUse + this.#disposing;
  }

  /**
   * Check out a resource. Resolves immediately if one is ready, otherwise waits
   * (FIFO) for a slot to free up and its replacement to come up.
   */
  acquire(signal?: AbortSignal): Promise<Lease<T>> {
    if (this.#closed) return Promise.reject(new Error("WarmPool is closed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;

      const waiter: Waiter<T> = {
        done: false,
        resolve: (value) => {
          if (waiter.done) return;
          waiter.done = true;
          if (onAbort) signal!.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          if (waiter.done) return;
          waiter.done = true;
          if (onAbort) signal!.removeEventListener("abort", onAbort);
          reject(error);
        },
      };

      if (signal) {
        onAbort = () => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) this.#waiters.splice(i, 1);
          waiter.reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.#waiters.push(waiter);
      this.#pump();
    }).then((value) => this.#lease(value));
  }

  /** Acquire, run `fn`, and always release — including on throw. */
  async use<R>(
    fn: (value: T) => Promise<R> | R,
    signal?: AbortSignal,
  ): Promise<R> {
    const lease = await this.acquire(signal);
    try {
      return await fn(lease.value);
    } finally {
      lease.release();
    }
  }

  /**
   * Stop refilling, reject pending waiters, and dispose every idle resource.
   * Leases already checked out are the caller's responsibility; releasing them
   * afterwards still disposes them correctly.
   */
  async close(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }

    const error = reason ?? new Error("WarmPool is closed");
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);

    const idle = this.#ready.splice(0);
    await Promise.allSettled([
      ...idle.map((value) => this.#retire(value)),
      ...this.#inFlight,
    ]);
  }

  // ---------------------------------------------------------------- internals

  /** Hand out what's ready, then refill every free slot. */
  #pump(): void {
    if (this.#closed) return;

    while (this.#ready.length > 0 && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      const value = this.#ready.shift()!;
      this.#inUse++;
      waiter.resolve(value);
    }

    // #alive already counts in-flight creations, so this never over-spawns.
    for (let slots = this.#max - this.#alive; slots > 0; slots--) this.#spawn();
  }

  #spawn(): void {
    this.#creating++;

    const task = (async () => {
      try {
        const value = await this.#create();
        this.#creating--;

        if (this.#closed) {
          await this.#retire(value);
          return;
        }
        this.#ready.push(value);
        this.#pump();
      } catch (error) {
        this.#creating--;
        this.#onError?.(error, "create");

        // Don't strand a caller behind a factory that keeps failing.
        this.#waiters.shift()?.reject(error);
        this.#scheduleRetry();
      }
    })();

    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer !== undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#pump();
    }, this.#retryDelayMs);
    // Don't hold a Node process open just to keep the pool full.
    (this.#retryTimer as unknown as { unref?(): void }).unref?.();
  }

  async #retire(value: T): Promise<void> {
    this.#disposing++;
    try {
      await value.dispose();
    } catch (error) {
      this.#onError?.(error, "dispose");
    } finally {
      this.#disposing--;
      this.#pump();
    }
  }

  #lease(value: T): Lease<T> {
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      this.#inUse--;
      void this.#retire(value);
    };

    const lease: Lease<T> = {
      value,
      get released() {
        return released;
      },
      release,
    };

    // Enables `using lease = await pool.acquire()` where supported.
    const dispose = (Symbol as { dispose?: symbol }).dispose;
    if (dispose) Object.defineProperty(lease, dispose, { value: release });

    return lease;
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Aborted");
}
