<script lang="ts">
  /**
   * One open file. What it holds decides what shows: text goes to whichever
   * editor was registered for it, bytes to a preview.
   *
   * The kind comes from the content the workspace actually holds, not from
   * the name.
   */
  import type { IDockviewPanelProps } from "dockview";
  import { onDestroy, onMount } from "svelte";

  import type { Workspace } from "../../wsfs_core_suede/frontend";
  import type { Payload } from "../../wsfs_core_suede/frontend/content";
  import History from "./History.svelte";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import Preview from "./Preview.svelte";
  import Textarea from "./Textarea.svelte";
  import TextSizeSlider from "./shell/TextSizeSlider.svelte";
  import type { EditorFor } from "./editor";
  import type { OpenEntry } from "./open.svelte";
  import { TextSize } from "./textsize.svelte";

  type Params = {
    opened: OpenEntry;
    workspace: Workspace;
    editorFor: EditorFor;
    /**
     * ONE size for every open file, so that somebody who has found a
     * comfortable size and then opens the next file gets that file at the
     * size they set. Its own if the panel was mounted without one.
     */
    textSize?: TextSize;
  };

  let { params }: IDockviewPanelProps<Params> = $props();

  let bytes = $state<Extract<Payload, { kind: "binary" }>>();
  let showingHistory = $state(false);

  /**
   * The editor is TOLD its size rather than styled into it: an editor that
   * measures its own lines to place the cursor lands the caret between
   * characters at a font size it did not agree to.
   */
  const EDITOR = 14;
  const ownSize = new TextSize("documents");
  let textSize = $derived(params.textSize ?? ownSize);

  let editor = $derived(params.editorFor(params.opened.path));

  /**
   * Whether this panel is still on screen.
   *
   * A read is a round trip and a panel can be closed during one -- a tab
   * shutting, a workspace being put away, a test ending -- and answering it
   * would be answering to nothing.
   */
  let onScreen = true;
  onDestroy(() => (onScreen = false));

  const read = () =>
    void params.workspace
      .read(params.opened.path)
      .then(showWhateverArrived)
      /**
       * Nothing is lost by failing: content is re-fetchable, the panel goes on
       * showing what it has, and the view says "Opening ..." while it has
       * nothing at all. An uncaught rejection here is a console error saying
       * nothing anybody can act on.
       */
      .catch(() => undefined);

  const showWhateverArrived = (content: Payload | undefined) => {
    if (!onScreen || !content) return;
    if (content.kind === "text") params.opened.holdsText(content.text);
    else bytes = content;
  };

  onMount(read);

  /**
   * A file that was text can stop being text.
   *
   * Somebody with the file closed -- another client, a script, a kernel
   * writing an image where a `.py` used to be -- can write bytes over it, and
   * the write lands. The room finds out and records it as `replaced`; this is
   * what turns that into something the person looking at the editor can see.
   */
  $effect(() => {
    const { opened, workspace } = params;
    return workspace.watch((changes) => {
      if (!changes.some(isWriteTo(opened.id))) return;
      if (stillHoldingItsOwnText(opened)) return;
      read();
    });
  });

  const isWriteTo =
    (entry: string) =>
    ({ kind, entry: changed }: { kind: string; entry: string }) =>
      changed === entry && kind === "written";

  /**
   * A shared file only re-reads once its room says it is no longer text.
   * Otherwise every keystroke anybody stores would pull the whole file back
   * over the document that already has it.
   */
  const stillHoldingItsOwnText = (opened: OpenEntry) =>
    opened.text !== undefined && opened.text.room?.replaced === undefined;

  let text = $derived(params.opened.text);
  let replaced = $derived(text?.room?.replaced);
  let trouble = $derived(text?.room?.trouble);
</script>

<!--
  ONE PANEL, WHICHEVER WAY THE FILE TURNS OUT.

  The toolbar is drawn before anything knows what the file holds, so nothing
  moves underneath the pointer when the content arrives -- and so the slider is
  in the same place on a picture as it is on a program.
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
    {#if text}
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

  {#if text}
    <History
      workspace={params.workspace}
      entry={params.opened.id}
      path={params.opened.path}
      bind:open={showingHistory}
    />
  {/if}

  {#if bytes}
    <div class="body">
      {#if replaced}
        <p
          class="bg-destructive/10 text-destructive border-destructive/30 shrink-0 border-b px-3 py-2 text-sm"
          data-region="replaced"
        >
          Somebody wrote {replaced.mime} over this file. What you were editing
          is no longer what it holds.
        </p>
      {/if}
      <!-- The preview fills what the notice above it left, rather than the
           whole panel: `h-full` under a row that is also in the panel is a
           panel and a bit, and the bottom of the picture goes off the end. -->
      <div class="min-h-0 flex-1">
        <Preview path={params.opened.path} content={bytes} />
      </div>
    </div>
  {:else if text}
    <div class="text">
      <!--
        OVER the editor rather than above it. A notice that takes a row pushes
        every line of code down the moment it appears and pulls them back up
        when it goes -- and these come and go on their own schedule, not the
        reader's. Floating it means the thing being read never moves.
      -->
      {#if trouble}
        <p
          class="pointer-events-none absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-xs shadow-sm {trouble.passing
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'bg-destructive/10 text-destructive border-destructive/30'}"
          data-region="trouble"
        >
          {trouble.message} — what you type is kept, and goes when it can.
        </p>
      {/if}
      {#if editor}
        {@render editor(text, textSize.px(EDITOR))}
      {:else}
        <Textarea file={text} size={textSize.px(EDITOR)} />
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
  -- but a person who is not told assumes their work is where everybody else's
  is. Amber for that, and destructive for a file that stopped being the text on
  screen, because only one of the two has already cost something.
-->
<style>
  /*
   * The toolbar takes its row and whatever the file turned out to be takes the
   * rest. `flex` rather than `height: 100%`: a hundred percent of the panel,
   * underneath a row that is also in it, is a panel and a bit.
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
  /*
   * A COLUMN THAT MAY BE NARROWER THAN WHAT IS IN IT. A grid's implicit column
   * is `auto`, and `auto` will not go below the widest thing inside -- so one
   * long line of code set the width of the whole panel and dragging the
   * splitter left could not take it back. `minmax(0, 1fr)` hands the overflow
   * back to the things built to scroll it.
   */
  .text {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
</style>
