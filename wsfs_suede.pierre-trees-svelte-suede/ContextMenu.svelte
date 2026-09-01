<script lang="ts" module>
  import type {
    ContextMenuAnchorRect,
    ContextMenuItem,
    ContextMenuOpenContext,
  } from "@pierre/trees";
  import type { Model } from "./model.svelte";
  import { entries } from "./entries";

  export type Action = {
    label: string;
    run: () => void;
    danger?: boolean;
    /** Draws a divider above this action. */
    divided?: boolean;
  };

  /** The surface's own holes, same shape as the tree's. */
  export type Variables = Partial<{
    "--trees-menu-bg": string;
    "--trees-menu-fg": string;
    "--trees-menu-border-color": string;
    "--trees-menu-hover-bg": string;
    "--trees-menu-danger-fg": string;
    "--trees-menu-border-radius": string;
    "--trees-menu-shadow": string;
    "--trees-menu-min-width": string;
    "--trees-menu-font-family": string;
    "--trees-menu-font-size": string;
  }>;

  export type Props = Variables & {
    context: ContextMenuOpenContext;
    actions: readonly Action[];
  };

  /**
   * New file, New folder, Rename, Delete — the four a file explorer is expected
   * to have, already wired to the tree. Build your own `Action[]` to say
   * anything else; `entries` holds the mutations these are made of.
   */
  export const standardActions = ({
    model,
    item,
    context,
  }: {
    model: Model;
    item: ContextMenuItem;
    context: ContextMenuOpenContext;
  }): Action[] => {
    // Renaming moves focus into the tree's own input, which the menu's usual
    // focus restore would immediately steal back.
    const handOver = (act: () => void) => () => {
      context.close({ restoreFocus: false });
      act();
    };
    return [
      { label: "New file", run: handOver(() => entries.add(model, item, "file")) },
      {
        label: "New folder",
        run: handOver(() => entries.add(model, item, "folder")),
      },
      { label: "Rename", run: handOver(() => entries.rename(model, item)) },
      {
        label: "Delete",
        danger: true,
        divided: true,
        run: handOver(() => entries.remove(model, item)),
      },
    ];
  };

  /** A pointer-anchored menu carries no box; a trigger-anchored one carries the button's. */
  const fromPointer = (anchor: ContextMenuAnchorRect) =>
    anchor.width === 0 && anchor.height === 0;

  const step = (
    keys: readonly HTMLButtonElement[],
    from: Element | null,
    by: number,
  ) =>
    keys[
      (keys.indexOf(from as HTMLButtonElement) + by + keys.length) % keys.length
    ];
</script>

<script lang="ts">
  import { asStyle } from "./variables";

  let { context, actions, ...rest }: Props = $props();

  // Spread they arrive as props; written as `--x="y"` Svelte turns them into a
  // declaration this inherits instead. Either way they reach the surface.
  const style = $derived(asStyle(Object.entries(rest)));

  let menu = $state<HTMLElement>();
  let height = $state(0);

  // The tree slots this into an anchor element it has already positioned over
  // the row, so the menu only has to say which corner of that anchor to hang
  // from — no coordinates of its own.
  const anchor = $derived(context.anchorRect);
  const flipped = $derived(anchor.bottom + height > window.innerHeight);

  const items = (): HTMLButtonElement[] => [
    ...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];

  $effect(() => {
    items()[0]?.focus({ preventScroll: true });
  });

  const navigate = (event: KeyboardEvent) => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    step(items(), document.activeElement, move)?.focus({ preventScroll: true });
  };
</script>

<div
  bind:this={menu}
  bind:clientHeight={height}
  role="menu"
  tabindex="-1"
  data-file-tree-context-menu-root="true"
  class:flipped
  class:trailing={!fromPointer(anchor)}
  onkeydown={navigate}
  {style}
>
  {#each actions as action (action.label)}
    {#if action.divided}<hr />{/if}
    <button
      type="button"
      role="menuitem"
      class:danger={action.danger}
      onclick={action.run}
    >
      {action.label}
    </button>
  {/each}
</div>

<style>
  /*
   * Every colour chains through the tree's own resolved variables before it
   * reaches a default, so a Shiki theme or a `--trees-*-override` palette
   * carries into the menu without anyone wiring it up. The tree declares those
   * on `:host`, and this is a light-DOM child of that host, so they inherit.
   *
   * A menu is a raised surface, which is why it borrows the tree's input
   * colours rather than its page background — the one variable a palette is
   * free to make transparent.
   */
  div {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: var(--trees-menu-min-width, 180px);
    padding: 0.25rem;
    color: var(
      --trees-menu-fg,
      var(--trees-search-fg, light-dark(oklch(14.5% 0 0), oklch(98.5% 0 0)))
    );
    background: var(
      --trees-menu-bg,
      var(--trees-search-bg, light-dark(oklch(100% 0 0), oklch(20.5% 0 0)))
    );
    background-clip: padding-box;
    border: 1px solid
      var(
        --trees-menu-border-color,
        var(
          --trees-border-color,
          light-dark(rgb(0 0 0 / 0.1), rgb(255 255 255 / 0.15))
        )
      );
    border-radius: var(--trees-menu-border-radius, var(--trees-border-radius, 0.5rem));
    box-shadow: var(
      --trees-menu-shadow,
      0 10px 15px -3px light-dark(rgb(0 0 0 / 0.1), rgb(0 0 0 / 0.25)),
      0 4px 6px -4px light-dark(rgb(0 0 0 / 0.1), rgb(0 0 0 / 0.25))
    );
    font-family: var(
      --trees-menu-font-family,
      var(--trees-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)
    );
    font-size: var(--trees-menu-font-size, var(--trees-font-size, 0.875rem));
    animation: open 120ms ease-out;
  }

  /* Anchored to the trigger button on the row's right edge: grow leftwards. */
  div.trailing {
    left: auto;
    right: 0;
  }

  div.flipped {
    top: auto;
    bottom: 100%;
  }

  @keyframes open {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
  }

  button {
    display: flex;
    align-items: center;
    padding: 0.375rem 0.75rem;
    font: inherit;
    line-height: 1.4;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--trees-menu-border-radius, var(--trees-border-radius, 0.375rem));
    cursor: default;
    outline: none;
    user-select: none;
  }

  button:hover,
  button:focus-visible,
  button:focus {
    background: var(
      --trees-menu-hover-bg,
      var(--trees-bg-muted, light-dark(oklch(97% 0 0), oklch(26.9% 0 0)))
    );
  }

  button.danger {
    color: var(
      --trees-menu-danger-fg,
      var(
        --trees-status-deleted,
        light-dark(oklch(57.7% 0.245 27.325), oklch(70.4% 0.191 22.216))
      )
    );
  }

  button.danger:hover,
  button.danger:focus-visible,
  button.danger:focus {
    background: color-mix(in oklch, currentColor 15%, transparent);
  }

  hr {
    height: 1px;
    margin: 0.25rem -0.25rem;
    background: var(
      --trees-menu-border-color,
      var(
        --trees-border-color,
        light-dark(rgb(0 0 0 / 0.1), rgb(255 255 255 / 0.15))
      )
    );
    border: 0;
  }
</style>
