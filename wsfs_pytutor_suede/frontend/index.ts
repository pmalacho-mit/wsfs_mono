/**
 * The embedded tutor for Python development, client side.
 *
 * NOT `pytutor_llms`. That is a generic model-provider wrapper with nothing to
 * do with tutoring, and nothing here imports it -- every model call goes
 * through the assistant's `ITutor` on the server. The two names will be
 * confused; see the README.
 *
 * THE HALVES ARE KEPT APART on purpose. `Stuck` is a set of rules about what a
 * person has been doing; the offer protocol laid over it -- a coin toss, a
 * cooldown, a window -- decides whether a detection is allowed to become a
 * prompt. Every detection is recorded either way, including the ones that
 * never reach a screen.
 */
export { tutoring } from "./tutoring";
export type { Tutoring, Watched } from "./tutoring";

export type {
  Accepted,
  Detected,
  Judged,
  Judging,
  Moment,
  Recorded,
  Span,
} from "./contract";

/** Noticing that somebody is stuck, and deciding whether to say anything. */
export {
  DEFAULTS,
  Stuck,
  UNREADABLE,
  deadlinesIn,
  errorNamed,
  settingsFrom,
  settingsWith,
  tickFor,
} from "./stuck";
export type {
  Became,
  Configured,
  Deadlines,
  Episode,
  Looking,
  Ran,
  Rule,
  Settings,
} from "./stuck";

/** The offer itself, as a toast the person can take or ignore. */
export { Nudge } from "./nudge";

/** What a student did inside a post-episode window. */
export { Activity } from "./activity";

/**
 * The application: `wsfs_svelte_suede`'s shell with Python in it and a tutor
 * beside it. This is the only package that may depend on all four, which is
 * why the composition lives here rather than in any of them.
 */
export { default as Workspace, Model } from "./Workspace.svelte";
export { default as WorkspacePane } from "./WorkspacePane.svelte";
export { default as PythonFile } from "./PythonFile.svelte";
export { default as ProblemHeader } from "./ProblemHeader.svelte";

/** Watching somebody work: the rules, the offer protocol, and the record. */
export { Watching } from "./watching.svelte";
export type { WatchingOptions } from "./watching.svelte";

/**
 * The problem a file is an answer to, keyed by the file's name.
 *
 * TEMPORARY, and it says so where it lives: the workspace holds programs, not
 * what somebody was asked to write. Until that has a home of its own -- an
 * assignment manifest, whatever a course tool hands over -- it is a table
 * here, which is why it is this package's and not the filesystem's.
 */
export { headerFor, setHeaderFor } from "./headers";
