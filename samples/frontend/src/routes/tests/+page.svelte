<script lang="ts">
  import Closet from "sweater-vest-suede/Closet.svelte";
</script>

<!--
  The browser half of the suite. `tests/frontend/*.test.ts` covers the client's
  logic without a DOM; these cover what only a real browser can answer -- that
  the tree, the menu and the editor actually drive the workspace, against a
  real backend, through the same code the sample ships.

  Excluded from production builds by the wrapper on `npm run build`.
-->
<Closet glob={import.meta.glob("/src/lib/**/*.test.svelte")} />
