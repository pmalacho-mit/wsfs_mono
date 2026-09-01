/**
 * The kernel's view of the workspace.
 *
 * Python blocks while these are answered, so every one of them is served from
 * state the client already holds: stream events prefetch content as they
 * arrive, and an open file is answered by its document rather than by anything
 * that was written down. What Python reads is what the editor shows.
 */
import type {
  FileSystem,
  Contents,
} from "../../../wsfs_suede.python-web-kernel-suede";
import type { Metadata } from "../contract";
import type { Path } from "../paths";
import type { Workspace } from "../workspace";
import type { FileOverride } from ".";

const DIRECTORY = { directory: true } as const;

/**
 * What bytes from the kernel are called. Python hands `put` a path and a
 * value and says nothing about type, so guessing a better one here would be
 * inventing a fact rather than carrying one.
 */
const OPAQUE = "application/octet-stream";

const sized = (held: Contents) =>
  typeof held === "string"
    ? new TextEncoder().encode(held).byteLength
    : held.byteLength;

export const filesystem = (
  workspace: Workspace,
  fileOverride?: FileOverride,
): FileSystem.CreateReadWrite => {
  const entryAt = (path: Path): Metadata | undefined =>
    workspace.index().at(path);

  const contentsOf = async (path: Path): Promise<Contents | undefined> => {
    const held = (await workspace.read(path)) ?? undefined;
    if (held === undefined) return undefined;
    return held.kind === "text" ? held.text : held.bytes;
  };

  return {
    get: async (path) => {
      const entry = entryAt(path);
      if (entry === undefined) return undefined;
      if (entry.type === "folder") return DIRECTORY;
      return fileOverride?.get(path) ?? contentsOf(path);
    },

    listDirectory: async (path) => {
      const holder = path === "" ? undefined : entryAt(path);
      if (path !== "" && holder?.type !== "folder") return undefined;
      return workspace
        .index()
        .under(path)
        .map((entry) => entry.name);
    },

    /**
     * Answered from what is in hand, which is why the prefetch exists. Falling
     * through to a read here would make `os.stat` cost a round trip.
     */
    stat: async (path) => {
      const entry = entryAt(path);
      if (entry === undefined) return undefined;
      if (entry.type === "folder") return { size: 0, directory: true };

      const override = fileOverride?.get(path);
      if (override !== undefined)
        return { size: sized(override), directory: false };

      const held = workspace.holding(path);
      return held === undefined
        ? undefined
        : {
            size: sized(held.kind === "text" ? held.text : held.bytes),
            directory: false,
          };
    },

    put: async (path, value) => {
      // The filesystem's caller waits for the server's answer, because a
      // script that writes a file and reads it back expects to be told.
      if (value === null) {
        await workspace.folder(path).settled;
        return;
      }
      /**
       * Through the door first, both ways. A script writing a file somebody
       * has open is the commonest way a shared document gets left describing
       * a file that has moved on, and it is the one case a client can fix at
       * the source rather than repair afterwards.
       */
      const taken =
        typeof value === "string"
          ? await fileOverride?.put(path, value)
          : await fileOverride?.replaced?.(path, value, OPAQUE);
      if (taken) return;
      await workspace.write(path, value).settled;
    },

    move: async ({ from, to }) => void (await workspace.move(from, to).settled),

    delete: async (path) => void (await workspace.remove(path).settled),
  };
};
