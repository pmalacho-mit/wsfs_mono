/**
 * The transcript, as the panel shows it and as the server holds it.
 *
 * ONE LIST, TWO SOURCES. What was said before this page existed is read back
 * a page at a time; what is being said now arrives delta by delta. They meet
 * in `turns`, so the panel draws one thing and never has to know which half a
 * line came from.
 *
 * NOTHING HERE IS THE RECORD. The server writes the question down when it is
 * asked and the answer when it finishes, whether or not this panel is still
 * open -- so losing the stream loses the live text and nothing else. That is
 * why `reload` exists and why failing to hear an answer is not an error worth
 * showing: the transcript has it.
 */
import type { ChatStatus } from "../shadcn/ai-elements/prompt-input";
import type { Attaching, Id, Turn as Told, Workspace } from "../../";
export type Turn = {
  id: string;
  from: "user" | "assistant";
  text: string;
  /** The paths sent along with it. Only ever set on a question. */
  sent: string[];
  /** Set on an answer that never finished, so the panel can say so. */
  failed?: string;
};

/** What a question carries: the files on screen, and what has been run. */
export type Attachment = { entry: Id; path: string; executions: string[] };

const PAGE = 10;

/** How many goes a transcript read gets before the panel says it failed. */
const TRIES = 3;
const BACKOFF_MS = 400;

/**
 * A turn's two halves, as the panel draws them.
 *
 * A question and its answer are one row on the server -- there is exactly one
 * answer per question -- and two bubbles on screen. Splitting here rather than
 * in the panel keeps the panel a list.
 */
const shown = (told: Told, paths: (entry: string) => string): Turn[] => {
  const sent = (told.attached ?? []).map((one) => paths(one.entry));
  const turns: Turn[] = [
    { id: `${told.message}:asked`, from: "user", text: told.text, sent },
  ];
  if (told.answer || told.failure)
    turns.push({
      id: `${told.message}:answered`,
      from: "assistant",
      text: told.answer ?? "",
      sent: [],
      ...(told.failure ? { failed: told.failure } : {}),
    });
  return turns;
};

export class Conversation {
  turns = $state<Turn[]>([]);
  status = $state<ChatStatus>("ready");

  /** Whether anything older is worth asking for. Drives the scroll-back. */
  more = $state(false);
  /** True while a page of older turns is on its way. */
  reading = $state(false);

  /**
   * Why the transcript could not be read, if it could not be.
   *
   * SHOWN RATHER THAN SWALLOWED. This used to be a bare `catch {}`, on the
   * reasoning that a panel with no history still works -- which is true and
   * beside the point: the failure is indistinguishable from having never said
   * anything, so a person whose conversation is right there on the server
   * sees an empty panel and concludes it was lost. One failed read at load
   * used to mean empty for the life of the tab.
   */
  failed = $state<string | undefined>(undefined);

  #workspace: Workspace | undefined;
  #named: (entry: string) => string = (entry) => entry;
  #oldest: string | undefined;
  #gone = false;

  /**
   * Where the questions go.
   *
   * Handed in rather than constructed, because a panel with no workspace yet
   * is an ordinary state -- the shell builds this before it has connected --
   * and a transcript that cannot be asked for is still a transcript.
   */
  attach(workspace: Workspace, named: (entry: string) => string) {
    this.#workspace = workspace;
    this.#named = named;
    void this.reload();
  }

  /**
   * The most recent turns, replacing whatever is shown.
   *
   * TRIED MORE THAN ONCE. This runs as the workspace is opening, alongside
   * everything else a page does on load, and one read losing that race left
   * the panel empty with nothing to say and nothing that would ask again.
   * Whatever is still wrong after a few goes is reported, and `failed` is
   * what the panel offers a retry from.
   */
  async reload() {
    const workspace = this.#workspace;
    if (workspace === undefined || this.reading) return;
    this.reading = true;
    this.failed = undefined;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const said = await workspace.tutor.said({ limit: PAGE });
          if (this.#gone) return;
          this.turns = this.#drawn(said.turns);
          this.more = said.more;
          this.#oldest = said.turns.at(-1)?.at.accepted ?? undefined;
          return;
        } catch (reason) {
          if (this.#gone) return;
          if (attempt >= TRIES - 1) {
            this.failed =
              reason instanceof Error ? reason.message : String(reason);
            return;
          }
          await new Promise((carry) =>
            setTimeout(carry, BACKOFF_MS * (attempt + 1)),
          );
          if (this.#gone) return;
        }
      }
    } finally {
      this.reading = false;
    }
  }

