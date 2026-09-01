<script lang="ts">
  /**
   * One open file. What it is decides what shows: text goes to the editor,
   * bytes to a preview, and a `.py` file gets a terminal underneath it.
   *
   * The kind comes from the content the workspace actually holds, not from the
   * name -- the name only decides whether the file is worth running.
   */
  import type { IDockviewPanelProps } from "dockview";

  import { Editor } from "../../../wsfs_suede.python-monaco-suede";
  import History from "./History.svelte";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import Preview from "./Preview.svelte";
  import ProblemHeader from "./ProblemHeader.svelte";
  import { headerFor } from "./headers";
  import Runner, { type Outcome } from "./Runner.svelte";
  import TextSizeSlider from "./shell/TextSizeSlider.svelte";
  import type { Workspace } from "../";
  import type { KernelPool, OpenFile } from "./Workspace.svelte";
  import type { Payload } from "../content";
  import { TextSize } from "./textsize.svelte";
  import { onDestroy, onMount } from "svelte";

  type Params = {
    opened: OpenFile;
    workspace: Workspace;
    kernelPool: KernelPool;
    /**
     * How big the text in the open files is -- ONE size for all of them, so
     * that a person who has found a comfortable size and then opens the next
     * file gets that file at the size they set. Its own if the panel was
     * mounted without one.
     */
    textSize?: TextSize;
    onFinished: (outcome: Outcome) => void;
    /** Every run as it starts, with the promise it will finish by. */
    onRun?: (started: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => void;
  };

  let { params }: IDockviewPanelProps<Params> = $props();

  let binary = $state<Extract<Payload, { kind: "binary" }>>();

  /**
   * Whether this panel is still on screen.
   *
   * A read is a round trip and a panel can be closed during one -- a tab
   * shutting, a workspace being put away, a test ending. The read then fails
   * against a workspace nobody is holding any more, and answering it would
   * be answering to nothing.
   */
  let showing = true;
  onDestroy(() => (showing = false));

  const read = () => {
    params.workspace
      .read(params.opened.path)
      .then((content) => {
        if (!showing || !content) return;
        if (content.kind === "text") params.opened.share(content.text);
        else binary = content;
      })
      /**
       * Caught, because an uncaught one is a console error that says nothing
       * anybody can act on. Nothing is lost by failing here: content is
       * re-fetchable, the panel goes on showing what it has, and the view
       * says "Opening ..." for as long as it has nothing at all.
       */
      .catch(() => undefined);
  };

  /**
   * A file that was text can stop being text.
   *
   * It used to say "shared text can't become binary" here and stop watching,
   * which is the assumption a two-browser test disproved: somebody with the
   * file closed -- another client, a script, a kernel writing an image where
   * a `.py` used to be -- can write bytes over it, and the write lands. The
   * room finds out and records it as `replaced`; this is what turns that into
   * something the person looking at the editor can see.
   */
  $effect(() => {
    const { opened, workspace } = params;
    const { id } = opened;
    return workspace.watch((changes) => {
      if (
        !changes.some(({ kind, entry }) => entry === id && kind === "written")
      )
        return;
      // A shared file only re-reads once its room says it is no longer text.
      // Otherwise every keystroke anybody stores would pull the whole file
      // back over the document that already has it.
      if (opened.sharedText && opened.sharedText.shared?.replaced === undefined)
        return;
      read();
    });
  });

  onMount(read);

  let runnable = $derived(params.opened.path.endsWith(".py"));

  /**
   * The size everything in this panel is drawn at.
   *
   * The editor is TOLD its size rather than styled into it: monaco measures
   * its own lines to place the cursor, so a font size it did not agree to is
   * a caret that lands between characters. `size` is the option it agrees to,
   * and 14 is the size it is drawn at ordinarily.
   */
  const EDITOR = 14;
  /** Its own, for a panel mounted by something that keeps no sizes -- a test,
   *  or any other host of this component. */
  const alone = new TextSize("documents");
  let textSize = $derived(params.textSize ?? alone);

  /**
   * The problem this file is an answer to, for the files somebody wrote one
   * down for. Derived from the path rather than read once, so a file that is
   * renamed stops -- or starts -- carrying a header along with the name.
   */
  let problem = $derived(headerFor(params.opened.path));

  /**
   * Offered on every open file, not only when something looks wrong.
   *
   * The moment a person needs this is the moment they believe work has gone,
   * and that is the worst moment to go looking for where it lives. A line
   * that is always there costs one row and is already known when it matters.
   */
  let showingHistory = $state(false);

  /**
   * The terminal underneath, while there is one.
   *
   * Bound rather than reached for, because whether this file can be run is
   * the whole condition on the shortcut below: a `.py` file has a runner and
   * this holds it; anything else has none and this stays undefined.
   */
  let runner = $state<Runner>();

  /**
   * The keys that run the file, for somebody whose hands are in the editor.
   *
   * SAVE RUNS IT. There is nothing to save -- what is typed is already in the
   * room and already what the kernel reads -- so ctrl/cmd+S is a key people
   * press out of habit that would otherwise offer to write the page to disk.
   * Shift+Enter is the other one those hands already know, from every
   * notebook they have used.
   *
   * ON THE EDITOR, not on the window: this is what somebody typing meant, and
   * a document being read or a question being written to the tutor is not.
   * Both are stopped as well as prevented -- prevented so the browser's save
   * dialog stays shut, stopped so the workbench underneath does not also act
   * on a key that has already been answered here.
   */
  $effect(() => {
    const editor = params.opened.sharedText?.editor;
    const mounted = runner;
    if (editor === undefined || mounted === undefined) return;
    const bound = editor.onKeyDown((event) => {
      const key = event.browserEvent.key;
      const saving =
        (event.ctrlKey || event.metaKey) && key.toLowerCase() === "s";
      /** Plain shift: ctrl+shift+enter is the editor's own, and stays it. */
      const asked =
        event.shiftKey && key === "Enter" && !event.ctrlKey && !event.metaKey;
      if (!saving && !asked) return;
      event.preventDefault();
      event.stopPropagation();
      /** Refused while a run is going -- see `run` in `Runner.svelte`. */
      void mounted.run();
    });
    return () => bound.dispose();
  });
</script>

<!--
  ONE PANEL, WHICHEVER WAY THE FILE TURNS OUT.

  The toolbar is drawn before anything knows what the file holds, so nothing
  moves underneath the pointer when the content arrives -- and so the slider
  is in the same place on a picture as it is on a program.
-->
<div
  class="panel"
  data-region="file"
  data-text-scale
  style:--wsfs-text-scale={textSize.scale}
>
  <!-- Chrome: this row is about the file rather than part of it, and a
       history offer at 35px would take the rows the code needs. -->
  <div
    class="flex shrink-0 items-center gap-1 border-b pr-2"
    data-region="file-toolbar"
    data-text-scale="chrome"
  >
    {#if params.opened.sharedText}
      <button
        type="button"
        class="text-muted-foreground hover:bg-muted/60 flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
        data-region="history-offer"
        onclick={() => (showingHistory = true)}
      >
        <HistoryIcon class="size-3.5 shrink-0" />
        <span class="truncate">
          Missing something, or want to see how this looked before?
          <span class="underline underline-offset-2">
            Open this file's history
          </span>
        </span>
      </button>
    {:else}
      <span class="min-w-0 flex-1"></span>
    {/if}
    <TextSizeSlider size={textSize} label="File text size" />
  </div>

  {#if params.opened.sharedText}
    <History
      workspace={params.workspace}
      entry={params.opened.id}
      path={params.opened.path}
      bind:open={showingHistory}
    />
  {/if}

  {#if binary}
    <div class="body">
      {#if params.opened.sharedText?.shared?.replaced}
        <p
          class="bg-destructive/10 text-destructive border-destructive/30 shrink-0 border-b px-3 py-2 text-sm"
          data-region="replaced"
        >
          Somebody wrote {params.opened.sharedText.shared.replaced.mime} over this
          file. What you were editing is no longer what it holds.
        </p>
      {/if}
      <!-- The preview fills what the notice above it left, rather than the
           whole panel: `h-full` under a row that is also in the panel is a
           panel and a bit, and the bottom of the picture goes off the end. -->
      <div class="min-h-0 flex-1">
        <Preview path={params.opened.path} held={binary} />
      </div>
    </div>
  {:else if params.opened.sharedText}
    <div class="text" class:runnable class:headed={problem !== undefined}>
      {#if problem !== undefined}
        <ProblemHeader content={problem} />
      {/if}
      <!--
        OVER the editor rather than above it.
        A notice that takes a row pushes every line of code down the moment it
        appears and pulls them back up when it goes -- and these come and go on
        their own schedule, not the reader's. Floating it means the thing being
        read never moves, which is the only way a transient notice is bearable.
      -->
      {#if params.opened.sharedText.shared?.trouble}
        {@const trouble = params.opened.sharedText.shared.trouble}
        <p
          class="pointer-events-none absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-xs shadow-sm {trouble.passing
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'bg-destructive/10 text-destructive border-destructive/30'}"
          data-region="trouble"
        >
          {trouble.says} — what you type is kept, and goes when it can.
        </p>
      {/if}
      <!-- `props` is everything the editor was configured with and the file is
           the one thing that differs per panel. Spreading is what makes
           `onEditor` reach anybody -- it was being carried this far and dropped.
           `size` comes after it because the panel's slider outranks whatever
           the workspace configured every editor with. -->
      <Editor.Component
        {...params.opened.sharedText.props}
        file={params.opened.sharedText.file}
        size={textSize.px(EDITOR)}
      />
      {#if runnable}
        <Runner
          bind:this={runner}
          kernelPool={params.kernelPool}
          shared={params.opened.sharedText}
          onFinished={params.onFinished}
          onRun={params.onRun}
        />
      {/if}
    </div>
  {:else}
    <p class="text-muted-foreground p-4 text-sm">
      Opening {params.opened.path}…
    </p>
  {/if}
</div>

<!--
  Both notices are SAID rather than hidden. Typing into a document that is
  reaching nobody is safe -- it is kept, and it goes when the room comes back
  -- but a person who is not told assumes their work is where everybody
  else's is. Amber for that, and destructive for a file that stopped being
  the text on screen, because only one of the two has already cost something.
-->
<style>
  /*
   * The toolbar takes its row and whatever the file turned out to be takes
   * the rest. `flex` rather than the `height: 100%` this used to carry: a
   * hundred percent of the panel, underneath a row that is also in it, is a
   * panel and a bit -- so the terminal went off the bottom by exactly the
   * height of the strip above it.
   */
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }
  .text {
    display: grid;
    grid-template-rows: 1fr;
    /* A COLUMN THAT MAY BE NARROWER THAN WHAT IS IN IT.
       The implicit column a grid makes for itself is `auto`, and `auto` will
       not go below the widest thing inside -- so one long line of code in the
       problem statement set the width of this whole panel, and dragging the
       splitter left could not take it back. The panel got smaller; the row
       did not, and the code block's buttons went out past the edge with it.
       `minmax(0, 1fr)` is the same column with permission to shrink, which
       hands the overflow back to the things built to scroll it. */
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
  .text.runnable {
    grid-template-rows: 1fr minmax(7rem, 30%);
  }
  /* The header takes what it needs -- itself capped -- and the editor takes
     the rest, which is why it is a row here rather than a block above the
     grid: an editor sized to 100% of a box it no longer fills alone overflows
     the panel, and the terminal underneath goes off the bottom of it. */
  .text.headed {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .text.headed.runnable {
    grid-template-rows: auto minmax(0, 1fr) minmax(7rem, 30%);
  }
</style>
