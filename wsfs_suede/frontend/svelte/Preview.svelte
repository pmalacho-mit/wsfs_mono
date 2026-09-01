<script lang="ts">
  import DownloadIcon from "@lucide/svelte/icons/download";
  import { Button } from "./shadcn/ui/button";
  import type { Held } from "$wsfs";

  let { path, held }: { path: string; held: Held } = $props();

  const binary = $derived(held.kind === "binary" ? held : undefined);

  /**
   * Revoked when the panel goes away, because an object URL outlives the
   * component that made it and holds its bytes alive with it.
   */
  const source = $derived.by(() => {
    if (!binary) return undefined;
    const copied = new Uint8Array(binary.bytes);
    const url = URL.createObjectURL(new Blob([copied], { type: binary.mime }));
    return url;
  });

  $effect(() => () => {
    if (source) URL.revokeObjectURL(source);
  });

  const shows = $derived(binary?.mime.startsWith("image/") ?? false);
</script>

<div class="bg-background grid h-full place-items-center overflow-auto p-4">
  {#if !binary}
    <p class="text-muted-foreground text-sm">Nothing to preview.</p>
  {:else if shows && source}
    <img src={source} alt={path} class="max-h-full max-w-full" />
  {:else}
    <p class="text-muted-foreground flex items-center gap-2 text-sm">
      {binary.mime} · {binary.bytes.byteLength} bytes
      {#if source}
        <Button href={source} download={path} variant="outline" size="xs">
          <DownloadIcon />
          Download
        </Button>
      {/if}
    </p>
  {/if}
</div>
