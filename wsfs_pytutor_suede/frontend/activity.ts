/**
 * What a student did in the ten minutes after they were noticed.
 *
 * The protocol's whole comparison lives in this window: an episode randomized
 * into an offer and one randomized into silence are followed by the same
 * fixed stretch, and what separates them is what the person did in it. The
 * measures anybody will want later -- did they fix the error, did the code
 * move, how long until a run worked, did they open the chat -- are all
 * DERIVED, so what is recorded here is deliberately raw and deliberately
 * over-complete. Ten minutes of one student's keystrokes is a rounding error
 * next to the cost of discovering next term that the one event you needed was
 * the one nobody wrote down.
 *
 * ONLY WHILE A WINDOW IS OPEN. Armed by an episode, disarmed when its window
 * closes, and silent the rest of the time -- which is nearly all of it.
 *
 * BUFFERED AND FLUSHED, not sent per event. A keystroke is not worth a
 * request, and a network that is down is not worth losing typing over. Each
 * moment carries its own timestamp for exactly that reason: when it was
 * recorded is a fact about the student, and when it was sent is a fact about
 * the network.
 *
 * NOTHING HERE READS A CLOCK FOR ITSELF -- same reason as `stuck.ts`.
 */

/** One thing that happened, with the moment it happened at. */
export type Moment = {
  /** Epoch milliseconds. Set when the moment is NOTED, never when it is sent. */
  at: number;
  kind: string;
} & Record<string, unknown>;

export type Batch = { episode: string; moments: Moment[] };

type Wiring = {
  /**
   * Send one batch somewhere.
   *
   * ALLOWED TO FAIL, and failing costs the batch. This is telemetry for a
   * study, not a student's work: the filesystem has an outbox because losing
   * a keystroke loses their program, and nothing here is their program. A
   * retry queue that grew without bound would be a worse bug than a gap.
   */
  flush: (batch: Batch, closing: boolean) => Promise<unknown>;
  now?: () => number;
  /** How long to buffer before sending. */
  every?: number;
  /** Send early once this many moments are waiting, whatever the clock says. */
  cap?: number;
  /** The most moments one window may record, after which it stops. */
  limit?: number;
};

const EVERY = 15_000;
const CAP = 250;
/**
 * A ceiling per window, because a runaway is possible and a browser tab is
 * not the place to find out. Ten minutes of hard typing is a few thousand
 * moments; twenty thousand is somebody's autoclicker.
 */
const LIMIT = 20_000;

export class Activity {
  #wiring: Wiring;
  #now: () => number;

  #episode: string | undefined;
  #until = 0;
  #moments: Moment[] = [];
  #sentAt = 0;
  #noted = 0;
  #sending = false;
  #dropped = 0;

  constructor(wiring: Wiring) {
    this.#wiring = wiring;
    this.#now = wiring.now ?? (() => Date.now());
  }

  /** The episode being recorded for, if any. */
  get recording(): string | undefined {
    return this.#episode;
  }

  /**
   * Start recording for one episode, until the moment its window closes.
   *
   * A SECOND CALL WHILE ONE IS STILL RUNNING IS IGNORED, which is the
   * protocol's "overlapping post-episode windows are not created" said in the
   * one place that would otherwise create one. The episode being recorded is
   * the one whose window is open; a detection inside it was held back and has
   * no window of its own.
   *
   * STILL RUNNING, and not merely still here. A window that has passed its
   * end and has not been swept up yet is not a window -- it is bookkeeping
   * waiting for the next tick, and the caller's tick asks the rules BEFORE it
   * asks this. So a detection that lands in the gap between a window ending
   * and being closed used to be turned away by the corpse of the one before
   * it: the server was told a window had opened, and the client recorded
   * nothing in it for ten minutes. An empty window and an idle student are
   * indistinguishable in the data, which is the worst way for this to fail.
   *
   * So the old one is closed here rather than refused, which also sends what
   * it was holding.
   */
  open(episode: string, until: number): void {
    if (this.#episode !== undefined) {
      if (this.#now() < this.#until) return;
      this.close();
    }
    this.#episode = episode;
    this.#until = until;
    this.#moments = [];
    this.#noted = 0;
    this.#dropped = 0;
    this.#sentAt = this.#now();
  }

  /**
   * Write down one thing, if anybody is listening.
   *
   * Cheap to call from anywhere, including from paths that run on every
   * keystroke: outside a window it is a comparison against `undefined`.
   */
  note(kind: string, what: Record<string, unknown> = {}): void {
    if (this.#episode === undefined) return;
    if (this.#noted >= (this.#wiring.limit ?? LIMIT)) {
      this.#dropped += 1;
      return;
    }
    this.#noted += 1;
    /**
     * `at` and `kind` LAST, so a payload carrying its own `at` -- an edit's
     * offset into the document, say -- cannot overwrite the moment it
     * happened at. The timestamp is the one thing here nobody else may set.
     */
    this.#moments.push({ ...what, at: this.#now(), kind });
    if (this.#moments.length >= (this.#wiring.cap ?? CAP)) void this.#send();
  }

  /**
   * A pass over the clock: send if it is time, and close if the window is up.
   *
   * Driven from the caller's tick rather than a timer of its own, for the
   * reason `Stuck.check` gives -- and because one interval that does both is
   * one thing to stop when the panel goes away.
   */
  check(): void {
    if (this.#episode === undefined) return;
    const at = this.#now();
    if (at >= this.#until) return void this.close();
    if (at - this.#sentAt >= (this.#wiring.every ?? EVERY)) void this.#send();
  }

  /** Send what is waiting and stop recording. */
  close(): void {
    const episode = this.#episode;
    if (episode === undefined) return;
    /**
     * The last batch says how much it could not hold, because a window that
     * hit the ceiling and one that was quiet look identical otherwise.
     */
    if (this.#dropped > 0)
      this.#moments.push({
        at: this.#now(),
        kind: "dropped",
        moments: this.#dropped,
      });
    this.#episode = undefined;
    this.#until = 0;
    /**
     * `closing` is passed on because the last flush of a window often happens
     * as the page is going away, and a request that is cancelled with the
     * document takes ten minutes of recording with it. What to do about that
     * is the caller's -- see `keepalive` on the transport.
     */
    void this.#send(episode, true);
  }

  /** The panel is going away. Whatever is buffered gets one last go. */
  dispose(): void {
    this.close();
  }

  /**
   * ONE REQUEST AT A TIME, and the buffer is only emptied once the request
   * that carries it has been made. Two flushes racing would interleave
   * batches that each claim to be in order, and a batch handed to a call that
   * never happened is a batch nobody has.
   */
  async #send(episode = this.#episode, closing = false): Promise<void> {
    if (episode === undefined || this.#sending) return;
    const moments = this.#moments;
    if (moments.length === 0) return;
    this.#moments = [];
    this.#sentAt = this.#now();
    this.#sending = true;
    try {
      await this.#wiring.flush({ episode, moments }, closing);
    } catch {
      /** Gone, on purpose. See the note on `flush`. */
    } finally {
      this.#sending = false;
    }
  }
}
