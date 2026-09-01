/**
 * The tutor, composed beside a workspace rather than hung off it.
 *
 * `connect` gives you a filesystem; this gives you a conversation about one.
 * They are two objects because they are two packages: core exposing an
 * extension slot on `Workspace` would be core knowing that satellites exist,
 * which is the boundary this arrangement is about.
 *
 * WHAT IT TAKES FROM THE WORKSPACE is two things and no more: which workspace
 * this is, and the ability to record what the user was looking at when they
 * asked. `snapshot` stays core's -- it is a transaction, it travels through
 * the outbox, and "what was on screen when X happened" is not a model's idea.
 */
import {
  mint,
  offset,
  requesting,
  lines,
  paged,
  type Authorized,
} from "../../wsfs_core_suede/frontend";

import type {
  Answering,
  Asked,
  Asking,
  Id,
  Transcript,
} from "./contract";

/** The half of core's `Workspace` this package reaches for. */
export type Attachable = {
  id: Id;
  snapshot: (entries: Id[]) => { transaction: string };
};

export type Assistant = {
  /**
   * Put a question, and be told where to hear the answer.
   *
   * `system`, if sent, is standing instructions for this question -- said
   * after the tutor's own system prompt and before any of the conversation.
   * Per-question and never written down, so a caller that wants it on the
   * next question sends it again. See `Asking.system` on the server.
   */
  ask: (asking: Omit<Asking, "message"> & { message?: Id }) => Promise<Asked>;
  /**
   * The answer, delta by delta, until it ends.
   *
   * An async iterator rather than a subscription, because unlike the event
   * stream this one ENDS and a caller wants to await the end of it.
   */
  hear: (token: string) => AsyncIterable<Answering>;
  /** This person's conversation here, newest first. */
  said: (asking: { before?: string; limit?: number }) => Promise<Transcript>;
};

export const assistant = (
  workspace: Attachable,
  { base, authorize }: { base: string; authorize: Authorized },
): Assistant => {
  const { workspaces, send, posted, json } = requesting(base, authorize);
  const here = workspaces(workspace.id);

  return {
    ask: async (asking) =>
      json<Asked>(
        await posted(`${here}/chat`, {
          ...asking,
          /** Minted here when a caller does not, so a retry is free. */
          message: asking.message ?? mint(),
          offset: asking.offset ?? offset(),
        }),
      ),

    hear: async function* (token) {
      const response = await send(
        `${here}/chat/stream?token=${encodeURIComponent(token)}`,
      );
      yield* lines<Answering>(response, (said) => said.type === "ended");
    },

    said: async (asking) =>
      json<Transcript>(await send(`${here}/chat?${paged(asking)}`)),
  };
};
