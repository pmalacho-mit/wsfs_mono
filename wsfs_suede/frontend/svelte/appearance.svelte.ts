/**
 * Which way the shell paints.
 *
 * The grid, the dock and the tree each draw their own chrome and each has to
 * be told; they live in different panels, so the answer cannot be a prop
 * threaded through one of them. One matcher, read by whoever needs it.
 *
 * What it resolves to is mode-watcher's business: the system's preference
 * until somebody overrides it, and their override -- kept in local storage --
 * from then on. `<ModeWatcher />` is what puts the answer on the document,
 * which is how the stylesheet's `.dark` variant sees it.
 */
import { mode } from "mode-watcher";
import type { Theme } from "../../../wsfs_suede.dockview-svelte-suede";
import type { Name as TreeTheme } from "../../../wsfs_suede.pierre-trees-svelte-suede/themes";

export const appearance = {
  get dark(): boolean {
    return mode.current === "dark";
  },

  /** The dock's and the tree's chrome. */
  get theme(): Theme {
    return appearance.dark ? "githubDark" : "githubLight";
  },

  /** The tree wears its own catalogue, matched to the dock's. */
  get treeTheme(): TreeTheme {
    return appearance.dark ? "github-dark" : "github-light";
  },
};
