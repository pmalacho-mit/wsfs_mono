<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import {
    DockView,
    themes,
    type PanelProps,
    type ViewAPI,
  } from "wsfs_suede.dockview-svelte-suede";
  import { InView } from "../../../../release/frontend/svelte/inview.svelte";

  class Pocket {
    api = $state<ViewAPI<"dock", { dummy: typeof dummy }>>();
    inview = new InView();
  }
</script>

{#snippet dummy({ params: { id } }: PanelProps<"dock", { id: string }>)}
  <p>{id}</p>
{/snippet}

<Sweater
  body={async ({ definition, set }) => {
    const { inview } = set(new Pocket());
    const { api } = await definition("api");
    for (let i = 0; i < 4; i++) {
      const id = { id: `${i}` };
      const { panel } = await api.addSnippetPanel("dummy", id, id);
      inview.watch({ ...id, api: panel.api });
    }
    api.onDidRemovePanel(({ id }) => inview.forget(id));
  }}
>
  {#snippet vest(pocket: Pocket)}
    {#each pocket.inview.showing as id}
      <p>{id}</p>
    {/each}
    <DockView
      snippets={{ dummy }}
      theme={themes.githubLight}
      onReady={({ api }) => (pocket.api = api)}
    />
  {/snippet}
</Sweater>
