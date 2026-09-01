<script lang="ts">
  /**
   * The explorer panel: what its menus offer, and what leaves and enters
   * through them.
   *
   * Split out of `Sample.test.svelte` because it is a different question.
   * That file is about a workspace being edited -- files opened, typed into,
   * renamed, and still right at the other end. This one is about the panel
   * itself: the two directions a copy can travel, the rows the tree chooses
   * to draw, and whether an open menu is actually on top of the page.
   *
   * NOTHING HERE TYPES, and that is what makes the split safe. The report
   * driver opens a tab per component and runs them all at once, so two files
   * are two pages running side by side with only one of them focused -- and a
   * rename input that loses focus mid-word is the failure `Sample.test.svelte`
   * was collapsed into one file to avoid. Every gesture below is a click, a
   * right click, or a file handed straight to an input. If a test here ever
   * needs to type a name, it belongs in that file instead.
   *
   * The other rule of sharing a page still applies: no two tests anywhere may
   * name the same file, because the editor registers a workspace's paths in a
   * filesystem that is global to the page.
   */
  import { Sweater } from "sweater-vest-suede";

  import FileTree, {
    Model as FileTreeModel,
  } from "../../../../release/frontend/svelte/FileTree.svelte";
  import Shell from "../../../../release/frontend/svelte/Workspace.svelte";
  import { drivable, solo } from "./harness/liveblocks";
  import {
    action,
    alongside,
    box,
    drawn,
    laidOut,
    menuAt,
    menuOn,
    menuOnEmptySpace,
    openMenu,
    opened,
    quiet,
    region,
    regions,
    rowFor,
    until,
    type Client,
  } from "./harness/testing.svelte";
  import {
    asPicked,
    choose,
    picker,
    saving,
    unzipped,
  } from "./harness/transfers";

  /** A room with nobody else in it; nothing here asks about sharing. */
  const collaboration = solo();
  const room = drivable(collaboration);

  class Pocket {
    root = $state<HTMLElement>();
    workspace = $state<Client>();
    /** The tree's model, which is what a `FileTree` is given. */
    tree = $state<FileTreeModel>();
  }

  /** Puts a workspace on the screen, with the model the tree renders from. */
  const showing = (pocket: Pocket, workspace: Client) => {
    pocket.tree = new FileTreeModel(workspace.workspace);
    pocket.workspace = workspace;
  };

  /** Wait for a client to hold `path`, whoever's client it is. */
  const holds = (client: Client, path: string) => () =>
    client.paths.includes(path);

  /** The text of a held file, or nothing if the client has not heard of it. */
  const heldBy = (client: Client, path: string) => {
    try {
      const held = client.workspace.holding(path);
      return held?.kind === "text" ? (held.text ?? "") : "";
    } catch {
      return undefined;
    }
  };

  /** The tree's own file picker, which no gesture in a test may really open. */
  const chooser = (root: HTMLElement): HTMLInputElement =>
    root.querySelector<HTMLInputElement>('input[type="file"]')!;

  /** A button in the strip under the tree, by what it reads. */
  const control = (root: HTMLElement, label: string): HTMLButtonElement => {
    const strip = region(root, "tree-actions")!;
    const found = [...strip.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no "${label}" under the tree`);
    return found;
  };

  /**
   * Opens a folder's row, which the tree does not do on its own for an entry
   * that arrived after it was drawn.
   *
   * Cast because `isDirectory()` answers the question without narrowing the
   * handle, and a test is not the place to re-import the helper that does.
   */
  const expand = (model: FileTreeModel, path: string) =>
    (model.tree.item(path) as { expand?: () => void } | null)?.expand?.();

  /** What an archive holds, keyed by name, for an assertion to read. */
  const byName = (members: { name: string; text: string }[]) =>
    Object.fromEntries(members.map((one) => [one.name, one.text]));

  /**
   * A report card gives each test a slice of one screen. The capture is taken
   * of a clone, so telling the clone how tall it is renders the whole thing.
   */
  const tall = { height: 500, style: { height: "500px" } };
</script>

<!-- Stacked and serial, so no two of these drive the same page at once. -->
<Sweater config category="Explorer" orientation="vertical" mode="serial" />

<Sweater
  name="the menu downloads a file, and the copy is what the file says"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("keepsake.md", "remember this\n").settled;
    const { root } = await harness.definition("root");
    await until(
      "the file is drawn",
      () => !!rowFor(root, "keepsake.md"),
      () => drawn(root).join(" | "),
    );

    const kept = saving();
    harness.onAbort(kept.stop);

    await menuOn(rowFor(root, "keepsake.md")!);
    // Captured with the menu open: the action a file's menu now carries.
    void harness.capture("png", tall);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action(root, "Download"));
    });

    await until("a copy to be offered", () => kept.saved().length === 1);
    kept.stop();

    const [copy] = kept.saved();
    harness.expect(copy!.name).toBe("keepsake.md");
    harness.expect(await copy!.blob.text()).toBe("remember this\n");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the menu downloads a folder as an archive of everything under it"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    const client = workspace.workspace;
    await client.folder("bundle").settled;
    await client.create("bundle/one.py", "print('one')\n").settled;
    await client.create("bundle/two.txt", "two\n").settled;
    // An empty folder has no file to imply it, which is the case an archive
    // built from paths alone quietly loses.
    await client.folder("bundle/hollow").settled;

    const { root } = await harness.definition("root");
    await until(
      "the folder is drawn",
      () => !!rowFor(root, "bundle"),
      () => drawn(root).join(" | "),
    );

    const kept = saving();
    harness.onAbort(kept.stop);

    await menuOn(rowFor(root, "bundle")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action(root, "Download"));
    });

    await until("an archive to be offered", () => kept.saved().length === 1);
    kept.stop();

    const [copy] = kept.saved();
    harness.expect(copy!.name).toBe("bundle.zip");

    const held = byName(await unzipped(copy!.blob));
    // The folder itself is in there, so extracting makes one directory
    // rather than scattering its contents.
    harness.expect(Object.keys(held).sort()).toEqual([
      "bundle/",
      "bundle/hollow/",
      "bundle/one.py",
      "bundle/two.txt",
    ]);
    harness.expect(held["bundle/one.py"]).toBe("print('one')\n");
    harness.expect(held["bundle/two.txt"]).toBe("two\n");
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="the tree's own menu downloads the whole workspace, and its button does the same"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    const client = workspace.workspace;
    await client.create("manifest.md", "everything\n").settled;
    await client.folder("vault").settled;
    await client.create("vault/deep.txt", "down here\n").settled;

    const { root } = await harness.definition("root");
    await until(
      "the workspace is drawn",
      () => !!rowFor(root, "manifest.md") && !!rowFor(root, "vault"),
      () => drawn(root).join(" | "),
    );

    const kept = saving();
    harness.onAbort(kept.stop);

    await menuOnEmptySpace(region(root, "tree")!);
    // Captured with the menu open: the four actions the root now offers.
    void harness.capture("png", tall);
    harness.expect(action(root, "Download")).toBeTruthy();
    harness.expect(action(root, "Upload")).toBeTruthy();

    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action(root, "Download"));
    });
    await until("an archive to be offered", () => kept.saved().length === 1);

    const fromMenu = kept.saved()[0]!;
    harness.expect(fromMenu.name).toBe("workspace.zip");
    const held = byName(await unzipped(fromMenu.blob));
    // At the top level, because the workspace has no name to nest under.
    harness.expect(Object.keys(held).sort()).toEqual([
      "manifest.md",
      "vault/",
      "vault/deep.txt",
    ]);
    harness.expect(held["vault/deep.txt"]).toBe("down here\n");

    // And the button under the tree is the same gesture, not a second one.
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(control(root, "Download"));
    });
    await until("a second archive", () => kept.saved().length === 2);
    kept.stop();

    const fromButton = kept.saved()[1]!;
    harness.expect(fromButton.name).toBe("workspace.zip");
    harness.expect(byName(await unzipped(fromButton.blob))).toEqual(held);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="an upload is created the way a typed name is, and the server keeps it"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    // One entry, so there is empty tree below it to open the root menu on.
    await workspace.workspace.create("existing.md", "").settled;
    const { root } = await harness.definition("root");
    await until(
      "the first entry is drawn",
      () => !!rowFor(root, "existing.md"),
      () => drawn(root).join(" | "),
    );

    const console = quiet();
    harness.onAbort(console.stop);
    const asked = picker(chooser(root));
    harness.onAbort(asked.stop);

    // The menu reaches the picker. A REAL click here would open a dialog
    // nothing in a test can answer, so the picker counts instead of opening.
    await menuOnEmptySpace(region(root, "tree")!);
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(action(root, "Upload"));
    });
    harness.expect(asked.asked()).toBe(1);

    // And the button under the tree asks the same picker.
    await harness.withUserFocus(async (userEvent) => {
      await userEvent.click(control(root, "Upload"));
    });
    harness.expect(asked.asked()).toBe(2);

    // What the picker hands back: a file, a folder, and something binary.
    choose(chooser(root), [
      asPicked("uploaded.py", "print('uploaded')\n"),
      asPicked("leaf.md", "# leaf\n", "carton"),
      asPicked("beneath.txt", "under\n", "carton/under"),
      asPicked("blob.bin", new Uint8Array([0, 1, 2, 253, 254, 255])),
    ]);

    for (const path of [
      "uploaded.py",
      "carton/leaf.md",
      "carton/under/beneath.txt",
      "blob.bin",
    ])
      await until(
        `the other client to have ${path}`,
        holds(other, path),
        () => other.paths.join(" | "),
        20_000,
      );

    // The folders are folders, not files that happen to have a slash in them
    // -- which is what a create that never made them would leave behind.
    harness.expect(other.workspace.index().at("carton")?.type).toBe("folder");
    harness
      .expect(other.workspace.index().at("carton/under")?.type)
      .toBe("folder");

    // And the CONTENT arrived, which is the whole difference between an
    // upload and a new empty file.
    await until(
      "the uploaded text to reach the other client",
      () => heldBy(other, "uploaded.py") === "print('uploaded')\n",
      () => JSON.stringify(heldBy(other, "uploaded.py")),
      20_000,
    );
    await until(
      "the nested text to reach the other client",
      () => heldBy(other, "carton/under/beneath.txt") === "under\n",
      () => JSON.stringify(heldBy(other, "carton/under/beneath.txt")),
      20_000,
    );

    // Bytes that are not text stay bytes: an editor would otherwise be
    // handed a string the file never said.
    await until(
      "the binary to be readable",
      () => other.workspace.holding("blob.bin") !== undefined,
      () => "not yet",
      20_000,
    );
    const binary = await other.workspace.read("blob.bin");
    harness.expect(binary?.kind).toBe("binary");
    harness
      .expect([...(binary?.kind === "binary" ? binary.bytes : [])])
      .toEqual([0, 1, 2, 253, 254, 255]);

    harness.expect(console.ours()).toEqual([]);
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="an upload never lands on top of what is already there"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { id, workspace } = await opened();
    const other = alongside(id);
    showing(pocket, workspace);
    harness.onAbort(() => (workspace.dispose(), other.dispose()));

    await workspace.workspace.create("clash.md", "the original\n").settled;
    const { root } = await harness.definition("root");
    await until(
      "the file is drawn",
      () => !!rowFor(root, "clash.md"),
      () => drawn(root).join(" | "),
    );

    choose(chooser(root), [asPicked("clash.md", "the upload\n")]);

    await until(
      "the upload to reach the other client",
      holds(other, "clash-1.md"),
      () => other.paths.join(" | "),
      20_000,
    );
    // Numbered beside it, exactly as a typed name that was taken would be --
    // and the original untouched, which is the point.
    await until(
      "the original to be intact",
      () => heldBy(other, "clash.md") === "the original\n",
      () => JSON.stringify(heldBy(other, "clash.md")),
      20_000,
    );
    await until(
      "the upload to say what was uploaded",
      () => heldBy(other, "clash-1.md") === "the upload\n",
      () => JSON.stringify(heldBy(other, "clash-1.md")),
      20_000,
    );
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a folder whose only child is a folder keeps a row of its own"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    const client = workspace.workspace;
    await client.folder("outer").settled;
    await client.folder("outer/inner").settled;
    await client.create("outer/inner/leaf.py", "leaf\n").settled;

    const { root } = await harness.definition("root");
    await until(
      "the outer folder is drawn",
      () => !!rowFor(root, "outer"),
      () => drawn(root).join(" | "),
    );

    // Drawn AT ALL is the assertion: with the tree's own flattening on, the
    // two folders share one row called `outer/inner`, and the outer one then
    // has nothing to right click, to drag, or to drop onto.
    const outer = rowFor(root, "outer")!;
    harness.expect(outer).toBeTruthy();

    expand(pocket.tree!, "outer/");
    await until(
      "the inner folder is drawn under it",
      () => !!rowFor(root, "outer/inner"),
      () => drawn(root).join(" | "),
    );
    harness.expect(rowFor(root, "outer/inner")).not.toBe(outer);

    // And the outer folder's own menu acts on the outer folder.
    await menuOn(outer);
    harness.expect(action(root, "New file")).toBeTruthy();
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="panel" bind:this={p.root}>
      {#if p.tree}
        <FileTree model={p.tree} />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a menu opened at the explorer's edge is above the panel beside it"
  lazy
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { workspace } = await opened();
    showing(pocket, workspace);
    harness.onAbort(() => workspace.dispose());

    await workspace.workspace.create("edge.md", "").settled;
    const { root } = await harness.definition("root");
    await until("the three regions", laidOut(root), () =>
      regions(root).join(" | "),
    );
    await until(
      "the entry is drawn",
      () => !!rowFor(root, "edge.md"),
      () => drawn(root).join(" | "),
    );

    const explorer = () => box(root, "explorer");

    /**
     * The menu is where the pointer is, it reaches past the panel it was
     * opened in, and every part of it is what a click there would hit.
     *
     * That last clause is the whole test. A menu clipped by the panel's
     * overflow and a menu sliced through by the divider between panels both
     * LOOK like a menu in a screenshot; both answer this differently.
     */
    const clearOfEverything = (what: string) => {
      const menu = openMenu(root);
      harness.expect(menu, `${what}: a menu`).not.toBeNull();
      const shown = menu!.getBoundingClientRect();
      harness.expect(shown.width, `${what}: drawn`).toBeGreaterThan(20);

      // Kept inside the window, because a point outside it is nobody's --
      // and still past the explorer, which is the edge that was the problem.
      const far = Math.min(shown.right - 4, window.innerWidth - 4);
      const low = Math.min(shown.bottom - 4, window.innerHeight - 4);
      harness
        .expect(far, `${what}: reaches past the explorer`)
        .toBeGreaterThan(explorer().right);

      for (const [x, y] of [
        [shown.left + 4, shown.top + 4],
        [far, shown.top + 4],
        [far, low],
      ] as const) {
        const hit = document.elementFromPoint(x, y);
        harness
          .expect(
            menu!.contains(hit),
            `${what}: ${Math.round(x)},${Math.round(y)} hits ${hit?.tagName} ${hit?.getAttribute("data-region") ?? ""}`,
          )
          .toBe(true);
      }
    };

    // A row's own menu, opened where the row runs out of panel.
    const row = rowFor(root, "edge.md")!;
    const near = explorer().right - 24;
    await menuAt(row, near, row.getBoundingClientRect().top + 6);
    clearOfEverything("an entry's menu");
    void harness.capture("png", tall);

    // And the root's, which is the one that was cut off rather than sliced.
    // Dismissed both ways: the tree closes a row's menu on `mousedown`, and
    // the root's own listener is on `pointerdown`.
    for (const kind of ["pointerdown", "mousedown"])
      document.body.dispatchEvent(new MouseEvent(kind, { bubbles: true }));
    await new Promise((wake) => setTimeout(wake, 100));
    await menuAt(
      region(root, "tree")!.querySelector("file-tree-container") ??
        region(root, "tree")!,
      near,
      explorer().top + 200,
    );
    clearOfEverything("the root's menu");
    void harness.capture("png", tall);
  }}
>
  {#snippet vest(p: Pocket)}
    <div class="stage" bind:this={p.root}>
      {#if p.workspace}
        <Shell
          workspace={p.workspace.workspace}
          liveblocks={collaboration}
          entering={room.entering}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<style>
  .panel {
    height: 320px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
  }

  /* The shell fills what it is given; a report card is not a viewport. */
  .stage {
    height: 460px;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
    overflow: hidden;
  }
</style>
