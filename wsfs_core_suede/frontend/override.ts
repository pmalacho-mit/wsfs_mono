/**
 * The door every write to a file goes through.
 *
 * A shared document is only the truth about a file while everything that
 * changed that file went through it -- so anything else that writes has to
 * come here first and be given the chance to become an edit rather than a
 * replacement. What actually happens behind this is the consumer's business:
 * this client has no opinion about CRDTs and holds no reference to one.
 *
 * The answer is whether the door took it. `true` means the write has been
 * dealt with and the workspace must not send one; `false` means the ordinary
 * path applies. Nothing here fails a write -- a door that could refuse would
 * be a door that can lose data.
 */
export type FileOverride = {
  /**
   * What this file says right now, if the door is holding it.
   *
   * Synchronous because the kernel's filesystem calls are, and Python blocks
   * on them. A door that would have to fetch answers `undefined`.
   */
  get: (path: string) => string | undefined;

  /**
   * Text becoming the file's content.
   *
   * May be awaited. Turning a write into edits on a shared document can mean
   * waiting for that document to sync first -- and it MUST wait, because
   * editing a document that has not yet received its own content merges the
   * two rather than replacing one with the other.
   */
  put: (path: string, value: string) => boolean | Promise<boolean>;

  /**
   * Bytes replacing a file, when a caller has them.
   *
   * Separate from `put` because it is not the same act. Text can become edits
   * on a document; bytes cannot, so a door taking this is not merging
   * anything -- it is saying the file has stopped being the text somebody had
   * open, and taking responsibility for telling them.
   *
   * Optional. Without it, binary writes go the ordinary way, and a shared
   * document left open over one is stale until something notices.
   */
  replaced?: (
    path: string,
    value: Uint8Array,
    mime: string,
  ) => boolean | Promise<boolean>;
};
