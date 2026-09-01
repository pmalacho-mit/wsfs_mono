import { describe, expect, it } from "vitest";

import * as confirmed from "../../release/frontend/confirmed";
import type { Metadata } from "../../release/frontend/contract";
import * as effective from "../../release/frontend/effective";
import { mint } from "../../release/frontend/identity";
import { mintedAt } from "../../release/frontend/minted";
import { index } from "../../release/frontend/paths";

/** A server-accepted moment. These fixtures are about what changes, not when. */
const SETTLED = new Date("2026-01-01T00:00:00Z").toISOString();

const at = (name: string, over: Partial<Metadata> = {}): Metadata => {
  const born = mint();
  return {
    id: mint(),
    type: "file",
    name,
    parent: null,
    name_version: born,
    parent_version: born,
    deleted_version: born,
    content_version: born,
    modified: { minted: mintedAt(born)!.toISOString(), accepted: SETTLED },
    ...over,
  };
};

const viewOf = (...entries: Metadata[]) =>
  effective.of(confirmed.snapshot(entries), []).view;

describe("paths over an id-addressed tree", () => {
  it("builds a path by walking to the root", () => {
    const src = at("src", { type: "folder" });
    const deep = at("deep", { type: "folder", parent: src.id });
    const file = at("main.py", { parent: deep.id });

    const paths = index(viewOf(src, deep, file));

    expect(paths.of(file.id)).toBe("src/deep/main.py");
    expect(paths.at("src/deep/main.py")!.id).toBe(file.id);
  });

  it("gives a tombstone no path at all", () => {
    const file = at("gone.py", { deleted: true });
    expect(index(viewOf(file)).of(file.id)).toBeUndefined();
  });

  it("takes the paths of a deleted folder's contents, not their rows", () => {
    const src = at("src", { type: "folder", deleted: true });
    const file = at("main.py", { parent: src.id });

    const view = viewOf(src, file);
    const paths = index(view);

    expect(paths.of(file.id)).toBeUndefined();
    expect(view.get(file.id)).toBeDefined();
  });

  it("lists what a folder holds", () => {
    const src = at("src", { type: "folder" });
    const one = at("one.py", { parent: src.id });
    const two = at("two.py", { parent: src.id });
    at("elsewhere.py");

    const held = index(viewOf(src, one, two)).under("src");

    expect(held.map((entry) => entry.name).sort()).toEqual(["one.py", "two.py"]);
  });

  it("survives a parent cycle rather than walking forever", () => {
    const first = at("a", { type: "folder" });
    const second = at("b", { type: "folder", parent: first.id });
    const cyclic = { ...first, parent: second.id };

    expect(() => index(viewOf(cyclic, second))).not.toThrow();
  });
});
