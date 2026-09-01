<script lang="ts" module>
  import type { Snippet } from "svelte";

  /** Where the menu hangs from, in the viewport's own coordinates. */
  export type Anchor = {
    top: number;
    left: number;
    width: number;
    height: number;
  };

  export type Props = { anchor: Anchor; children: Snippet };

  const supported = () =>
    typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;
</script>

<script lang="ts">
  /**
   * A menu, in the browser's top layer, standing exactly where its anchor is.
   *
   * A context menu is drawn INSIDE the panel it belongs to and has to appear
   * outside it, and a panel in a dock is the worst case for both halves of
   * that: it clips what overflows it, and the divider between panels is drawn
   * as a raised element of its own. So a menu left where it is renders either
   * cut off at the panel's edge or sliced through by the divider, depending
   * on which panel it opened in -- and no z-index fixes it, because the tree
   * anchors its menu inside a stacking context of its own that a rule out
   * here cannot reach into.
   *
   * The top layer is above all of that by definition: nothing paints over it
   * and no ancestor's overflow clips it. This is a `manual` popover rather
   * than an `auto` one because dismissal is already somebody's job -- the
   * tree's, for a row's menu, and the tree component's own listeners for the
   * root's -- and light dismissal would close it from underneath them.
   *
   * IT STAYS WHERE IT IS IN THE DOM, which is the reason for a popover rather
   * than a portal: the menu's colours are inherited custom properties the
   * tree declares on its own host, and moving the element would leave it
   * wearing the neutral fallbacks instead of the theme.
   */
  let { anchor, children }: Props = $props();

  let layer = $state<HTMLElement>();

  $effect(() => {
    const element = layer;
    if (element === undefined || !supported()) return;
    try {
      element.showPopover();
    } catch {
      // Already open, or in a document that will not have it. Either way the
      // menu below still renders; it is only its layer that is ordinary.
      element.removeAttribute("popover");
      return;
    }
    return () => {
      try {
        element.hidePopover();
      } catch {
        /* Already gone with the element that held it. */
      }
    };
  });
</script>

<div
  bind:this={layer}
  popover="manual"
  data-region="menu-layer"
  style:left="{anchor.left}px"
  style:top="{anchor.top}px"
  style:width="{anchor.width}px"
  style:height="{anchor.height}px"
>
  {@render children()}
</div>

<style>
  /*
   * A popover arrives wearing a dialog's clothes -- a border, padding, a
   * background, `inset: 0` and `margin: auto`. All of it is undone here: this
   * is a zero-sized origin standing where the anchor stands, and the menu is
   * what is seen.
   *
   * The z-index is for a browser with no top layer to put this in, where the
   * `popover` attribute is inert and this is an ordinary fixed element.
   */
  div {
    position: fixed;
    right: auto;
    bottom: auto;
    z-index: 2147483000;
    margin: 0;
    padding: 0;
    color: inherit;
    background: none;
    border: 0;
    overflow: visible;
  }

  /*
   * A closed popover is `display: none` by the browser's own rule, and this
   * one is only closed in the moment before the effect above opens it, in a
   * browser with no top layer to open it into, or in a COPY of the page --
   * which is what a screenshot is. None of those should be a menu that
   * vanishes, and the box is in the right place either way; open, it is
   * simply also above everything.
   *
   * Written with the attribute so this beats `[popover]:not(:popover-open)`,
   * which is a more specific selector than a class of ours alone.
   */
  div[popover] {
    display: block;
  }

  div::backdrop {
    display: none;
  }
</style>
