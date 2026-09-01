<script lang="ts">
  /**
   * The slider on each panel, and what it is for.
   *
   * The complaint behind all of this: a workspace is as often SHOWN as worked
   * in -- somebody teaching from a laptop, with a room reading the projection
   * -- and the size that is comfortable at arm's length is unreadable from the
   * back. The browser's own zoom is not an answer, because it takes the layout
   * with it: three panels that no longer fit beside each other is not a bigger
   * workspace.
   *
   * So each test here asks the same two questions of one panel. Did the text
   * actually get bigger -- MEASURED, in rendered pixels, rather than by the
   * presence of a control -- and did the panel stay where it was while that
   * happened. The second is the one that would have caught a slider wired to
   * the browser's zoom instead, which looks identical in a screenshot of a
   * single panel and is wrong.
   *
   * These need no backend at all: `offline` answers the wire with entries to
   * draw and refuses every mutation, which is enough to measure text with and
   * nothing like enough to prove anything about storing.
   *
   * One workspace per test with FILE NAMES OF ITS OWN, because the editor
   * registers a workspace's paths in a filesystem that is global to the page
   * and two tests naming the same file collide there rather than in a backend.
   */
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { connect, inMemory, type Workspace as Client } from "$wsfs";
  import { solo } from "./harness/liveblocks";
  import { offline, type Layout } from "./harness/offline";
  import { scripted } from "./harness/tutor";
  import {
    clickRow,
    drawn,
    menuOn,
    openMenu,
    region,
    rowFor,
    tabs,
    until,
  } from "./harness/testing.svelte";
  import Workspace, {
    Model,
  } from "../../../../release/frontend/svelte/Workspace.svelte";
  import Assistant from "../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from "../../../../release/frontend/svelte/assistant/conversation.svelte";
  import {
    LARGEST,
    TextSize,
  } from "../../../../release/frontend/svelte/textsize.svelte";

  /**
   * A range input is moved by the browser, not by a click at a coordinate --
   * there is no gesture `userEvent` can make that lands on a value. So a test
   * moves one the way the browser does: put the value in, and say so.
   */
  const slide = (input: HTMLInputElement, to: number) => {
    input.value = String(to);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const sliderIn = (within: HTMLElement, panel: string): HTMLInputElement => {
    const found = region(within, panel)?.querySelector(
      "[data-region='text-size-slider']",
    );
    if (!found) throw new Error(`no text size slider on the ${panel} panel`);
    return found as HTMLInputElement;
  };

  const resetIn = (within: HTMLElement, panel: string): HTMLElement =>
    region(within, panel)?.querySelector(
      "[data-region='text-size-reset']",
    ) as HTMLElement;

  /** What a browser actually drew, which is the only honest unit here. */
  const drawnAt = (element: Element): number =>
    Number.parseFloat(getComputedStyle(element).fontSize);

  const widthOf = (element: Element): number =>
    element.getBoundingClientRect().width;

  /** The rendered height of a tree row -- the tree draws these in a shadow
   *  root, so it is `rowFor` that finds them and not `querySelector`. */
  const rowHeight = (within: HTMLElement, path: string): number => {
    const row = rowFor(within, path);
    if (!row) throw new Error(`the tree is not drawing ${path}`);
    return row.getBoundingClientRect().height;
  };

  class Shell {
    readonly workspace: Client;
    readonly liveblocks = solo();
    readonly model = new Model();

    constructor(layout: Layout) {
      this.workspace = connect({
        workspace: `text-size-${Object.keys(layout)[0]}`,
        transport: offline(layout),
        bytes: inMemory(),
      });
    }

    dispose() {
      this.workspace.stop();
    }
  }

  const EXPLORER: Layout = {
    lecture: {
      "slides.py": 'print("the third slide")\n',
      "handout.md": "# What we are covering\n\nLoops, and why they end.\n",
    },
  };

  const DOCUMENT: Layout = {
    demo: {
      "walkthrough.py": "total = 0\nfor value in range(10):\n    total += value\n",
    },
  };

  const MENU: Layout = {
    picks: {
      "first.py": "print(1)\n",
      "second.py": "print(2)\n",
      "third.py": "print(3)\n",
    },
  };

  const items = (within: HTMLElement) =>
    [...(openMenu(within)?.querySelectorAll("button") ?? [])] as HTMLElement[];

  const said = (within: HTMLElement) =>
    items(within).map((one) => one.textContent?.trim());

  const ATTACHED = [
    { entry: "entry-0", path: "/lecture/slides.py", executions: 0 },
  ];

  /** A transcript as the server hands one back: newest first. */
  const told = (questions: string[]) =>
    [...questions].reverse().map((text, at) => ({
      message: `told-${at}`,
      at: { minted: null, offset: null, accepted: `2026-08-24T0${at}:00:00Z` },
      text,
      snapshot: null,
      attached: [],
      answer: `answer to ${text}`,
      failure: null,
      model: "scripted",
    }));

  class Chat {
    readonly tutor = scripted(
      told(["why does this loop never end?", "what is a generator?"]),
    );
    readonly conversation = new Conversation();
    readonly textSize: TextSize;

    constructor(panel: string, { remember = false } = {}) {
      this.textSize = new TextSize(panel, { remember });
      this.conversation.attach(this.tutor.workspace as any, (entry) => entry);
    }
  }

  const bubbles = (within: HTMLElement) =>
    [...within.querySelectorAll("[data-turn]")] as HTMLElement[];
</script>

<!--
  Stacked and serial: each of these mounts a whole workspace, and two of them
  laying themselves out at once is two monaco instances competing for the
  frame the measurements are taken in.
-->
<Sweater config category="TextSize" orientation="vertical" mode="serial" />

<Sweater
  name="the explorer's slider grows the tree without moving the panel"
  body={async ({ set, container, expect, capture, delay, note, onAbort }) => {
    const pocket = set(new Shell(EXPLORER));
    onAbort(() => pocket.dispose());

    await until(
      "the tree to draw the workspace",
      () => rowFor(container, "lecture") !== undefined,
      () => drawn(container).join(" | "),
    );
    /**
     * A FOLDER row, because it is the one the tree draws before anything is
     * expanded -- and because what is being measured is the row, not the name.
     */
    const explorer = region(container, "explorer")!;
    const before = {
      row: rowHeight(container, "lecture"),
      heading: drawnAt(explorer.querySelector("h2")!),
      panel: widthOf(explorer),
    };
    await capture("png").uri;

    slide(sliderIn(container, "explorer"), 2);
    await delay({ frames: 4 });

    const after = {
      row: rowHeight(container, "lecture"),
      heading: drawnAt(explorer.querySelector("h2")!),
      panel: widthOf(explorer),
    };

    /**
     * THE ROW, not just the type. The tree is virtualised -- it positions its
     * rows itself, from a height fixed when the model was built -- so type
     * that grew inside rows that did not is the failure this measures: it
     * looks scaled in a screenshot and clips the moment anything scrolls.
     */
    expect(
      after.row / before.row,
      `rows went from ${before.row}px to ${after.row}px`,
    ).toBeGreaterThan(1.8);
    /**
     * AND THE HEADING DID NOT, which is the other half of the rule. The strip
     * is 36px tall whatever the panel is set to, and the slider on it stays
     * reachable -- a sidebar 170px wide has no room to spend on the word
     * EXPLORER at 27px, and spending it pushes the way back off the end.
     */
    expect(
      after.heading,
      "the strip that names the panel is chrome, and chrome does not grow",
    ).toBe(before.heading);
    note(
      `rows ${before.row}px → ${after.row}px, the heading stayed at ${after.heading}px`,
    );

    /**
     * AND IT STILL FILLS THE PANEL, which is the one thing about scaling a
     * box rather than its type that is worth checking: the tree asks for all
     * of the height it is given, and a hundred percent of a box measured
     * outside the scale would be twice the room there is -- half the tree
     * below the bottom of the sidebar, with nothing to scroll it back.
     */
    const treeBox = container
      .querySelector("file-tree-container")!
      .getBoundingClientRect();
    const roomFor = region(container, "tree")!.getBoundingClientRect();
    expect(
      treeBox.height,
      `the tree drew ${treeBox.height}px into ${roomFor.height}px of panel`,
    ).toBeCloseTo(roomFor.height, 0);

    /**
     * AND THE PANEL DID NOT MOVE, which is the whole difference between this
     * and the browser's zoom. A slider that widened the sidebar would take the
     * width out of the file the room is here to read.
     */
    expect(
      after.panel,
      `the sidebar was ${before.panel}px and is now ${after.panel}px`,
    ).toBeCloseTo(before.panel, 0);
    await capture("png").uri;

    /** And the way back is one click, which is what somebody who has
     *  overshot in front of an audience needs it to be. */
    resetIn(container, "explorer").click();
    await delay({ frames: 4 });
    expect(rowHeight(container, "lecture")).toBeCloseTo(before.row, 0);

    pocket.dispose();
  }}
>
  {#snippet vest(pocket: Shell)}
    {@render shell(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a file's slider grows the editor and the terminal under it together"
  body={async ({ set, container, expect, capture, delay, note, onAbort }) => {
    const pocket = set(new Shell(DOCUMENT));
    onAbort(() => pocket.dispose());

    await until(
      "the tree to draw the workspace",
      () => rowFor(container, "demo") !== undefined,
      () => drawn(container).join(" | "),
    );
    await clickRow(rowFor(container, "demo")!);
    await until(
      "the file to be there to open",
      () => rowFor(container, "demo/walkthrough.py") !== undefined,
      () => drawn(container).join(" | "),
    );
    await clickRow(rowFor(container, "demo/walkthrough.py")!);

    await until("a tab", () => tabs(container).length > 0);
    /**
     * The editor is a bundle and a worker behind the tab, so this waits for
     * the thing being measured rather than for a duration.
     */
    const lines = () => container.querySelector(".monaco-editor .view-line");
    await until(
      "monaco to draw the file",
      () => lines() !== null,
      () =>
        container.querySelector(".monaco-editor") === null
          ? "no editor at all"
          : "an editor with no lines in it yet",
      30_000,
    );
    await delay({ frames: 4 });

    const outputs = () => region(container, "outputs")!;
    const toolbar = () =>
      region(container, "file-toolbar")!.getBoundingClientRect().height;
    const before = {
      code: drawnAt(lines()!),
      output: drawnAt(outputs()),
      dock: widthOf(region(container, "documents")!),
      toolbar: toolbar(),
    };
    await capture("png").uri;

    slide(sliderIn(container, "file"), 2);
    /**
     * WAITED FOR, not slept through. Monaco is TOLD its size and re-measures
     * its own lines, which is a layout pass of its own on its own schedule --
     * so a fixed number of frames is a guess, and on a loaded machine it is
     * the wrong one. The assertions below still say what has to be true.
     */
    await until(
      "the editor to re-draw its lines at the new size",
      () => drawnAt(lines()!) > before.code * 1.5,
      () => `still ${drawnAt(lines()!)}px`,
    );
    await delay({ frames: 2 });

    const after = {
      code: drawnAt(lines()!),
      output: drawnAt(outputs()),
      dock: widthOf(region(container, "documents")!),
      toolbar: toolbar(),
    };

    expect(
      after.code / before.code,
      `the code went from ${before.code}px to ${after.code}px`,
    ).toBeGreaterThan(1.8);
    /**
     * AND THE TERMINAL WITH IT. The two are drawn by different things -- an
     * editor that owns its own layout, and ordinary markup -- so a size that
     * reached one and not the other is the likely failure, and it is the one
     * that leaves somebody presenting a run whose output nobody can read.
     */
    expect(
      after.output / before.output,
      `the output went from ${before.output}px to ${after.output}px`,
    ).toBeGreaterThan(1.8);
    expect(after.dock).toBeCloseTo(before.dock, 0);
    /** The row the slider sits on is about the file rather than part of it,
     *  so it keeps its height and the code gets the rows instead. */
    expect(after.toolbar, "the toolbar is chrome").toBeCloseTo(
      before.toolbar,
      0,
    );
    note(
      `code ${before.code}px → ${after.code}px, output ${before.output}px → ${after.output}px`,
    );
    await capture("png").uri;

    pocket.dispose();
  }}
>
  {#snippet vest(pocket: Shell)}
    {@render shell(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="the assistant's slider grows what was said, and what is being typed"
  body={async ({ set, container, expect, capture, delay, note }) => {
    const pocket = set(new Chat("assistant-under-test"));
    await until(
      "the transcript to arrive",
      () => bubbles(container).length >= 4,
      () => `${bubbles(container).length} bubbles`,
    );
    await delay({ frames: 2 });

    const box = () => container.querySelector("textarea")!;
    const before = {
      said: drawnAt(bubbles(container)[0]!),
      asking: drawnAt(box()),
      panel: widthOf(region(container, "assistant")!),
    };
    await capture("png").uri;

    slide(sliderIn(container, "assistant"), LARGEST);
    await delay({ frames: 4 });

    const after = {
      said: drawnAt(bubbles(container)[0]!),
      asking: drawnAt(box()),
      panel: widthOf(region(container, "assistant")!),
    };

    expect(
      after.said / before.said,
      `the transcript went from ${before.said}px to ${after.said}px`,
    ).toBeCloseTo(LARGEST, 1);
    /** The box you type into as well as the answers: a person presenting asks
     *  the tutor questions in front of the room too. */
    expect(after.asking / before.asking).toBeCloseTo(LARGEST, 1);
    expect(after.panel).toBeCloseTo(before.panel, 0);

    /**
     * The readout appears once it has been moved and not before -- a sidebar
     * has no width to spend saying "100%".
     */
    expect(
      region(container, "assistant")!.querySelector(
        "[data-region='text-size-percent']",
      )?.textContent,
    ).toContain("250%");
    note(
      `the transcript ${before.said}px → ${after.said}px, the box ${before.asking}px → ${after.asking}px`,
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Chat)}
    <div class="bg-background h-[28rem] w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={ATTACHED}
        textSize={pocket.textSize}
      />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a size that was set is still set on the next visit"
  body={async ({ set, container, expect, delay, onAbort }) => {
    /**
     * Somebody sets this because they have just plugged into a projector.
     * They will be on the same machine and the same screen for the next hour,
     * and a size that had to be found again on every reload -- or every time a
     * panel was rebuilt -- is one they would be setting in front of a room.
     */
    const panel = "presenting-under-test";
    const key = `wsfs:text-size:${panel}`;
    const forget = () => localStorage.removeItem(key);
    forget();
    onAbort(forget);

    const pocket = set(new Chat(panel, { remember: true }));
    await delay({ frames: 2 });

    slide(sliderIn(container, "assistant"), 1.75);
    await delay({ frames: 2 });

    /** A SECOND ONE, which is what a reload builds: same panel, nobody
     *  having told it anything, reading what the first one wrote down. */
    expect(new TextSize(panel).scale).toBe(1.75);
    expect(pocket.textSize.percent).toBe(175);

    /** And putting it back is remembered just as firmly -- otherwise the way
     *  home lasts until the next reload and then undoes itself. */
    resetIn(container, "assistant").click();
    await delay({ frames: 2 });
    expect(pocket.textSize.scale).toBe(1);
    expect(new TextSize(panel).scale).toBe(1);
    expect(
      container.querySelector("[data-region='text-size-percent']"),
      "and stops saying a number once it is back where it started",
    ).toBeNull();

    forget();
  }}
>
  {#snippet vest(pocket: Chat)}
    <div class="bg-background h-[20rem] w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={ATTACHED}
        textSize={pocket.textSize}
      />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a row's menu opens under that row, whatever size the tree is"
  body={async ({ set, container, expect, capture, delay, note, onAbort }) => {
    /**
     * What this is here for: the tree places a row's own menu with
     * `position: fixed` at the pointer's viewport coordinates, and a fixed
     * element inside something zoomed has those coordinates multiplied
     * again -- so at 200% the menu opened twice as far down the page as the
     * click, and further out the further down the panel the row was. The
     * panel draws the menu itself now, outside the zoom, hanging from the
     * bottom of the row it belongs to.
     */
    const pocket = set(new Shell(MENU));
    onAbort(() => pocket.dispose());

    await until(
      "the tree to draw the workspace",
      () => rowFor(container, "picks") !== undefined,
      () => drawn(container).join(" | "),
    );
    await clickRow(rowFor(container, "picks")!);
    await until(
      "the folder to open",
      () => rowFor(container, "picks/third.py") !== undefined,
      () => drawn(container).join(" | "),
    );
    await delay({ frames: 4 });

    /**
     * THE LAST ROW, on purpose: the drift grew with the distance from the top
     * of the tree, so a menu opened on the first row looked almost right.
     */
    const row = () => rowFor(container, "picks/third.py")!;
    /**
     * How far the menu is from the row's bottom edge, whichever way it
     * opened: one near the foot of the screen flips and hangs UPWARDS from
     * the same point, so the edge that meets the row is its bottom rather
     * than its top. Either way that edge is the constant gap away, and that
     * is the claim.
     */
    const gap = () => {
      const box = openMenu(container)?.getBoundingClientRect();
      if (!box) throw new Error("no menu opened");
      const bottom = row().getBoundingClientRect().bottom;
      return Math.min(Math.abs(box.top - bottom), Math.abs(box.bottom - bottom));
    };

    await menuOn(row());
    expect(said(container), "the entry's actions, not the root's").toContain(
      "Rename",
    );
    const before = gap();
    const beforeRead = drawnAt(items(container)[0]!);
    expect(before, `${before}px from the row`).toBeLessThan(6);
    await capture("png").uri;

    /** Dismissed, then the same click on the same row at twice the size. */
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await delay({ frames: 2 });
    slide(sliderIn(container, "explorer"), 2);
    await delay({ frames: 6 });

    await menuOn(row());
    const after = gap();
    const afterRead = drawnAt(items(container)[0]!);
    note(
      `${before.toFixed(1)}px from the row at 100%, ${after.toFixed(1)}px at 200%; ` +
        `its own type ${beforeRead}px → ${afterRead}px`,
    );

    /**
     * AND THE MENU IS LEGIBLE AT THAT SIZE TOO. It is the tree's own
     * component, drawn from `--trees-*` rather than from anything the rest of
     * this feature touches -- so a panel turned up for a room whose menu
     * still whispers is the failure this catches.
     */
    expect(
      afterRead / beforeRead,
      `the menu went from ${beforeRead}px to ${afterRead}px`,
    ).toBeCloseTo(2, 1);
    /**
     * The SAME constant gap, not a scaled one: the menu is chrome, and where
     * it opens is a fact about the row rather than about the type in it.
     */
    expect(after, `${after}px from the row at 200%`).toBeCloseTo(before, 0);
    expect(after, "and still a handful of pixels, not a scaled gap").toBeLessThan(6);
    expect(said(container)).toContain("Rename");
    await capture("png").uri;

    pocket.dispose();
  }}
>
  {#snippet vest(pocket: Shell)}
    {@render shell(pocket)}
  {/snippet}
</Sweater>

<!--
  The three panels together, at the size somebody would present them at. The
  point of the picture is the arrangement: each panel is bigger inside and
  none of them has taken width from another.
-->
<Sweater
  name="all three, turned up for the back of the room"
  body={async ({ set, container, expect, capture, delay, onAbort }) => {
    const pocket = set(new Shell(EXPLORER));
    onAbort(() => pocket.dispose());

    await until(
      "the tree to draw the workspace",
      () => rowFor(container, "lecture") !== undefined,
      () => drawn(container).join(" | "),
    );
    const widths = () =>
      ["explorer", "documents", "assistant"].map((panel) =>
        widthOf(region(container, panel)!),
      );
    const before = widths();

    for (const panel of ["explorer", "assistant"])
      slide(sliderIn(container, panel), 1.8);
    await delay({ frames: 6 });

    const after = widths();
    after.forEach((width, at) =>
      expect(width, `the ${at} panel was ${before[at]}px`).toBeCloseTo(
        before[at]!,
        0,
      ),
    );
    await capture("png").uri;

    pocket.dispose();
  }}
>
  {#snippet vest(pocket: Shell)}
    {@render shell(pocket)}
  {/snippet}
</Sweater>

{#snippet shell(pocket: Shell)}
  <div class="bg-background text-foreground h-[34rem] w-full">
    <Workspace
      model={pocket.model}
      workspace={pocket.workspace}
      liveblocks={pocket.liveblocks}
    />
  </div>
{/snippet}
