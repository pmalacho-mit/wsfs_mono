<script lang="ts">
  /** The strip that names a panel. Shared, so the two panels agree. */
  import type { Icon } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  let {
    label,
    icon: Glyph,
    /**
     * What this panel offers on its own heading -- its text size, today.
     *
     * On the heading rather than anywhere else because it is the one row
     * every panel already has, and a control that costs no height is one an
     * instructor can be shown mid-lesson without anything moving.
     */
    controls,
  }: { label: string; icon: typeof Icon; controls?: Snippet } = $props();
</script>

<!-- `chrome`, so the strip is the same height in a panel turned up for a
     lecture theatre as in one nobody has touched. See `app.css`. -->
<div
  class="flex h-9 shrink-0 items-center gap-2 border-b px-3"
  data-text-scale="chrome"
>
  <Glyph class="text-muted-foreground size-3.5 shrink-0" />
  <!-- Truncating, because the controls beside it have a fixed width and the
       name of the panel is the half a reader can do without. -->
  <h2
    class="text-muted-foreground min-w-0 truncate font-semibold tracking-[0.08em] uppercase text-(length:--text-2xs)"
  >
    {label}
  </h2>
  {#if controls}
    <div class="ml-auto flex shrink-0 items-center">{@render controls()}</div>
  {/if}
</div>
