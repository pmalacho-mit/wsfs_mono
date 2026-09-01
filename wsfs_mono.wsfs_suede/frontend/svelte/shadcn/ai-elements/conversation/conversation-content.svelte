<script lang="ts" module>
  import { cn, type WithElementRef } from "../../ui-utils";
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";

  export interface ConversationContentProps
    extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
    children?: Snippet;
  }
</script>

<script lang="ts">
  import { getStickToBottomContext } from "./stick-to-bottom-context.svelte.js";
  import { watch } from "runed";

  let {
    class: className,
    children,
    ref = $bindable(null),
    ...restProps
  }: ConversationContentProps = $props();

  const context = getStickToBottomContext();

  /**
   * ONE `bind:this`, and it is `ref`.
   *
   * There were two on the div below -- one to a local, one to the bindable
   * prop -- and Svelte honours the last, so the local stayed null and the
   * context was never given an element. Nothing observed the list, nothing
   * listened for a scroll, and `scrollToBottom` returned early every time it
   * was called. The stick-to-bottom behaviour was not misbehaving; it was
   * never wired up.
   */
  watch(
    () => ref,
    () => {
      if (ref) {
        context.setElement(ref);
        // Initial scroll to bottom
        context.scrollToBottom("smooth");
      }
    },
  );
</script>

<!--
  THIS IS THE SCROLLING ELEMENT, and it has to say so.

  It is what `setElement` is given, so it is what `scrollTo` is called on and
  what a scroll listener is attached to -- and it had neither a bounded height
  nor `overflow`, so a transcript longer than the panel was simply clipped by
  the `overflow-hidden` above it. Nothing scrolled because nothing could: a
  message off the bottom was not below the fold, it was cut off.

  `min-h-0` with `flex-1` because a flex child's default `min-height: auto`
  refuses to shrink below its content, which would push the bound off the
  bottom of the panel and take the scrollbar with it.
-->
<div
  bind:this={ref}
  class={cn("flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4", className)}
  {...restProps}
>
  {@render children?.()}
</div>
