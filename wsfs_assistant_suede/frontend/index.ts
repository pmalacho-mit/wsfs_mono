/**
 * Getting a language model involved with a wsfs workspace.
 *
 * TWO OBJECTS, NOT ONE. `connect` from core gives you a filesystem; `assistant`
 * gives you a conversation about one. They are two because they are two
 * packages -- core exposing an extension slot on `Workspace` would be core
 * knowing that satellites exist, which is the boundary the split is about.
 *
 * ```ts
 * const workspace = connect({ workspace: id, transport });
 * const chat = assistant(workspace, { base, authorize });
 * ```
 */
export { assistant } from "./assistant";
export type { Assistant, Attachable } from "./assistant";

export type {
  Answering,
  Asked,
  Asking,
  Attached,
  Attaching,
  Executed,
  Id,
  Transcript,
  Turn,
} from "./contract";

/** The panel, and the transcript state behind it. */
export { default as AssistantPanel } from "./svelte/Assistant.svelte";
export { default as AttachedFiles } from "./svelte/AttachedFiles.svelte";
export { Conversation } from "./svelte/conversation.svelte";
