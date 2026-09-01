import type { ContextMenuItem } from "@pierre/trees";
import type { Model } from "./model.svelte";
import { holding } from "./naming";

/**
 * What a file explorer's menu does to the tree, given the item it was opened
 * on. New entries land inside a directory and beside a file, and arrive as
 * DRAFTS -- a row with no name, waiting to be typed into -- so nothing outside
 * the tree ever hears about a placeholder somebody else chose.
 */
export const entries = {
  add(model: Model, item: ContextMenuItem, kind: "file" | "folder") {
    model.draft(holding(item), kind);
  },

  rename(model: Model, item: ContextMenuItem) {
    model.rename(item.path);
  },

  remove(model: Model, item: ContextMenuItem) {
    model.remove(item.path, { recursive: item.kind === "directory" });
  },
};
