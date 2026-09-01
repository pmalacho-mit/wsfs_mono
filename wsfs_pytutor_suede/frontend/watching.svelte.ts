/**
 * Watching somebody work: the rules, the offer protocol, and the record.
 *
 * Everything a component would otherwise have to hold at once -- when to look
 * at the clock, whether a detection may become a prompt, what to write down
 * about it, and what to say on the person's behalf when they take it -- lives
 * here, so the shell that draws a workspace can hand this three callbacks and
 * forget about it.
 *
 * NOTHING HERE READS A CLOCK OR TOSSES A COIN FOR ITSELF: `Stuck` is handed
 * both, so a twenty-minute cooldown is tested in twenty milliseconds and the
 * coin lands where the test says.
 */
import { mint } from "../../wsfs_core_suede/frontend";

import { Activity } from "./activity";
import { Nudge } from "./nudge";
import {
  deadlinesIn,
  settingsFrom,
  settingsWith,
  Stuck,
  tickFor,
  type Configured,
  type Episode,
  type Looking,
  type Ran,
  type Settings,
} from "./stuck";
import type { Tutoring } from "./tutoring";

export type WatchingOptions = {
  /** Which workspace this is, for the cooldown a browser was left holding. */
  workspace: string;
  /** Where episodes, offers and activity are posted. */
  study: Tutoring;
  /** What this course was set up to run. Absent means `DEFAULTS`. */
  protocol?: Configured;
  /** Which sitting of which course this is, as the host names it. */
  courseEvent?: string;
  /** What the person is looking at, whenever a rule asks. */
  looking: Looking;
  /** The problem a file is an answer to, if anybody wrote one down. */
  goalFor: (path: string) => string | undefined;
  /** Ask for help on the person's behalf, when they take the offer. */
  ask: (question: string) => void;
  /**
   * Every episode, whatever became of it.
   *
   * Handed out rather than sent anywhere, because the ones that were
   * randomized into silence are the half a study cannot do without.
   */
  onEpisode?: (episode: Episode) => void;
};

export class Watching {
  readonly nudge = new Nudge();
  readonly settings: Settings;

  #stuck: Stuck;
  #activity: Activity;
  #ticking: ReturnType<typeof setInterval>;
  #options: WatchingOptions;

  constructor(options: WatchingOptions) {
    this.#options = options;
    this.settings = settingsFrom(searchOfThisPage(), settingsWith(options.protocol));
    this.#activity = new Activity({ flush: (batch, closing) => this.#flush(batch, closing) });
    this.#stuck = this.#watcher();
    this.#ticking = setInterval(() => this.#tick(), tickFor(this.settings));
  }

  /** Anything the person did. Resets the idle clock and goes in the window. */
  acted(kind: string, detail: Record<string, unknown> = {}) {
    this.#stuck.acted();
    this.#activity.note(kind, detail);
  }

