<script lang="ts" module>
  import type { Theme, ViewAPI } from "../../dockview-svelte-suede";
  import FileView from "./FileView.svelte";

  const tabs = { file: FileView };

  /** The dock the open files live in. */
  export type Dock = ViewAPI<"dock", typeof tabs>;

  export type Params = {
    theme: Theme;
    onready: (api: Dock) => void;
  };
</script>

<script lang="ts">
  /** The middle panel: one tab per open file. */
  import FileTextIcon from "@lucide/svelte/icons/file-text";

  import { DockView, type PanelProps } from "../../dockview-svelte-suede";

  let { params }: PanelProps<"grid", Params> = $props();
</script>

{#snippet nothingOpen()}
  <div
    class="bg-background text-muted-foreground grid h-full w-full place-items-center gap-2 text-sm"
    data-region="nothing-open"
  >
    <div class="flex flex-col items-center gap-2">
      <FileTextIcon class="size-6" />
      Open a file from the explorer.
    </div>
  </div>
{/snippet}

<div class="h-full min-h-0 w-full min-w-0" data-region="documents">
  <DockView
    theme={params.theme}
    components={tabs}
    watermark={{ snippet: nothingOpen }}
    onReady={({ api }) => params.onready(api)}
  />
</div>
