<script lang="ts">
  import type { editor } from "monaco-editor";
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import {
    UserEdits,
    type UserEdit,
  } from "../../../../release/frontend/svelte/edits";
  import { onDestroy } from "svelte";
  import { cleaner } from "../../../../release/frontend/svelte/utils";

  const cleanup = cleaner();
  onDestroy(cleanup);
</script>

<Sweater config>
  {@const Pocket = class {
    readonly file: Editor.Model;
    editor = $state<editor.IStandaloneCodeEditor>();
    edits = $state<UserEdit[]>([]);

    constructor(file: Editor.Model) {
      this.file = file;
    }
  }}
  <Sweater
    body={async ({ set, definition }) => {
      const pocket = set(
        new Pocket(
          new Editor.Model({
            name: "test.py",
            parent: { path: "" },
            source: `print("hello world")`,
          }),
        ),
      );
      const { editor } = await definition("editor");
      const userEdits = new UserEdits(editor);
      cleanup.add(
        userEdits.subscribe({
          edited: (edit) => pocket.edits.unshift(edit),
        }),
      );
    }}
  >
    {#snippet vest(pocket: InstanceType<typeof Pocket>)}
      <div class="split-container">
        <div class="side scroller">
          {#each pocket.edits as edit}
            <div class="row">
              {JSON.stringify(edit, null, 2)}
            </div>
          {/each}
        </div>
        <div class="side">
          <Editor.Component
            file={pocket.file}
            onEditor={(editor) => (pocket.editor = editor)}
          />
        </div>
      </div>
    {/snippet}
  </Sweater>
</Sweater>

<style>
  .split-container {
    display: flex; /* Aligns children side-by-side */
    width: 100%;
    height: 100vh; /* Spans full height of the device screen */
  }

  .side {
    flex: 1; /* Distributes equal 50/50 width to both panels */
    display: flex;
  }

  .scroller {
    height: 100%;
    width: 100%;
    overflow-y: scroll;
    display: flex;
    flex-direction: column;
  }

  .row {
    width: 100%;
    height: fit-content;
    text-wrap: wrap;
  }
</style>
