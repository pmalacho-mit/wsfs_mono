<script lang="ts">
  /**
   * The editor a file gets when the consumer has nothing better for it.
   *
   * Bound to the room's document, reporting this person's edits before there
   * is one, and never diffing the file in. See `textarea.svelte.ts` for why
   * those three are the whole specification.
   */
  import type { OpenText } from "./open.svelte";
  import { TextareaBinding } from "./textarea.svelte";

  let { file, size }: { file: OpenText; size: number } = $props();

  let element = $state<HTMLTextAreaElement>();
  let binding = $state<TextareaBinding>();

  $effect(() => {
    if (element === undefined) return;
    const bound = new TextareaBinding(element, file.showing);
    binding = bound;
    const forget = file.mounted(bound);
    return () => (forget(), bound.dispose(), (binding = undefined));
  });

  $effect(() => {
    const document = file.document;
    if (document !== undefined) binding?.bind(document);
  });
</script>

<textarea
  bind:this={element}
  data-region="editor"
  data-path={file.path}
  readonly={file.readonly}
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