  /** One page further back. What scrolling to the top asks for. */
  async earlier() {
    const workspace = this.#workspace;
    if (workspace === undefined || this.reading || !this.more) return;
    this.reading = true;
    try {
      const said = await workspace.tutor.said({
        before: this.#oldest,
        limit: PAGE,
      });
      if (this.#gone) return;
      this.turns = [...this.#drawn(said.turns), ...this.turns];
      this.more = said.more;
      this.#oldest = said.turns.at(-1)?.at.accepted ?? this.#oldest;
    } catch (reason) {
      /** Leave what is already shown, and say why there is no more of it. */
      this.failed = reason instanceof Error ? reason.message : String(reason);
    } finally {
      this.reading = false;
    }
  }

  /**
   * Ask, and show the answer as it is written.
   *
   * The question appears immediately and is never taken back: it was asked,
   * the server has it, and a panel that hid it again on a slow answer would be
   * lying about what happened.
   */
  async ask(
    text: string,
    attached: Attachment[],
    system: string,
    snapshot?: string,
  ) {
    const asked = text.trim();
    const workspace = this.#workspace;
    if (asked === "" || this.status !== "ready" || workspace === undefined)
      return;

    const sent = attached.map((one) => one.path);
    this.status = "submitted";
    const mine = `asking-${this.turns.length}`;
    this.turns = [...this.turns, { id: mine, from: "user", text: asked, sent }];

    try {
      const { message, token } = await workspace.tutor.ask({
        system,
        text: asked,
        snapshot: snapshot ?? null,
        attached: attached.map(
          ({ entry, executions }): Attaching => ({ entry, executions }),
        ),
      });
      if (this.#gone) return;
      this.#rename(mine, `${message}:asked`);
      await this.#hear(workspace, token, message);
    } catch (reason) {
      if (this.#gone) return;
      this.#answered(
        "asking",
        "",
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      if (!this.#gone) this.status = "ready";
    }
  }

  /** Whether anything is waiting on a reply, which is what the loader shows. */
  get pending(): boolean {
    return this.status === "submitted";
  }

  dispose() {
    this.#gone = true;
  }

  async #hear(workspace: Workspace, token: string, message: string) {
    const id = `${message}:answered`;
    let text = "";
    for await (const said of workspace.tutor.hear(token)) {
      if (this.#gone) return;
      if (said.type === "delta") {
        this.status = "streaming";
        text += said.delta;
        this.#answered(id, text, undefined);
        continue;
      }
      /**
       * `ended` carries the whole answer, so what is shown is the server's
       * copy rather than whatever this client managed to assemble.
       */
      this.#answered(id, said.text, said.failure ?? undefined);
    }
  }

  #answered(id: string, text: string, failed: string | undefined) {
    const at = this.turns.findIndex((turn) => turn.id === id);
    const turn: Turn = {
      id,
      from: "assistant",
      text,
      sent: [],
      ...(failed ? { failed } : {}),
    };
    this.turns =
      at === -1
        ? [...this.turns, turn]
        : this.turns.map((held, i) => (i === at ? turn : held));
  }

  #rename(from: string, to: string) {
    this.turns = this.turns.map((turn) =>
      turn.id === from ? { ...turn, id: to } : turn,
    );
  }

  #drawn(told: Told[]): Turn[] {
    /** Newest first on the wire, oldest first on screen. */
    return [...told].reverse().flatMap((one) => shown(one, this.#named));
  }
}
