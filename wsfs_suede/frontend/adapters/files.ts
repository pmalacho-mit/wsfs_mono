/**
 * The editor's view of the workspace.
 *
 * `FileProvider` wants paths and text and nothing else, which is most of what
 * makes it a good seam: the editor never learns that entries have ids, tokens,
 * or a queue behind them. What it does learn, promptly, is that a file changed
 * -- so imports resolve against what the tree actually holds rather than
 * against whatever was there when the editor mounted.
 */
import type { FileOverride } from ".";
import { textOf } from "../content";
import type { Path } from "../paths";
import type { Workspace } from "../workspace";

export type Change = { path: Path; kind: "added" | "changed" | "removed" };
export type Listener = (change: Change) => void;
export type Unsubscribe = () => void;

export type FileProvider = {
  paths: () => Iterable<Path>;
  read: (path: Path) => Promise<string>;
  write: (path: Path, text: string) => Promise<void>;
  watch: (listen: Listener) => Unsubscribe;
};

const changesBetween = (before: Set<Path>, after: Set<Path>): Change[] => [
  ...[...after].filter((path) => !before.has(path)).map(added),
  ...[...before].filter((path) => !after.has(path)).map(removed),
];

const added = (path: Path): Change => ({ path, kind: "added" });
const removed = (path: Path): Change => ({ path, kind: "removed" });

/**
 * Files only. A folder is implied by what lives in it, and an editor's
 * filesystem refuses to hold a directory that was registered as a file --
 * which is what `notes/` becomes the moment anything is created inside it.
 */
const files = (workspace: Workspace): Path[] => {
  const index = workspace.index();
  return index.paths().filter((path) => index.at(path)?.type === "file");
};

export const provider = (
  workspace: Workspace,
  fileOverride?: FileOverride,
): FileProvider => ({
  paths: () => files(workspace),

  read: async (path) => {
    const override = fileOverride?.get(path);
    if (override !== undefined) return override;
    const held = await workspace.read(path);
    if (held === undefined) throw new Error(`No such file: ${path}`);
    return textOf(held);
  },

  write: async (path, text) => {
    if (await fileOverride?.put(path, text)) return;
    void (await workspace.write(path, text).settled);
  },

  /**
   * Only appearances and disappearances are announced. Content changes reach
   * the editor through the document it holds open, and announcing them here
   * too would ask it to reload a buffer somebody is typing into.
   */
  watch: (listen) => {
    let known = new Set(files(workspace));
    return workspace.watch(() => {
      const now = new Set(files(workspace));
      changesBetween(known, now).forEach(listen);
      known = now;
    });
  },
});
