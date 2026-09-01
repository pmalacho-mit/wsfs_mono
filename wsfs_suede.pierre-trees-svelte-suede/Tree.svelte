<script lang="ts" module>
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
  import type { Model } from "./model.svelte";
  import type { Variables } from "./variables";

  export type Props = Omit<HTMLAttributes<HTMLElement>, "children"> &
    Variables & {
      model: Model;
      header?: Snippet;
      contextMenu?: Snippet<
        [item: ContextMenuItem, context: ContextMenuOpenContext]
      >;
    };
</script>

<script lang="ts">
  import { composedWithSlots, type ContextMenuTrigger } from "./composition";
  import { asStyle, partition } from "./variables";

  let { model, header, contextMenu, style, ...rest }: Props = $props();

  let container = $state<HTMLElement>();
  let trigger = $state<ContextMenuTrigger>();

  // `--x="y"` on a component is compiled into an inherited declaration rather
  // than a prop, so these only arrive when spread; both routes reach the tree.
  const { declarations, attributes } = $derived(partition(rest));

  const baseline = $derived(model.tree.getComposition());

  const composition = $derived(
    composedWithSlots(baseline, {
      header: header !== undefined,
      contextMenu: contextMenu && {
        opened: (opened) => (trigger = opened),
        closed: () => (trigger = undefined),
      },
    }),
  );

  $effect(() => {
    model.tree.setComposition(composition);
  });

  $effect(() => {
    if (!container) return;
    const unmount = model.mount(container);
    return () => {
      unmount();
      model.tree.setComposition(baseline);
    };
  });
</script>

<file-tree-container
  bind:this={container}
  {...attributes}
  style={asStyle(declarations, style)}
  style:--trees-item-height="{model.tree.getItemHeight()}px"
  style:--trees-density-override={model.tree.getDensityFactor()}
>
  {#if header}
    <div slot="header">{@render header()}</div>
  {/if}
  {#if contextMenu && trigger}
    <div slot="context-menu">
      {@render contextMenu(trigger.item, trigger.context)}
    </div>
  {/if}
</file-tree-container>

<style>
  /*
   * The model marks the host while a drop on it would land at the root -- the
   * empty space below the last row, and the header. The tree declares its
   * palette on `:host`, which IS this element, so the ring can be the colour
   * the focus ring already is without anyone wiring a theme through.
   *
   * The tint is an image rather than a background colour because the tree
   * paints the host's background itself: this lies over that, instead of
   * taking it away for as long as the drag lasts.
   */
  file-tree-container[data-root-drop-target] {
    --root-drop-ring: var(
      --trees-root-drop-ring-color,
      var(--trees-focus-ring-color, var(--trees-accent, #009fff))
    );
    --root-drop-tint: var(
      --trees-root-drop-bg,
      color-mix(in oklch, var(--root-drop-ring) 8%, transparent)
    );
    box-shadow: inset 0 0 0 var(--trees-focus-ring-width, 1px)
      var(--root-drop-ring);
    background-image: linear-gradient(
      var(--root-drop-tint),
      var(--root-drop-tint)
    );
  }
</style>
