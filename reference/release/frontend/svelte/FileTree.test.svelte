<script lang="ts" module>
  import { Sweater } from "../../../../../sweater-vest-suede";
  import FileTree, { Model } from "./FileTree.svelte";
  import { index as indexOf } from "../paths";
  import { setHeaderFor } from "./headers";
  import type { Metadata } from "../contract";

  /**
   * A workspace that holds three entries and refuses every gesture.
   *
   * The panel is what is under test, not the filesystem behind it: every
   * mutation here returns a promise that never settles, so a click that
   * would write is drawn exactly as it is drawn in the app -- the tree moves
   * first, the workspace is told after -- without a server to tell.
   */
  const entryAt = (
    id: string,
    name: string,
    type: "file" | "folder",
    parent: string | null = null,
  ): Metadata => ({
    id,
    name,
    type,
    parent,
    name_version: id,
    parent_version: id,
    deleted_version: id,
    content_version: null,
    modified: null as never,
  });

  const workspaceWith = (view: ReadonlyMap<string, Metadata>) => {
    const pending = () => new Promise<never>(() => {});
    const submitting = () =>
      ({ transaction: "test", settled: pending() }) as never;
    return {
      entries: () => view,
      index: () => indexOf(view),
      watch: () => () => {},
      read: () => pending(),
      create: () => ({ ...submitting(), entry: "new" }) as never,
      folder: () => ({ ...submitting(), entry: "new" }) as never,
      move: submitting,
      remove: submitting,
      room: {
        settle: () => pending(),
        warm: () => pending(),
        stored: () => pending(),
        handOver: () => pending(),
      },
    } as never;
  };

  /** `main.py` beside a `lib/` holding one file, which is enough of both. */
  const workspace = () =>
    workspaceWith(
      new Map([
        ["a", entryAt("a", "main.py", "file")],
        ["b", entryAt("b", "lib", "folder")],
        ["c", entryAt("c", "util.py", "file", "b")],
      ]),
    );

  class Pocket {
    panel = $state<HTMLElement>();
    model = new Model(workspace());
  }

  /**
   * Told at BOTH levels, which is how a consumer is meant to say it: the model
   * so the tree is built without the gestures, the prop so the panel offers
   * nothing that uses them. See `Model.readonly`.
   */
  class SealedPocket {
    panel = $state<HTMLElement>();
    model = new Model(workspace(), { readonly: true });
  }

  /** The tree draws its rows in a shadow root, so nothing finds them by luck. */
  const rows = (panel: HTMLElement): HTMLElement[] => {
    const host = panel.querySelector("file-tree-container");
    const root = host?.shadowRoot;
    if (!root) throw new Error("the tree drew no shadow root");
    return [...root.querySelectorAll<HTMLElement>('[data-type="item"]')];
  };

  const rowFor = (panel: HTMLElement, path: string): HTMLElement => {
    const found = rows(panel).find((row) => row.dataset.itemPath === path);
    if (!found)
      throw new Error(
        `no row for ${path}; the tree drew ${rows(panel)
          .map((row) => row.dataset.itemPath)
          .join(", ")}`,
      );
    return found;
  };

  /**
   * A right click where the row is, as a composed event.
   *
   * `composed` is not decoration: the panel reads `composedPath()` to find
   * which row was clicked, and an event without it never leaves the tree's
   * shadow root to be heard at all.
   */
  const rightClick = (row: HTMLElement) => {
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 8,
        clientY: box.top + box.height / 2,
      }),
    );
  };

  const menuIn = (panel: HTMLElement): HTMLElement | null =>
    panel.querySelector('[data-file-tree-context-menu-root="true"]');

  const labelsIn = (panel: HTMLElement): string[] =>
    [...(menuIn(panel)?.querySelectorAll("button") ?? [])].map((button) =>
      (button.textContent ?? "").trim(),
    );

  /** What the menu SAYS, as opposed to what it offers to do. */
  const notesIn = (panel: HTMLElement): string[] =>
    [...(menuIn(panel)?.querySelectorAll("p") ?? [])].map((note) =>
      (note.textContent ?? "").trim(),
    );

  /** Every label the panel's own chrome offers, menus excluded. */
  const chromeLabels = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll<HTMLElement>("button")]
      .filter((button) => menuIn(panel)?.contains(button) !== true)
      .map((button) => (button.textContent ?? "").trim());

  const buttonNamed = (panel: HTMLElement, label: string): HTMLElement => {
    const found = [...panel.querySelectorAll<HTMLElement>("button")].find(
      (button) => (button.textContent ?? "").trim() === label,
    );
    if (!found) throw new Error(`no button reading "${label}"`);
    return found;
  };
</script>

