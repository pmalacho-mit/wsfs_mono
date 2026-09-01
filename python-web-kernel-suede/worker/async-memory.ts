/**
 * One-way memory, can block a web worker until data from the main thread arrives.
 *
 * Web Worker Usage:
 * 1. Lock "web worker"
 * 2. Set "shared memory signal"
 * 3. Notify main thread (Main thread does stuff)
 * 4. Wait for "shared memory signal"
 * 5. Read size buffer
 * 6. Read shared memory
 * 7. If the size buffer was bigger than the read memory size
 * 7.1. Set "shared memory signal"
 * 7.2. Notify main thread (Main thread writes remaining data to shared memory)
 * 7.3. Wait for "shared memory signal"
 * 7.4. Read shared memory
 * 7.5. Go back to step 7. (loop)
 * 8. Unlock "web worker"
 *
 * Main Thread Usage:
 * 1. Get notification
 * 2. Do operations
 * 3. Serialize data
 * 4. Write size into the size buffer
 * 5. Write partial data into shared memory
 * 6. Unlock "shared memory signal" (Worker does stuff)
 * 7. If not everything has been written to the shared memory yet
 * 7.1. Get notification
 * 7.2. Write partial data into shared memory
 * 7.3. Unlock "shared memory signal" (Worker does stuff)
 * 7.4. Go back to step 7. (loop)
 */
export class AsyncMemory {
  // Reference: https://v8.dev/features/atomics
  static LOCK_WORKER_INDEX = 0;
  static LOCK_SIZE_INDEX = 2;
  static SIZE_INDEX = 4;
  static REQUEST_INDEX = 6;
  static ANSWER_INDEX = 7;
  static UNLOCKED = 0;
  static LOCKED = 1;

  static readonly SIGINT = 2 as const;

  readonly sharedLock: SharedArrayBuffer;
  readonly lockAndSize: Int32Array;

  readonly sharedMemory: SharedArrayBuffer;
  readonly memory: Uint8Array;

  readonly interruptBuffer: SharedArrayBuffer;
  readonly interrupter: Uint8Array;

  /**
   * Payloads larger than this are transferred one slice at a time, so the
   * default is generous enough that ordinary files cross in a single trip.
   */
  static readonly DEFAULT_CAPACITY = 1024 * 1024;
  static readonly MINIMUM_CAPACITY = 1024;

  constructor({
    sharedLock,
    sharedMemory,
    interruptBuffer,
    capacity = AsyncMemory.DEFAULT_CAPACITY,
  }: Partial<AsyncMemory.Buffers> & { capacity?: number } = {}) {
    this.sharedLock =
      sharedLock ?? new SharedArrayBuffer(8 * Int32Array.BYTES_PER_ELEMENT);
    this.lockAndSize = new Int32Array(this.sharedLock);
    if (this.lockAndSize.length < 8) {
      throw new Error("Expected an sharedLock with at least 8x32 bytes");
    }

    this.sharedMemory = sharedMemory ?? new SharedArrayBuffer(capacity);
    this.memory = new Uint8Array(this.sharedMemory);

    if (this.sharedMemory.byteLength < AsyncMemory.MINIMUM_CAPACITY) {
      throw new Error(
        `Expected an sharedMemory with at least ${AsyncMemory.MINIMUM_CAPACITY} bytes`,
      );
    }

    this.interruptBuffer = interruptBuffer ?? new SharedArrayBuffer(1);
    this.interrupter = new Uint8Array(this.interruptBuffer);
  }

  get buffers(): AsyncMemory.Buffers {
    const { sharedLock, sharedMemory, interruptBuffer } = this;
    return { sharedLock, sharedMemory, interruptBuffer };
  }

  /**
   * Should be called from the worker thread
   */
  lockWorker() {
    const oldValue = Atomics.compareExchange(
      this.lockAndSize,
      AsyncMemory.LOCK_WORKER_INDEX,
      AsyncMemory.UNLOCKED, // old value
      AsyncMemory.LOCKED, // new value
    );
    if (oldValue !== AsyncMemory.UNLOCKED) {
      throw new Error(
        `Cannot lock worker, the worker has to be unlocked ${AsyncMemory.UNLOCKED} !== ${oldValue}`,
      );
    }
  }

  /**
   * Should be called from the worker thread
   */
  lockSize() {
    const oldValue = Atomics.compareExchange(
      this.lockAndSize,
      AsyncMemory.LOCK_SIZE_INDEX,
      AsyncMemory.UNLOCKED, // old value
      AsyncMemory.LOCKED, // new value
    );
    if (oldValue !== AsyncMemory.UNLOCKED) {
      throw new Error(
        `Cannot set size flag, the size has to be unlocked ${AsyncMemory.UNLOCKED} !== ${oldValue}`,
      );
    }
  }

  /**
   * Only legal if the worker is locked.
   * @param timeout How long to wait before reporting back, in milliseconds.
   * @returns Whether the wait ended because an answer arrived or because the
   * time ran out.
   */
  waitForSize(timeout = Infinity) {
    return Atomics.wait(
      this.lockAndSize,
      AsyncMemory.LOCK_SIZE_INDEX,
      AsyncMemory.LOCKED,
      timeout,
    );
  }

