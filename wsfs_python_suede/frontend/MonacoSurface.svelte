<script lang="ts" module>
  import { Editor } from "../../python-monaco-suede";
  import type { Editing, Opening, Surface } from "../../wsfs_svelte_suede/frontend";
  import { MonacoEditing, type EditorProps } from "./monaco.svelte";
  import View from "./MonacoSurface.svelte";

  /**
   * Monaco, registered as a surface.
   *
   * `props` is everything every editor in a workspace should be configured
   * with -- the language settings, an `onEditor` a host wants -- and the file
   * is the one thing that differs per panel.
   */
  export const monaco = (props: EditorProps = {}): Surface => ({
    open: (file: Opening) => new MonacoEditing(file, props),
    view: View,
  });
</script>

<script lang="ts">
  let { editing, size }: { editing: Editing; size: number } = $props();

  const held = editing as MonacoEditing;
</script>

<!--
  The editor is TOLD its size rather than styled into it: monaco measures its
  own lines to place the cursor, so a font size it did not agree to is a caret
  that lands between characters.
-->
<Editor.Component {...held.props} file={held.file} {size} />
