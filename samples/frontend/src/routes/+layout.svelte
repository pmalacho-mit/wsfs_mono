<script lang="ts">
  import "$svelte/app.css";
  import Layout from "$svelte/Layout.svelte";

  let { children } = $props();
</script>

<Layout />
{@render children()}