<!--
  SERIAL, because a draft row is held open by FOCUS.

  Naming a new entry puts a rename input in the tree and focuses it, and a
  document has one focus between all of these. Run in parallel, the click that
  starts the next test blurs the input the last one is still looking at -- the
  tree reads that as a name submitted empty, refuses it ("Name cannot be
  empty") and takes the row away again, so the test that did nothing wrong is
  the one that fails.
-->
<Sweater config orientation="vertical" category="FileTree" mode="serial" />

<Sweater
  name="a folder's menu offers the two that make something inside it"
  id="menu-folder"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "lib/"));
    await harness.delay({ frames: 2 });

    const labels = labelsIn(panel);
    harness.note(`lib/ → ${labels.join(" · ")}`);
    harness.capture("png");

    harness.expect(labels).toContain("New file");
    harness.expect(labels).toContain("New folder");
    harness.expect(labels).toContain("Rename");
    harness.expect(labels).toContain("Delete");
    void pocket;
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a file's menu does not"
  id="menu-file"
  body={async (harness) => {
    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "main.py"));
    await harness.delay({ frames: 2 });

    const labels = labelsIn(panel);
    harness.note(`main.py → ${labels.join(" · ")}`);
    harness.capture("png");

    harness.expect(labels).not.toContain("New file");
    harness.expect(labels).not.toContain("New folder");
    // Still the rest of the menu, so this is a subtraction and not a break.
    harness.expect(labels).toContain("Rename");
    harness.expect(labels).toContain("Download");
    harness.expect(labels).toContain("Delete");
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the menu is a surface rather than a hole"
  id="menu-surface"
  body={async (harness) => {
    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "main.py"));
    await harness.delay({ frames: 2 });

    const menu = menuIn(panel);
    harness.expect(menu).not.toBe(null);
    const painted = getComputedStyle(menu!).backgroundColor;
    harness.note(`background: ${painted}`);
    harness.capture("png");

    // The regression this replaces: a chain that resolved to nothing at all,
    // leaving the rows behind the menu legible through it.
    harness.expect(painted).not.toBe("rgba(0, 0, 0, 0)");
    harness.expect(painted).not.toBe("transparent");
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the top strip names a new file at the root"
  id="strip-new-file"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    const before = rows(panel).length;
    harness.capture("png");

    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(buttonNamed(panel, "New file"));
    });
    await harness.delay({ milliseconds: 150 });

    const host = panel.querySelector("file-tree-container");
    const naming = host?.shadowRoot?.querySelector("[data-item-rename-input]");
    harness.note(`rows ${before} → ${rows(panel).length}, naming: ${!!naming}`);
    harness.capture("png");

    // A draft: one more row than there was, waiting to be typed into.
    harness.expect(rows(panel).length).toBe(before + 1);
    harness.expect(naming).not.toBe(null);
    void pocket;
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="and a new folder beside it"
  id="strip-new-folder"
  body={async (harness) => {
    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    const before = rows(panel).length;

    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(buttonNamed(panel, "New folder"));
    });
    await harness.delay({ milliseconds: 150 });

    const host = panel.querySelector("file-tree-container");
    const naming = host?.shadowRoot?.querySelector("[data-item-rename-input]");
    harness.capture("png");

    harness.expect(rows(panel).length).toBe(before + 1);
    harness.expect(naming).not.toBe(null);
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="read-only offers a file nothing but Download, and says why"
  id="readonly-menu-file"
  body={async (harness) => {
    harness.set(new SealedPocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "main.py"));
    await harness.delay({ frames: 2 });

    const labels = labelsIn(panel);
    const notes = notesIn(panel);
    harness.note(`main.py → ${labels.join(" · ")}`);
    harness.note(`saying → ${notes.join(" / ")}`);
    harness.capture("png");

    harness.expect(labels).toEqual(["Download"]);
    // The whole point of the note: a menu this short has to answer for itself.
    harness.expect(notes.join(" ")).toContain("Read-only");
  }}
>
  {#snippet vest(p: SealedPocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="and offers a folder no more than it offers a file"
  id="readonly-menu-folder"
  body={async (harness) => {
    harness.set(new SealedPocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "lib/"));
    await harness.delay({ frames: 2 });

    const labels = labelsIn(panel);
    harness.note(`lib/ → ${labels.join(" · ")}`);
    harness.capture("png");

    harness.expect(labels).toEqual(["Download"]);
    harness.expect(notesIn(panel).join(" ")).toContain("Read-only");
  }}
