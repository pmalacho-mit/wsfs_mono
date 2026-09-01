import { describe, expect, it, vi } from "vitest";

import { provider } from "../../release/frontend/adapters/files";
import { filesystem } from "../../release/frontend/adapters/kernel";
import type { Metadata } from "../../release/frontend/contract";
import { mint } from "../../release/frontend/identity";
import { mintedAt } from "../../release/frontend/minted";
import * as paths from "../../release/frontend/paths";
import type { Workspace } from "../../release/frontend/workspace";

/** A server-accepted moment. These fixtures are about what changes, not when. */
const SETTLED = new Date("2026-01-01T00:00:00Z").toISOString();

const entry = (name: string, over: Partial<Metadata> = {}): Metadata => {
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

/** A workspace stub: the adapters are translations, so what they translate
 *  from can be a map without changing what is under test. */
const standing = (entries: Metadata[]) => {
  const view = new Map(entries.map((e) => [e.id, e]));
  const listeners = new Set<() => void>();
  /** A mutator hands its transaction back at once, and its answer later. */
  const submitting = () => ({
    transaction: mint(),
    settled: Promise.resolve({ rejected: false } as const),
  });
  const creating = () => ({ entry: mint(), ...submitting() });
  const calls = {
    move: vi.fn(submitting),
    remove: vi.fn(submitting),
    write: vi.fn(submitting),
    create: vi.fn(creating),
    folder: vi.fn(creating),
  };
  const workspace = {
    entries: () => view,
    index: () => paths.index(view),
    watch: (changed: () => void) => (listeners.add(changed), () => listeners.delete(changed)),
    read: async (path: string) => {
      const found = paths.index(view).at(path);
      return found === undefined ? undefined : { kind: "text" as const, text: `in ${found.name}` };
    },
    holding: (path: string) => {
      const found = paths.index(view).at(path);
      return found === undefined ? undefined : { kind: "text" as const, text: `in ${found.name}` };
    },
    ...calls,
  } as unknown as Workspace;
  return { workspace, calls, announce: () => listeners.forEach((l) => l()), view };
};

describe("the editor's provider", () => {
  it("offers the paths the workspace currently holds", () => {
    const { workspace } = standing([entry("a.py"), entry("b.py")]);
    expect([...provider(workspace).paths()].sort()).toEqual(["a.py", "b.py"]);
  });

  it("announces appearances and disappearances, not content", () => {
    const src = entry("src", { type: "folder" });
    const { workspace, view, announce } = standing([src]);
    const seen: string[] = [];
    provider(workspace).watch(({ path, kind }) => seen.push(`${kind} ${path}`));

    const added = entry("new.py", { parent: src.id });
    view.set(added.id, added);
    announce();
    view.delete(added.id);
    announce();

    expect(seen).toEqual(["added src/new.py", "removed src/new.py"]);
  });
});

describe("the kernel's filesystem", () => {
  it("marks a folder as a directory and a file as its contents", async () => {
    const src = entry("src", { type: "folder" });
    const file = entry("main.py", { parent: src.id });
    const fs = filesystem(standing([src, file]).workspace);

    expect(await fs.get("src")).toEqual({ directory: true });
    expect(await fs.get("src/main.py")).toBe("in main.py");
    expect(await fs.get("nowhere.py")).toBeUndefined();
  });

  it("lists a folder by name, not by path", async () => {
    const src = entry("src", { type: "folder" });
    const fs = filesystem(
      standing([src, entry("one.py", { parent: src.id }), entry("two.py", { parent: src.id })])
        .workspace,
    );
    expect((await fs.listDirectory("src"))!.sort()).toEqual(["one.py", "two.py"]);
  });

  it("answers stat from what is already in hand", async () => {
    const fs = filesystem(standing([entry("main.py")]).workspace);
    expect(await fs.stat("main.py")).toEqual({ size: "in main.py".length, directory: false });
  });

  it("turns a move into one transaction", async () => {
    const { workspace, calls } = standing([entry("a.py")]);
    await filesystem(workspace).move({ from: "a.py", to: "b.py" });
    expect(calls.move).toHaveBeenCalledWith("a.py", "b.py");
  });
});
