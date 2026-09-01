<script lang="ts" module>
  import { createDismissableLayer } from "dockview";
  import type {
    DockviewSpecificComponentConstraint,
    ITabContextMenuProps,
  } from "../utils/index.js";

  /** Where the pointer was when the menu was asked for. */
  export type At = { x: number; y: number };
</script>

<script lang="ts">
  type Props = {
    at: At;
    menu: DockviewSpecificComponentConstraint["tabContextMenu"];
    target: ITabContextMenuProps;
  };

  let { at, menu, target }: Props = $props();

  let element = $state<HTMLElement>();

  /** Where it ends up once measured, which is only known after a render. */
  let placed = $state<At>();

  const within = (edge: number, size: number, wanted: number) =>
    Math.max(0, Math.min(wanted, edge - size));

  /** A menu asked for near an edge opens back from it rather than off-screen. */
  $effect(() => {
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    placed = {
      x: within(window.innerWidth, width, at.x),
      y: within(window.innerHeight, height, at.y),
    };
  });

  $effect(() => {
    const layer = createDismissableLayer({
      elements: () => (element ? [element] : []),
      onDismiss: target.close,
    });

    return () => layer.dispose();
  });
</script>

<div
  bind:this={element}
  role="menu"
  tabindex="-1"
  data-dockview-svelte="dockcontextmenu"
  style:position="fixed"
  style:left={`${(placed ?? at).x}px`}
  style:top={`${(placed ?? at).y}px`}
  style:z-index="99"
>
  {#if "component" in menu}
    <menu.component {...target} />
  {:else}
    {@render menu.snippet(target)}
  {/if}
</div>
