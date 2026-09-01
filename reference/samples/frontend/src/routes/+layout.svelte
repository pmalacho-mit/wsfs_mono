<script lang="ts">
  import "../../../../release/frontend/svelte/app.css";
  import Layout from "../../../../release/frontend/svelte/Layout.svelte";

  let { children } = $props();
</script>

<Layout />
{@render children()}
