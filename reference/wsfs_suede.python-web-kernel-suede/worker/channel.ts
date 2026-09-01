import type { AsyncMemory } from "./async-memory";

/**
 * Divides a payload into the largest slices the shared memory can hold. Both
 * threads derive the same slices from the payload size, so no chunk headers
 * have to travel with the data.
 */
const slices = (total: number, capacity: number) => ({
  count: Math.max(1, Math.ceil(total / capacity)),
  start: (index: number) => index * capacity,
  end: (index: number) => Math.min(total, (index + 1) * capacity),
});

export type ChannelChunkMessage = {
  /** Sent by the worker to ask the host for the next slice of a payload. */
  channel_chunk: {};
};

/** Thrown when the worker stops waiting for an answer that never came. */
export class UnansweredError extends Error {
  override name = "UnansweredError";
}

/** Thrown when the worker gives up waiting because Python was interrupted. */
export class InterruptedError extends Error {
  override name = "InterruptedError";
}

export type Patience = {
  /** How long to wait before looking up to check on things, in milliseconds. */
  interval: number;
  /** How long to keep waiting in total before giving up, in milliseconds. */
  limit: number;
};

export const DEFAULT_PATIENCE: Patience = {
  interval: 250,
  limit: 5 * 60 * 1000,
};

/**
 * Writes payloads into shared memory for a worker that is blocked waiting on
 * them. Runs on the thread that owns the objects, usually the main thread.
 */
export class ChannelHost {
  private pending?: { payload: Uint8Array; sent: number; request: number };

  constructor(readonly memory: AsyncMemory) {}

  /**
   * @param request Which request this answers. An answer to a request the
   * worker has stopped waiting for is dropped rather than written, so it cannot
   * land on top of whatever the worker is waiting for now.
   */
  send(payload: Uint8Array, request: number) {
    if (!this.memory.isAwaiting(request)) return;
    this.pending = { payload, sent: 0, request };
    this.memory.writeSize(payload.byteLength);
    this.flushNextSlice();
  }

  /** Answers a worker's request for the next slice of the payload in flight. */
  sendNextChunk() {
    if (!this.pending)
      return console.warn("No payload in flight to continue writing");
    if (!this.memory.isAwaiting(this.pending.request)) return this.abandon();
    this.flushNextSlice();
  }

  private abandon() {
    this.pending = undefined;
  }

  private flushNextSlice() {
    const { payload, sent, request } = this.pending!;
    const slice = slices(payload.byteLength, this.memory.memory.byteLength);
    this.memory.memory.set(
      payload.subarray(slice.start(sent), slice.end(sent)),
    );
    this.pending =
      sent + 1 < slice.count ? { payload, sent: sent + 1, request } : undefined;

    /** The worker can stop waiting between the check and the write. */
    this.memory.writeAnswer(request);
    if (!this.memory.unlockSize()) this.abandon();
  }
}

/**
 * Blocks this thread until the host has written a whole payload into shared
 * memory. Must run on a worker thread.
 */
export class ChannelWorker {
  constructor(
    readonly memory: AsyncMemory,
    private readonly requestNextChunk: () => void,
    private readonly patience: Patience = DEFAULT_PATIENCE,
  ) {}

  /**
   * Sends a request to the host and blocks until its whole response has been
   * copied out of shared memory.
   */
  request(send: () => void): Uint8Array {
    const { memory } = this;
    try {
      memory.lockWorker();
      memory.lockSize();
      memory.writeSize(0);
      const request = memory.beginRequest();
      send();
      this.awaitAnswer(request);
      return this.receive(request);
    } finally {
      memory.endRequest();
      memory.forceUnlockSize();
      memory.unlockWorker();
    }
  }

  /**
   * Parking forever on a host that never answers would be unrecoverable: the
   * thread is asleep rather than running Python, so nothing else can notice.
   * Surfacing after a while lets the interrupt be seen and turned into an
   * exception Python can catch.
   */
  private awaitAnswer(request: number) {
    const { interval, limit } = this.patience;
    for (let waited = 0; waited < limit; waited += interval) {
      if (this.memory.waitForSize(interval) === "timed-out") {
        if (this.memory.interrupted)
          throw new InterruptedError("Interrupted while waiting for the host");
        continue;
      }
      if (this.memory.answer === request) return;
      /** An answer to something this worker already gave up on. Keep waiting. */
      this.memory.lockSize();
    }
    throw new UnansweredError(`The host did not answer within ${limit}ms`);
  }

  private receive(request: number) {
    const total = this.memory.readSize();
    const slice = slices(total, this.memory.memory.byteLength);
    const payload = new Uint8Array(total);
    for (let index = 0; index < slice.count; index++) {
      if (index > 0) this.awaitNextChunk(request);
      const [start, end] = [slice.start(index), slice.end(index)];
      payload.set(this.memory.memory.subarray(0, end - start), start);
    }
    return payload;
  }

  private awaitNextChunk(request: number) {
    this.memory.lockSize();
    this.requestNextChunk();
    this.awaitAnswer(request);
  }
}
