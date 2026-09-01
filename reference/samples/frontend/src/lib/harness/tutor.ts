/**
 * A tutor for a panel test: says what the test told it to, at once.
 *
 * WHY NOT THE REAL ONE. The sample host answers with an actual model when it
 * has a key, which is what somebody opening the app wants and the opposite of
 * what a suite wants: every run would cost money and no two would say the same
 * thing. What these tests are about is the panel -- that a question appears,
 * that an answer streams into it, that scrolling back asks for more -- and
 * every one of those is true whoever is answering.
 *
 * The wire itself is tested where it can be tested honestly: against a
 * scripted tutor in `tests/tutor.py`, over real HTTP.
 */
import type { Turn, Workspace } from "$wsfs";

export type Scripted = {
  /** Just enough of a workspace for `Conversation`. */
  workspace: Pick<Workspace, "tutor">;
  /** What the next answer will be, one delta at a time. */
  says: (...deltas: string[]) => void;
  /** And how it will end, if it ends badly. */
  fails: (why: string | undefined) => void;
  /** Everything that has been asked, in order. */
  asked: () => { text: string; attached: number; snapshot: string | null }[];
  /** Every read of the transcript, by the cursor it asked from. */
  reads: () => (string | undefined)[];
  /** Make the next `n` transcript reads fail, as a flaky load would. */
  breaks: (n: number) => void;
};

export const scripted = (told: Turn[] = [], more = false): Scripted => {
  let deltas: string[] = ["Because the loop never ends."];
  let failure: string | undefined;
  const asked: { text: string; attached: number; snapshot: string | null }[] = [];
  const reads: (string | undefined)[] = [];
  let broken = 0;
  const answers = new Map<string, { deltas: string[]; failure?: string }>();
  let next = 0;

  return {
    says: (...said) => (deltas = said),
    fails: (why) => (failure = why),
    asked: () => asked,
    reads: () => reads,
    breaks: (n) => (broken = n),
    workspace: {
      tutor: {
        ask: async (asking) => {
          const message = asking.message ?? `asked-${next}`;
          const token = `token-${next++}`;
          asked.push({
            text: asking.text,
            attached: asking.attached?.length ?? 0,
            snapshot: asking.snapshot ?? null,
          });
          answers.set(token, { deltas: [...deltas], failure });
          return { message, token };
        },
        hear: async function* (token) {
          const held = answers.get(token) ?? { deltas: [] };
          let text = "";
          for (const delta of held.deltas) {
            text += delta;
            yield { type: "delta" as const, delta, text: "", failure: null };
            /** A frame between them, so a test can watch it arrive. */
            await new Promise((carry) => setTimeout(carry, 10));
          }
          yield {
            type: "ended" as const,
            delta: "",
            text,
            failure: held.failure ?? null,
          };
        },
        /** Not what these tests are about; the nudge has its own. */
        progressing: async () => ({ progressing: true, why: "" }),
        said: async ({ before }) => {
          reads.push(before);
          if (broken > 0) {
            broken -= 1;
            throw new Error("the transcript could not be read");
          }
          return {
          /** One page, and then whatever the test said comes before it. */
            turns: before === undefined ? told : [],
            more: before === undefined ? more : false,
          };
        },
      },
    } as Pick<Workspace, "tutor">,
  };
};
