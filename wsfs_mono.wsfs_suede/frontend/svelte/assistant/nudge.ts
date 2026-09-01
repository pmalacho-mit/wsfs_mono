/**
 * The offer of help, and how long it is allowed to stay on screen.
 *
 * It withdraws itself the moment the person starts working again, because
 * somebody who is editing is no longer stuck -- and an offer that outlives the
 * state it was describing is just something else to dismiss.
 *
 * BUT NOT INSTANTLY, and that is the whole of `atLeast`. The cooldown starts
 * when the episode is DETECTED, not when the prompt is read, so a student who
 * happened to be mid-keystroke used to see the banner appear and vanish inside
 * one frame -- and then wait out twenty minutes of cooldown for an offer they
 * never had the chance to refuse. The study records that episode as `offered`
 * either way, so the arm it lands in has to mean something: an offer is only
 * declined if it was there long enough to decline.
 *
 * NOTHING HERE READS A CLOCK FOR ITSELF -- same reason as `stuck.ts`. Both the
 * time and the way of waiting are handed in, so a floor measured in seconds is
 * tested in milliseconds.
 */
import { toast } from "svelte-sonner";

/**
 * THE PROTOCOL'S OWN WORDING, and it is not decoration.
 *
 * "Looks like you're stuck" tells a student that a system has decided
 * something about them, which is a worse thing to read than an offer -- the
 * same argument `Workspace.svelte` makes about how the question is phrased
 * when they take it. What is being measured is whether they WANT help, and a
 * prompt that opens by diagnosing them is measuring something else.
 */
const OFFER = "Want a hint?";
const TAKE = "Yes, show me";

/**
 * The shortest an offer may be on screen before working can take it away.
 *
 * Long enough to be read and short enough not to be in the way. It bounds
 * only the withdrawal: `forMs` still decides when the offer goes of its own
 * accord, and taking it still ends it at once.
 */
export const AT_LEAST = 1_500;

type Wiring = {
  now?: () => number;
  /** How to wait. Handed in so a test can say when the waiting is over. */
  after?: (ms: number, done: () => void) => () => void;
};

const LATER = (ms: number, done: () => void) => {
  const timer = setTimeout(done, ms);
  return () => clearTimeout(timer);
};

export class Nudge {
  #now: () => number;
  #after: NonNullable<Wiring["after"]>;

  #showing: string | number | undefined;
  #shownAt = 0;
  #floor = 0;
  /** Cancels a withdrawal that is waiting for the floor to pass. */
  #waiting: (() => void) | undefined;

  constructor(wiring: Wiring = {}) {
    this.#now = wiring.now ?? (() => Date.now());
    this.#after = wiring.after ?? LATER;
  }

  /** Whether the offer is on screen right now. */
  get offered(): boolean {
    return this.#showing !== undefined;
  }

  /**
   * `forMs` rather than forever.
   *
   * A proactive prompt is meant to be small and non-blocking: it says its
   * piece and goes, whether or not anybody looked at it. One that waits
   * indefinitely stops being an offer and becomes something else on screen to
   * deal with -- and the protocol counts an ignored offer as an answer, which
   * it cannot do if the offer never ends.
   */
  offer(
    help: () => void,
    forMs = Number.POSITIVE_INFINITY,
    atLeast = AT_LEAST,
  ) {
    /** `close` and not `withdraw`: a new offer replaces the old one now, and
     *  does not queue behind the old one's floor. */
    this.close();
    this.#shownAt = this.#now();
    /** Never past the offer's own end -- a floor longer than `forMs` would
     *  otherwise schedule a withdrawal for a banner that had already gone. */
    this.#floor = Math.max(0, Math.min(atLeast, forMs));
    this.#showing = toast(OFFER, {
      duration: forMs,
      action: {
        label: TAKE,
        onClick: () => {
          /** Taking it is the person's own answer, so nothing holds it back:
           *  the floor is there to stop an offer being snatched away, not to
           *  stop it being accepted. */
          this.close();
          help();
        },
      },
      onDismiss: () => this.#gone(),
      onAutoClose: () => this.#gone(),
    });
  }

  /**
   * The person is working again, so the offer has served its purpose.
   *
   * Honoured no sooner than the floor. Called again while one withdrawal is
   * already waiting, it changes nothing -- the first keystroke is what
   * decided this, and the tenth should not push the moment back.
   */
  withdraw() {
    if (this.#showing === undefined || this.#waiting !== undefined) return;
    const left = this.#floor - (this.#now() - this.#shownAt);
    if (left <= 0) return this.close();
    this.#waiting = this.#after(left, () => {
      this.#waiting = undefined;
      this.close();
    });
  }

  /**
   * Off the screen now, whatever the floor says.
   *
   * For a new offer taking this one's place, for the person accepting it, and
   * for the panel going away -- none of which are the case the floor is for.
   */
  close() {
    this.#waiting?.();
    this.#waiting = undefined;
    if (this.#showing === undefined) return;
    const showing = this.#showing;
    this.#showing = undefined;
    toast.dismiss(showing);
  }

  /** The toast ended on its own, or somebody dismissed it by hand. */
  #gone() {
    this.#waiting?.();
    this.#waiting = undefined;
    this.#showing = undefined;
  }
}