  /** A run ended. The only thing that can fire the repeated-error rule. */
  ran(outcome: Ran) {
    if (outcome.ok) this.nudge.withdraw();
    this.#activity.note("ran", {
      ok: outcome.ok,
      ...(outcome.ok ? {} : { because: outcome.because?.slice(0, 2_000) }),
    });
    this.#stuck.ran(outcome);
  }

  /** Typing is the clearest evidence somebody is not stuck. */
  typed() {
    this.nudge.withdraw();
  }

  /** The last flush of an open window, as the page goes. */
  closing() {
    this.#activity.close();
  }

  stop() {
    clearInterval(this.#ticking);
    this.#stuck.stop();
    this.#activity.dispose();
    this.nudge.close();
  }

  #tick() {
    this.#stuck.check();
    this.#activity.check();
  }

  #watcher() {
    const { workspace, looking, goalFor, study } = this.#options;
    const deadlines = deadlinesIn(workspace);
    return new Stuck({
      settings: this.settings,
      resume: deadlines.read(),
      remember: deadlines.write,
      offer: (episode, forMs) =>
        this.nudge.offer(
          () => this.#offerTaken(episode),
          forMs,
          this.settings.floor,
        ),
      record: (episode) => this.#record(episode),
      looking,
      goalFor,
      judging: (asking) => study.progressing(asking),
    });
  }

  /**
   * TAKING THE OFFER IS A FACT ABOUT THE STUDENT, and it is recorded before
   * the question goes anywhere: what is being measured is whether they
   * accepted, not whether the tutor answered.
   */
  #offerTaken(episode: Episode) {
    void this.#postOffer(episode);
    this.acted("offer accepted", { episode: episode.id });
    this.#options.ask(questionFor(episode));
  }

  #record(episode: Episode) {
    announce(episode, this.settings);
    this.#options.onEpisode?.(episode);
    /**
     * The window opens for BOTH arms, which is the whole comparison -- and
     * only for episodes that opened one, so a detection held back by a
     * cooldown cannot start a second recording inside the first.
     */
    if (episode.window) this.#activity.open(episode.id, episode.window.until);
    this.#activity.note("stuck", {
      episode: episode.id,
      rule: episode.rule,
      became: episode.became,
    });
    void this.#postEpisode(episode);
  }

  /**
   * The study's records, posted and forgotten.
   *
   * Caught, every one of them: an unhandled rejection here would be a study's
   * bookkeeping showing up as an error in a student's console.
   */
  #postEpisode(episode: Episode) {
    const { study, courseEvent } = this.#options;
    return study.study
      .detected({
        episode: episode.id,
        at: asIso(episode.at),
        rule: episode.rule,
        became: episode.became,
        /**
         * TRIMMED TO WHAT THE CONTRACT ACCEPTS. A refused body is a lost
         * episode, and a student with a very long path or a very large file
         * is exactly the student a study should not quietly drop.
         */
        detail: episode.detail.slice(0, 2_000),
        course_event: courseEvent?.slice(0, 200) ?? null,
        entry: episode.code?.entry ?? null,
        path: episode.code?.path.slice(0, 1_000) ?? null,
        code: episode.code?.text.slice(0, 400_000) ?? null,
        cooldown: spanOf(episode.cooldown),
        window: spanOf(episode.window),
      })
      .catch(ignored);
  }

  #postOffer(episode: Episode) {
    const { study, courseEvent } = this.#options;
    return study.study
      .accepted({
        offer: mint(),
        episode: episode.id,
        at: new Date().toISOString(),
        course_event: courseEvent?.slice(0, 200) ?? null,
        entry: episode.code?.entry ?? null,
      })
      .catch(ignored);
  }

  #flush(
    { episode, moments }: { episode: string; moments: { at: number; kind: string }[] },
    closing: boolean,
  ) {
    return this.#options.study.study.activity(
      {
        episode,
        moments: moments.map(({ at, ...rest }) => ({
          ...rest,
          at: asIso(at),
        })),
      },
      /** The last batch is often sent as the page is going away, and an
       *  ordinary fetch dies with the document. */
      { keepalive: closing },
    );
  }
}

const ignored = () => undefined;
const asIso = (at: number) => new Date(at).toISOString();

const spanOf = (span: { from: number; until: number } | undefined) =>
  span ? { began: asIso(span.from), ends: asIso(span.until) } : null;

const searchOfThisPage = () =>
  typeof window === "undefined" ? "" : window.location.search;

/**
 * What the person is asked on their behalf, given why they look stuck.
 *
 * Phrased as THEM asking, because that is what the panel will show and what
 * the tutor will answer -- and because a question that opens by telling
 * somebody a system decided they were stuck is a worse question.
 */
const questionFor = (episode: Episode) => {
  if (episode.rule === "the same error twice")
    return `I keep getting the same error -- ${episode.detail}. Can you help me work out why?`;
  if (episode.rule === "no progress")
    return "I think I am stuck on this. Can you point me at what to try next?";
  return "I am not sure what to do next here. Can you help me get started?";
};

/**
 * EVERY DETECTION, IN THE CONSOLE, whatever became of it.
 *
 * The protocol's difficulty is that most of what it does is INVISIBLE. A
 * detection randomized into silence, one that arrived during a cooldown and
 * one that never happened at all look identical from the outside -- like
 * nothing. Somebody watching a student over their shoulder, or checking that
 * `?nudge.idle=10` did what they asked, needs the ones that never reach a
 * screen and, for each, which rule held it back.
 *
 * `console.info` rather than `console.error`: none of this is wrong, and a
 * student's console should not say it is.
 */
const announce = (episode: Episode, settings: Settings) =>
  console.info(
    `[stuck] ${episode.rule} (${episode.detail}) -- ${whyItWentThatWay(episode, settings)}`,
    {
      episode: episode.id,
      at: onTheClock(episode.at),
      became: episode.became,
      path: episode.code?.path,
      window: spanOnTheClock(episode.window),
      cooldown: spanOnTheClock(episode.cooldown),
    },
  );

const whyItWentThatWay = (episode: Episode, settings: Settings) => {
  if (episode.became === "offered") return "PROMPTING";
  if (episode.became === "silent")
    return `no prompt -- the coin said silent (offer rate ${settings.offerRate})`;
  if (episode.became === "held back by the cooldown")
    return "no prompt -- a cooldown is running";
  return "no prompt -- a post-episode window is open";
};

const onTheClock = (at: number) =>
  at === 0 ? "never" : new Date(at).toLocaleTimeString();

const spanOnTheClock = (span: { from: number; until: number } | undefined) =>
  span ? `${onTheClock(span.from)} to ${onTheClock(span.until)}` : "none";
