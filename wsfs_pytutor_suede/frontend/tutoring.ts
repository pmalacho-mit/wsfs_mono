/**
 * The tutoring feature's own routes, composed beside a workspace.
 *
 * TWO KINDS OF REQUEST, and the difference between them is the whole design.
 * `progressing` is a measurement somebody is waiting on. The three `study`
 * calls are observations of a term: POSTED AND FORGOTTEN, with no outbox
 * behind them and none intended -- losing a write loses a student's program,
 * and losing one of these loses one data point. Paying for the second with the
 * machinery that guarantees the first would be paying with the editor's
 * responsiveness. See the backend's `study.py`.
 */
import {
  offset,
  requesting,
  type Authorized,
} from "../../wsfs_core_suede/frontend";

import type {
  Accepted,
  Detected,
  Id,
  Judged,
  Judging,
  Recorded,
} from "./contract";

/** The half of core's `Workspace` this package reaches for. */
export type Watched = { id: Id };

export type Tutoring = {
  /**
   * Whether a program has moved toward its goal since a few minutes ago.
   *
   * NOT a conversation: no transcript goes in and none comes out. It is one
   * measurement, asked on a timer by whatever is watching somebody work.
   */
  progressing: (asking: Judging) => Promise<Judged>;
  /**
   * The study's three write-only routes.
   *
   * The promises still reject, so a caller that wants to know can look;
   * nothing in this codebase does anything but ignore them.
   *
   * `keepalive` is for the last flush of a window, which happens as a page is
   * going away: an ordinary fetch is cancelled with the document, and ten
   * minutes of recording would be lost at the last hurdle.
   */
  study: {
    detected: (told: Detected) => Promise<void>;
    accepted: (told: Accepted) => Promise<void>;
    activity: (
      told: Recorded,
      options?: { keepalive?: boolean },
    ) => Promise<void>;
  };
};

export const tutoring = (
  workspace: Watched,
  { base, authorize }: { base: string; authorize: Authorized },
): Tutoring => {
  const { workspaces, posted, json } = requesting(base, authorize);
  const here = workspaces(workspace.id);

  /** The clock is filled in here when a caller does not, like everywhere else. */
  const timed = <T extends { offset?: number | null }>(told: T) => ({
    ...told,
    offset: told.offset ?? offset(),
  });

  return {
    progressing: async (asking) =>
      json<Judged>(await posted(`${here}/progress`, asking)),

    study: {
      detected: async (told) => {
        await posted(`${here}/study/episodes`, timed(told));
      },
      accepted: async (told) => {
        await posted(`${here}/study/offers`, timed(told));
      },
      activity: async (told, { keepalive = false } = {}) => {
        await posted(`${here}/study/activity`, told, { keepalive });
      },
    },
  };
};
