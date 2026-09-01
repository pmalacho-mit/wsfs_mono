<script lang="ts" module>
  import type { Snippet } from "svelte";

  export type Params = { render: Snippet };
</script>

<script lang="ts">
  /**
   * A grid panel whose contents somebody else drew.
   *
   * The shell declares this so that a consumer holding the grid can add a
   * panel of its own: dockview resolves a panel by a name the view was built
   * with, and a name a consumer invented is not one of them. Handing a snippet
   * through the panel's parameters is how the shell stays ignorant of what
   * goes in it.
   */
  import type { PanelProps } from "../../dockview-svelte-suede";

  let { params }: PanelProps<"grid", Params> = $props();
</script>

{@render params.render()}
