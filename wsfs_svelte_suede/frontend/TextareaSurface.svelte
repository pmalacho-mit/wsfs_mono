<script lang="ts" module>
  import { TextareaEditing } from "./textarea.svelte";
  import type { Editing, Opening, Surface } from "./surface";
  import View from "./TextareaSurface.svelte";

  /**
   * The surface a file gets when nothing better is registered for it.
   *
   * Plain, and correct: bound to the room's document, reporting the person's
   * edits before there is one, and never diffing the file in. See `surface.ts`
   * for why those three are the whole specification.
   */
  export const textarea: Surface = {
    open: (file: Opening) => new TextareaEditing(file),
    view: View,
  };
</script>

<script lang="ts">
  let { editing, size }: { editing: Editing; size: number } = $props();

  const held = editing as TextareaEditing;

  let element = $state<HTMLTextAreaElement>();

  /**
   * Mounted rather than constructed with the element, because the panel is
   * torn down and rebuilt when a tab is dragged and what the person typed
   * must not go with it -- see `Surface`.
   */
  $effect(() => (element === undefined ? undefined : held.mount(element)));
</script>

<textarea
  bind:this={element}
  data-region="surface"
  data-path={held.path}
  readonly={held.readonly}
  spellcheck="false"
  style:font-size="{size}px"
></textarea>

<style>
  textarea {
    display: block;
    width: 100%;
    height: 100%;
    resize: none;
    border: 0;
    outline: none;
    padding: 0.5rem 0.75rem;
    background: transparent;
    color: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.5;
    tab-size: 4;
  }
</style>
