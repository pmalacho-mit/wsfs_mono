<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Header from "../../../../../release/frontend/svelte/shell/Header.svelte";

  const WORKSPACE = {
    title: "Workspace Example",
    event: "Example",
    course: "Example",
  };

  /**
   * Nothing is carried between the body and the vest here -- these are
   * capture tests, and what they assert is on screen. It is declared anyway
   * because an untyped vest leaves `Sweater` unable to tell a test from a
   * config block.
   */
  class Pocket {}
</script>

<Sweater config category="Header" />

<Sweater
  name="names the workspace and the course event it belongs to"
  body={async ({ container, expect, capture, delay }) => {
    await delay({ frames: 2 });
    const identity = container.querySelector(
      "[data-region='workspace-identity']",
    );
    expect(identity?.textContent).toContain("Workspace Example");
    expect(identity?.textContent).toContain(
      "Course event Example: Course Example",
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(_pocket: Pocket)}
    <div class="bg-background text-foreground h-full w-full">
      <Header {...WORKSPACE} />
    </div>
  {/snippet}
</Sweater>

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
<Sweater
  name="paints from the same tokens in dark"
  body={async ({ capture, delay }) => {
    await delay({ frames: 2 });
    await capture("png").uri;
  }}
>
  {#snippet vest(_pocket: Pocket)}
    <div class="dark bg-background text-foreground h-full w-full">
      <Header {...WORKSPACE} />
    </div>
  {/snippet}
</Sweater>
