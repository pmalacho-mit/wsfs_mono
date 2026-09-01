<script lang="ts">
  /**
   * The three panels together, with nobody behind them.
   *
   * What this can answer is what only a browser can: that the explorer, the
   * dock and the assistant fill their halves of the grid and paint from one
   * palette. What it cannot answer is anything about storing -- see
   * `offline`, which refuses every mutation on purpose.
   */
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { resetMode, setMode } from "mode-watcher";
  import { connect, inMemory, type Workspace as Client } from "$wsfs";
  import { solo } from "./harness/liveblocks";
  import { offline } from "./harness/offline";
  import Workspace from "../../../../release/frontend/svelte/Workspace.svelte";
  import WorkspaceFrame from "../../../../release/frontend/svelte/shell/WorkspaceFrame.svelte";
  import WorkspacePane from "../../../../release/frontend/svelte/shell/WorkspacePane.svelte";
  import type { Faltering } from "$wsfs";

  const LAYOUT = {
    notebooks: {
      "analysis.py": "import readings\n\nprint(readings.mean())\n",
      "scratch.py": 'print("hello")\n',
    },
    data: { "readings.csv": "day,value\n1,3.2\n2,4.1\n" },
  };

  class Pocket {
    readonly workspace: Client;
    readonly liveblocks = solo();

    constructor() {
      this.workspace = connect({
        workspace: "offline",
        transport: offline(LAYOUT),
        bytes: inMemory(),
      });
    }

    /** Set by the test that asks what a notice does to the layout. */
    storage = $state<Faltering>();

    dispose() {
      this.workspace.stop();
    }
  }

  /** What the workspace holds. The tree draws it into a shadow root, so what
   *  is on screen is the picture's business rather than an assertion's. */
  const named = (client: Client) => [...client.index().paths()].sort();
</script>

<!--
  Stacked, so each panel is as wide as the layout it is drawing; serial,
  because the mode below is set on the document and read by the dock.
-->
<Sweater config category="Workspace" orientation="vertical" mode="serial" />

<Sweater
  name="the explorer, the dock and the assistant share one grid"
  body={async ({ set, container, expect, capture, delay, onAbort }) => {
    onAbort(resetMode);
    setMode("light");
    const pocket = set(new Pocket());
    onAbort(() => pocket.dispose());

    // A round trip behind the panels it fills, so this waits for what the
    // workspace said rather than for a duration.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (named(pocket.workspace).length > 0) break;
      await delay({ milliseconds: 100 });
    }

    for (const region of ["explorer", "documents", "assistant"])
      expect(
        container.querySelector(`[data-region='${region}']`),
      ).not.toBeNull();
    expect(named(pocket.workspace)).toContain("notebooks/analysis.py");
    expect(named(pocket.workspace)).toContain("data/readings.csv");

    await capture("png").uri;
    pocket.dispose();
    resetMode();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render framed(pocket, "")}
  {/snippet}
</Sweater>

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
<Sweater
  name="paints from the same tokens in dark"
  body={async ({ set, capture, delay, onAbort }) => {
    onAbort(resetMode);
    // Both halves, because they are told separately: the dock and the tree
    // are painted from `mode`, and the stylesheet from the nearest `.dark`.
    setMode("dark");
    const pocket = set(new Pocket());
    onAbort(() => pocket.dispose());
    await delay({ seconds: 2 });
    await capture("png").uri;
    pocket.dispose();
    resetMode();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render framed(pocket, "dark")}
  {/snippet}
</Sweater>

{#snippet framed(pocket: Pocket, mode: string)}
  <div class="bg-background text-foreground h-full w-full {mode}">
    <WorkspaceFrame title="Workspace Example" event="Example" course="Example">
      <Workspace workspace={pocket.workspace} liveblocks={pocket.liveblocks} />
    </WorkspaceFrame>
  </div>
{/snippet}

<!--
  The arrangement, not the panels. What broke was a notice slot ABOVE the
  workspace: optional, and laid out as a two-track grid, so with no notice the
  workspace landed in the `auto` track and was zero high. The header looked
  perfectly fine and everything below it was gone -- which no test measuring
  panels against each other could see, because there were no panels.
-->
<Sweater
  name="the workspace fills what is under the header, notice or no notice"
  body={async ({ set, container, expect, capture, delay, onAbort }) => {
    onAbort(resetMode);
    setMode("light");
    const pocket = set(new Pocket());
    onAbort(() => pocket.dispose());

    for (let attempt = 0; attempt < 40; attempt++) {
      if (named(pocket.workspace).length > 0) break;
      await delay({ milliseconds: 100 });
    }
    await delay({ frames: 2 });

    const pane = container.querySelector("[data-region='workspace-pane']")!;
    const body = container.querySelector("[data-region='workspace-body']")!;
    const shell = container.querySelector("[data-region='shell']")!;

    /** Most of the pane, not a sliver of it, and certainly not nothing. */
    const filling = (held: Element) =>
      held.getBoundingClientRect().height / pane.getBoundingClientRect().height;
    expect(pane.getBoundingClientRect().height).toBeGreaterThan(100);
    expect(filling(body)).toBeGreaterThan(0.9);
    expect(filling(shell)).toBeGreaterThan(0.9);

    /** And with a notice, which is the case the layout was written for. */
    pocket.storage = {
      says: "work that has not been sent is not being written down",
      full: false,
    };
    await delay({ frames: 2 });
    const said = container.querySelector("[data-region='storage-trouble']");
    expect(said).not.toBeNull();
    expect(said!.getBoundingClientRect().height).toBeGreaterThan(0);
    /** The workspace gives up the notice's height and keeps the rest. */
    expect(filling(body)).toBeGreaterThan(0.7);
    expect(filling(shell)).toBeGreaterThan(0.7);

    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="h-[36rem] w-full">
      <WorkspaceFrame
        title="Workspace Example"
        event="Example"
        course="Example"
      >
        <WorkspacePane
          workspace={pocket.workspace}
          liveblocks={pocket.liveblocks}
          storage={pocket.storage}
        />
      </WorkspaceFrame>
    </div>
  {/snippet}
</Sweater>
