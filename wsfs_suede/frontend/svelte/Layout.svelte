<script lang="ts">
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "./shadcn/ui/sonner";
</script>

<!-- The mode is settled before the first paint, so nothing flashes light on
     its way to dark. -->
<ModeWatcher />
<!--
  `expand` is not about stacking here -- it is what stops the banner twitching
  under the cursor.

  Sonner keeps a collapsed and an expanded layout, and hovering ANYWHERE on the
  toaster switches between them. Collapsed, the front toast is left at its
  natural height; expanded, it is pinned to `--initial-height`, a pixel value
  measured once when the toast mounted. The toast lays its contents out with
  `align-items: center`, so any drift between that measurement and the height
  the box actually wants moves everything inside it by half the difference --
  a hover, a small jump, and a jump back on the way out.

  Expanded from the start, there is no second layout to switch to: the height
  stays `auto` and hovering changes nothing. Costs nothing either, with one
  toast on screen and nothing to stack it against.
-->
<Toaster position="top-center" expand richColors closeButton />