  /**
   * Claims the next request. An answer written for an earlier one is stale: the
   * worker has stopped waiting for it and may already be waiting for another.
   */
  beginRequest() {
    return Atomics.add(this.lockAndSize, AsyncMemory.REQUEST_INDEX, 1) + 1;
  }

  /** The request the worker is waiting on, if it is waiting on one. */
  get request() {
    return Atomics.load(this.lockAndSize, AsyncMemory.REQUEST_INDEX);
  }

  /**
   * Stops waiting on the current request. Whatever number comes next, it will
   * not be this one, so an answer that arrives late is recognisably stale.
   */
  endRequest() {
    Atomics.add(this.lockAndSize, AsyncMemory.REQUEST_INDEX, 1);
  }

  /**
   * Which request the payload in shared memory answers.
   *
   * Checking the token before writing is not enough on its own: the worker can
   * give up and ask something else while the host is still copying, so what it
   * finds on waking has to say what it belongs to.
   */
  writeAnswer(request: number) {
    Atomics.store(this.lockAndSize, AsyncMemory.ANSWER_INDEX, request);
  }

  get answer() {
    return Atomics.load(this.lockAndSize, AsyncMemory.ANSWER_INDEX);
  }

  isAwaiting(request: number) {
    return (
      Atomics.load(this.lockAndSize, AsyncMemory.REQUEST_INDEX) === request
    );
  }

  get interrupted() {
    return this.interrupter[0] !== 0;
  }

  /**
   * Should be called from the main thread!
   * Only legal if the worker is locked and the size is locked
   */
  writeSize(value: number) {
    return Atomics.store(this.lockAndSize, AsyncMemory.SIZE_INDEX, value);
  }

  /**
   * Only legal if the worker is locked but the size is not
   */
  readSize(): number {
    return Atomics.load(this.lockAndSize, AsyncMemory.SIZE_INDEX);
  }

  /**
   * Should be called from the main thread!
   * @returns Whether anything was waiting on it. A size that was already
   * unlocked means the worker stopped waiting, which is a thing the host has to
   * cope with rather than an invariant it can rely on.
   */
  unlockSize() {
    const oldValue = Atomics.compareExchange(
      this.lockAndSize,
      AsyncMemory.LOCK_SIZE_INDEX,
      AsyncMemory.LOCKED, // old value
      AsyncMemory.UNLOCKED, // new value
    );
    Atomics.notify(this.lockAndSize, AsyncMemory.LOCK_SIZE_INDEX);
    return oldValue === AsyncMemory.LOCKED;
  }

  /**
   * Ensures that the size gets unlocked
   */
  forceUnlockSize() {
    const oldValue = Atomics.compareExchange(
      this.lockAndSize,
      AsyncMemory.LOCK_SIZE_INDEX,
      AsyncMemory.LOCKED, // old value
      AsyncMemory.UNLOCKED, // new value
    );
    if (oldValue != AsyncMemory.LOCKED) {
      // And force unlock it
      Atomics.store(
        this.lockAndSize,
        AsyncMemory.LOCK_SIZE_INDEX,
        AsyncMemory.UNLOCKED,
      );
    }
    Atomics.notify(this.lockAndSize, AsyncMemory.LOCK_SIZE_INDEX);
  }

  /**
   * Should be called from the worker thread!
   */
  unlockWorker() {
    const oldValue = Atomics.compareExchange(
      this.lockAndSize,
      AsyncMemory.LOCK_WORKER_INDEX,
      AsyncMemory.LOCKED, // old value
      AsyncMemory.UNLOCKED, // new value
    );
    if (oldValue != AsyncMemory.LOCKED) {
      throw new Error("Tried to unlock, but was already unlocked");
    }
    Atomics.notify(this.lockAndSize, AsyncMemory.LOCK_WORKER_INDEX);
  }

  /**
   * Frees the worker lock however it was left. Unlike {@link unlockWorker}
   * this is legal when nothing held it, which is the usual case when a kernel
   * is disposed of between runs.
   */
  forceUnlockWorker() {
    Atomics.store(
      this.lockAndSize,
      AsyncMemory.LOCK_WORKER_INDEX,
      AsyncMemory.UNLOCKED,
    );
    Atomics.notify(this.lockAndSize, AsyncMemory.LOCK_WORKER_INDEX);
  }

  interrupt(code = AsyncMemory.SIGINT) {
    this.interrupter[0] = code;
  }

  clearInterrupt() {
    this.interrupter[0] = 0;
  }

  dispose() {
    this.forceUnlockSize();
    this.forceUnlockWorker();
  }
}

export namespace AsyncMemory {
  /** The shared buffers both threads have to agree on to talk to each other. */
  export type Buffers = {
    sharedLock: SharedArrayBuffer;
    sharedMemory: SharedArrayBuffer;
    interruptBuffer: SharedArrayBuffer;
  };
}
