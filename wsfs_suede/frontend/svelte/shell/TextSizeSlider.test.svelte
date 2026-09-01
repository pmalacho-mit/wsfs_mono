<script lang="ts" module>
  /**
   * That the slider does not move as it passes 100%.
   *
   * WHAT WENT WRONG ONCE: the percent readout was drawn only when the size
   * had been changed, and the control is pushed to the right edge of the
   * strip -- so at exactly 100% the readout left the row, the group narrowed
   * by 36px, and the track slid out from under the pointer dragging it. A
   * single pixel of movement went 105% → 80%, and putting the readout back
   * moved everything again.
   *
   * So this measures the track rather than the value: what has to be true is
   * that where it is drawn does not depend on what it is set to. Numbers are
   * noted as well as asserted, because a failure here is a distance and the
   * distance is the diagnosis.
   */
  import { Sweater } from "../../../../../../sweater-vest-suede";
  import "../../../../../../src/app.css";
  import TextSizeSlider from "./TextSizeSlider.svelte";
  import { TextSize } from "../textsize.svelte";

  class Pocket {
    strip = $state<HTMLElement>();
    /** Not remembered: a test must not read or write anybody's storage. */
    size = new TextSize("test", { remember: false });
  }

  const sliderIn = (strip: HTMLElement): HTMLInputElement => {
    const found = strip.querySelector<HTMLInputElement>(
      '[data-region="text-size-slider"]',
    );
    if (!found) throw new Error("the strip drew no slider");
    return found;
  };

  /** Whether the readout is READ, which is not whether it is in the row. */
  const readingIn = (strip: HTMLElement) =>
    strip.querySelector<HTMLElement>('[data-region="text-size-percent"]')
      ?.dataset.changed === "true";

  const boxOf = (strip: HTMLElement) => {
    const { left, width } = sliderIn(strip).getBoundingClientRect();
    return { left: Math.round(left), width: Math.round(width) };
  };
</script>

<Sweater config orientation="vertical" category="TextSizeSlider" />

<Sweater
  name="where the track sits on either side of 100%"
  id="track-moves"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    const { strip } = await harness.definition("strip");
    await harness.delay({ frames: 2 });

    const at = async (scale: number) => {
      pocket.size.scale = scale;
      await harness.delay({ frames: 2 });
      const box = boxOf(strip);
      harness.note(
        `${pocket.size.percent}%: track left ${box.left}, width ${box.width}` +
          `, readout ${readingIn(strip) ? "shown" : "hidden"}`,
      );
      return box;
    };

    const above = await at(1.05);
    const home = await at(1);
    const below = await at(0.95);
    harness.capture("png");

    harness.note(`105% → 100% moved the track ${home.left - above.left}px`);
    harness.note(`100% → 95% moved it back ${below.left - home.left}px`);

    /**
     * The regression: the readout used to leave the row at exactly 100%,
     * which moved the track out from under whoever was dragging it.
     */
    harness.expect(readingIn(strip)).toBe(false);
    harness.expect(home.left).toBe(above.left);
    harness.expect(below.left).toBe(above.left);

    /** Left where anything driving this from outside can read it. */
    (globalThis as Record<string, unknown>).__slider = { above, home, below };
  }}
>
  {#snippet vest(p: Pocket)}
    <!-- `PanelHeading`, as the explorer draws it: a name, then the controls
         pushed to the right edge by `ml-auto`. -->
    <div
      bind:this={p.strip}
      class="flex h-9 shrink-0 items-center gap-2 border-b px-3"
      style="width: 260px"
      data-text-scale="chrome"
    >
      <h2 class="text-muted-foreground min-w-0 truncate text-[0.68rem]">
        EXPLORER
      </h2>
      <div class="ml-auto flex shrink-0 items-center">
        <TextSizeSlider size={p.size} label="Explorer text size" />
      </div>
    </div>
  {/snippet}
</Sweater>
