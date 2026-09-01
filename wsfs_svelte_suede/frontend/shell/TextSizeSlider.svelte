<script lang="ts">
  /**
   * The control that makes one panel's text bigger.
   *
   * A slider rather than a pair of buttons: somebody setting this is standing
   * at a projector with a room waiting, and "drag until it looks right from
   * the back" is one gesture where stepping to it is eight.
   *
   * The glyph is the way back. Overshooting is the ordinary failure here --
   * the size that reads from the back row is far too large to work in -- and
   * a slider with no home to return to leaves somebody hunting for 100%
   * afterwards, which is a fiddly thing to do in front of people.
   */
  import ALargeSmall from "@lucide/svelte/icons/a-large-small";
  import { LARGEST, SMALLEST, STEP, type TextSize } from "../textsize.svelte";

  let {
    size,
    /** What this is the size OF, for anything that has to say it aloud. */
    label = "Text size",
  }: { size: TextSize; label?: string } = $props();

  const says = $derived(`${label}: ${size.percent}%`);
</script>

<!--
  ITS OWN SCALE IS ONE, and it says so itself rather than relying on where it
  was put: a control that grew with what it controls is one somebody who has
  overshot cannot reach to put back. See `app.css`.
-->
<div
  class="flex shrink-0 items-center gap-1"
  data-region="text-size"
  data-scale={size.scale}
  data-text-scale="chrome"
>
  <button
    type="button"
    class="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex size-5 shrink-0 items-center justify-center rounded"
    data-region="text-size-reset"
    title="{says} — click to put it back"
    aria-label="Reset {label.toLowerCase()}"
    onclick={() => size.reset()}
  >
    <ALargeSmall class="size-3.5" />
  </button>

  <input
    type="range"
    class="accent-primary h-4 w-16 shrink cursor-pointer bg-transparent"
    data-region="text-size-slider"
    min={SMALLEST}
    max={LARGEST}
    step={STEP}
    value={size.scale}
    aria-label={label}
    aria-valuetext="{size.percent}%"
    title={says}
    oninput={(event) => (size.scale = Number(event.currentTarget.value))}
  />

  <!--
    Read only once it has been moved -- a panel sitting at 100% is saying
    nothing worth reading -- but the WIDTH IS HELD EITHER WAY, and that is
    not a detail.

    This used to be an `{#if}`, and the control is pushed to the right edge
    of the strip it sits on. So the moment a drag reached exactly 100% this
    span left the row, the group narrowed by its width and the gap before it,
    and the track slid 36px right -- out from under the pointer that was
    dragging it. The browser reads the next mouse move against the track's
    new position, which on a 64px track is most of its travel: 105% became
    80% in one pixel of movement, and putting the readout back moved
    everything again. A control cannot be dragged through a size that moves
    it. Hidden rather than removed, so the row is the same width at every
    size, and `visibility` rather than opacity so a reader is not offered
    "100%" by a screen reader when nothing is shown.
  -->
  <span
    class="text-muted-foreground w-8 shrink-0 text-right tabular-nums text-(length:--text-2xs)"
    class:invisible={!size.changed}
    data-region="text-size-percent"
    data-changed={size.changed}
  >
    {size.percent}%
  </span>
</div>
