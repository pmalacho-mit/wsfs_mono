<script lang="ts">
  /**
   * Monaco, drawing one wsfs file.
   *
   * The shell hears about this model only once Monaco has handed over an
   * editor, because until then there is no edit stream to report and nothing
   * for a store to read.
   */
  import type { OpenText } from "../../wsfs_svelte_suede/frontend";
  import { Editor } from "../../python-monaco-suede";
  import { MonacoModel, type EditorProps } from "./monaco.svelte";

  let {
    file,
    size = 14,
    props = {},
  }: { file: OpenText; size?: number; props?: EditorProps } = $props();

  const opened = new MonacoModel(file);

  const editorArrived: NonNullable<EditorProps["onEditor"]> = (editor) => {
    const theirs = props.onEditor?.(editor);
    const stopWatching = opened.watch(editor);
    const forget = file.mounted(opened);
    return {
      dispose: () => (forget(), stopWatching(), theirs?.dispose()),
    };
  };

  $effect(() => {
    const document = file.document;
    if (document !== undefined) opened.bind(document);
  });

  $effect(() => opened.moved(file.path));
</script>

<!--
  The editor is TOLD its size rather than styled into it: monaco measures its
  own lines to place the cursor, so a font size it did not agree to is a caret
  that lands between characters.
-->
<Editor.Component
  {...props}
  onEditor={editorArrived}
  file={opened.model}
  {size}
/>