>
  {#snippet vest(p: SealedPocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="read-only draws no making pair and no Upload, and says why under the tree"
  id="readonly-chrome"
  body={async (harness) => {
    harness.set(new SealedPocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    const labels = chromeLabels(panel);
    const said = panel.querySelector('[data-region="tree-readonly"]');
    harness.note(`chrome → ${labels.join(" · ")}`);
    harness.note(`under the tree → ${(said?.textContent ?? "").trim()}`);
    harness.capture("png");

    harness.expect(labels).toEqual(["Download"]);
    harness.expect(panel.querySelector('[data-region="tree-new"]')).toBe(null);
    harness.expect(said).not.toBe(null);
    harness.expect((said?.textContent ?? "").trim()).toContain("Read-only");
  }}
>
  {#snippet vest(p: SealedPocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a writable panel still draws all four of its chrome buttons"
  id="writable-chrome"
  body={async (harness) => {
    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    harness.expect(chromeLabels(panel)).toEqual([
      "New file",
      "New folder",
      "Download",
      "Upload",
    ]);
    harness.expect(panel.querySelector('[data-region="tree-readonly"]')).toBe(
      null,
    );
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the prop alone still refuses a drag the tree was never told about"
  id="readonly-prop-only"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    // A model built writable, a panel told read-only: the gesture still
    // exists, so the backstop in the bridge is the only thing refusing it.
    pocket.model.tree.move("main.py", "lib/main.py");
    await harness.delay({ milliseconds: 150 });

    const paths = rows(panel).map((row) => row.dataset.itemPath);
    harness.note(`after a move to lib/ → ${paths.join(", ")}`);
    harness.capture("png");

    harness.expect(paths).toContain("main.py");
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} readonly />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a menu opened with the mouse lights nothing until the mouse is on it"
  id="menu-nothing-lit"
  body={async (harness) => {
    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "main.py"));
    await harness.delay({ frames: 2 });

    const menu = menuIn(panel)!;
    const first = menu.querySelector("button")!;
    const painted = getComputedStyle(first).backgroundColor;
    harness.note(`focused: ${document.activeElement === first}`);
    harness.note(`first item background: ${painted}`);
    harness.capture("png");

    // The first item IS focused -- that is what makes the arrow keys work the
    // moment the menu opens -- and it must not be painted for it. Lighting it
    // on `:focus` left every mouse-opened menu with its first action looking
    // hovered, and a second one lit beside it once the pointer moved.
    harness.expect(document.activeElement).toBe(first);
    harness.expect(painted).toBe("rgba(0, 0, 0, 0)");

    // An arrow key is what makes a highlight worth drawing, and then it
    // follows the keyboard rather than sticking to the first row.
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await harness.delay({ frames: 2 });

    const second = [...menu.querySelectorAll("button")][1]!;
    harness.note(
      `after ArrowDown → first ${getComputedStyle(first).backgroundColor}, second ${getComputedStyle(second).backgroundColor}`,
    );
    harness.expect(document.activeElement).toBe(second);
    harness.expect(getComputedStyle(second).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    harness.expect(getComputedStyle(first).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a file with a problem attached cannot be renamed"
  id="menu-spoken-for"
  body={async (harness) => {
    // The table is by NAME and global to the module, which is exactly why the
    // rename has to go: `main.py` is `main.py` wherever it is, and renaming
    // it is how the question it answers stops being findable.
    setHeaderFor("main.py", "## Write a program that greets somebody");

    harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    rightClick(rowFor(panel, "main.py"));
    await harness.delay({ frames: 2 });

    const labels = labelsIn(panel);
    harness.note(`main.py (has a problem) → ${labels.join(" · ")}`);
    harness.capture("png");

    harness.expect(labels).not.toContain("Rename");
    // Everything else it had is still there, so this is one item removed and
    // not the read-only menu arriving by another route.
    harness.expect(labels).toEqual(["Download", "Delete"]);
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="and the tree's own rename of one is put back"
  id="rename-spoken-for-refused"
  body={async (harness) => {
    setHeaderFor("main.py", "## Write a program that greets somebody");

    const pocket = harness.set(new Pocket());
    const { panel } = await harness.definition("panel");
    await harness.delay({ milliseconds: 250 });

    // Taking Rename out of the menu does not take the gesture off the row.
    // A move that changes the last segment IS a rename, whichever of the
    // tree's two events carries it -- see `renames` in FileTree.svelte.
    pocket.model.tree.move("main.py", "answer.py");
    await harness.delay({ milliseconds: 150 });

    const paths = rows(panel).map((row) => row.dataset.itemPath);
    harness.note(`after a rename → ${paths.join(", ")}`);
    harness.capture("png");

    harness.expect(paths).toContain("main.py");
    harness.expect(paths).not.toContain("answer.py");
  }}
>
  {#snippet vest(p: Pocket)}
    <div bind:this={p.panel} style="height: 320px; width: 260px">
      <FileTree model={p.model} />
    </div>
  {/snippet}
</Sweater>
