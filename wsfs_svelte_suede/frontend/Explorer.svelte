<script lang="ts" module>
  import type { Path } from "../../wsfs_core_suede/frontend";
  import type { Model } from "./FileTree.svelte";
  import type { TextSize } from "./textsize.svelte";

  export type Params = {
    model: Model;
    textSize: TextSize;
    protectedName?: (path: Path) => boolean;
  };
</script>

<script lang="ts">
  /** The left panel: everything this workspace holds, as a tree. */
  import FolderTreeIcon from "@lucide/svelte/icons/folder-tree";

  import type { PanelProps } from "../../dockview-svelte-suede";
  import FileTree from "./FileTree.svelte";
  import PanelHeading from "./shell/PanelHeading.svelte";
  import TextSizeSlider from "./shell/TextSizeSlider.svelte";

  let { params }: PanelProps<"grid", Params> = $props();
</script>

<section
  class="bg-sidebar grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r"
  data-region="explorer"
  data-text-scale
  style:--wsfs-text-scale={params.textSize.scale}
>
  <PanelHeading label="Explorer" icon={FolderTreeIcon}>
    {#snippet controls()}
      <TextSizeSlider size={params.textSize} label="Explorer text size" />
    {/snippet}
  </PanelHeading>
  <FileTree model={params.model} protectedName={params.protectedName} />
</section>
