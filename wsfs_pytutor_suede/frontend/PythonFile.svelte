<script lang="ts">
  /**
   * What a text file looks like in this application: the problem it answers,
   * the editor, and a terminal underneath a program.
   *
   * This is what `editorFor` hands the shell, and it is the one place all
   * three packages meet -- the problem statement is this package's, the editor
   * and the terminal are `wsfs_python_suede`'s, and the file is
   * `wsfs_svelte_suede`'s.
   */
  import type { OpenText } from "../../wsfs_svelte_suede/frontend";
  import {
    MonacoEditor,
    Runner,
    type EditorProps,
    type KernelPool,
    type Outcome,
  } from "../../wsfs_python_suede/frontend";
  import ProblemHeader from "./ProblemHeader.svelte";
  import { headerFor } from "./headers";

  let {
    file,
    size,
    kernels,
    editor = {},
    onFinished,
    onRun,
  }: {
    file: OpenText;
    /** What the panel's slider says. See `EditorFor`. */
    size: number;
    kernels: KernelPool;
    editor?: EditorProps;
    onFinished: (outcome: Outcome) => void;
    onRun: (started: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => void;
  } = $props();

  let terminal = $state<{ run: () => void }>();

  let problem = $derived(headerFor(file.path));
  let runnable = $derived(file.path.endsWith(".py"));

  /**
   * SAVE RUNS IT. There is nothing to save -- what is typed is already in the
   * room and already what the kernel reads -- so ctrl/cmd+S is a key people
   * press out of habit that would otherwise offer to write the page to disk.
   * Shift+Enter is the other one those hands already know, from every notebook
   * they have used.
   */
  const meansRun = (pressed: { key: string; ctrl: boolean; meta: boolean; shift: boolean }) =>
    ((pressed.ctrl || pressed.meta) && pressed.key.toLowerCase() === "s") ||
    /** Plain shift: ctrl+shift+enter is the editor's own, and stays it. */
    (pressed.shift && pressed.key === "Enter" && !pressed.ctrl && !pressed.meta);

  $effect(() =>
    file.keys((pressed) => {
      if (terminal === undefined || !meansRun(pressed)) return;
      pressed.claim();
      /** Refused while a run is going -- see `run` in `Runner.svelte`. */
      terminal.run();
    }),
  );
</script>

<div class="file" class:runnable class:headed={problem !== undefined}>
  {#if problem !== undefined}
    <ProblemHeader content={problem} />
  {/if}
  <MonacoEditor {file} {size} props={editor} />
  {#if runnable}
    <Runner bind:this={terminal} kernelPool={kernels} {file} {onFinished} {onRun} />
  {/if}
</div>

<style>
  /*
   * A COLUMN THAT MAY BE NARROWER THAN WHAT IS IN IT. A grid's implicit column
   * is `auto`, and `auto` will not go below the widest thing inside -- so one
   * long line of code set the width of the whole panel and dragging the
   * splitter left could not take it back.
   */
  .file {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  /* The header takes what it needs -- itself capped -- and the editor takes
     the rest, which is why it is a row here rather than a block above the
     grid: an editor sized to 100% of a box it no longer fills alone overflows
     the panel, and the terminal underneath goes off the bottom of it. */
  .file.headed {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .file.runnable {
    grid-template-rows: minmax(0, 1fr) minmax(7rem, 30%);
  }
  .file.headed.runnable {
    grid-template-rows: auto minmax(0, 1fr) minmax(7rem, 30%);
  }
</style>
