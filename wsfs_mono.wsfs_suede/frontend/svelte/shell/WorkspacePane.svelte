<script lang="ts">
  /**
   * The workspace, and anything that has to be said above it.
   *
   * A component rather than markup in the route, because the arrangement is
   * the part that broke: the notice is OPTIONAL, and a two-track grid with
   * one child puts that child in the `auto` track, which is zero high. The
   * whole workspace vanished below a header that looked perfectly fine.
   *
   * A column that grows says what is meant and does not depend on how many
   * children happen to be there. Being a component is what lets a test render
   * it both ways and measure.
   */
  import type { Faltering, Reclamation, Workspace as WSFS } from "../../";
  import Workspace, { Model } from "../Workspace.svelte";
  import type { Configured } from "../assistant/stuck";
  import type { createClient } from "@liveblocks/client";

  let {
    workspace,
    liveblocks,
    storage,
    room,
    courseEvent,
    protocol,
    system,
    readonly = false,
  }: {
    workspace: WSFS;
    liveblocks: ReturnType<typeof createClient>;
    /** Which sitting of which course this is, for the study's records. */
    courseEvent?: string;
    /** What this course was set up to run. See `stuck.ts`. */
    protocol?: Configured;
    /** What is wrong with writing the queue down, if anything. */
    storage?: Faltering;
    /** What the last pass at making room found. */
    room?: Reclamation;
    /** System prompt */
    system: string;
    /**
     * Whether or not the workspace is opened in readonly mode.
     *
     * Declared here AND handed on below, which is the whole of it: this sat
     * in the type without being destructured or passed, so a route setting it
     * got a workspace that had never heard of it -- every panel writable, the
     * tree offering rename and delete, and nothing to show for the setting
     * except a prop that type-checked.
     */
    readonly?: boolean;
  } = $props();

  /**
   * Said only when the person can do something about it.
   *
   * A pass that freed space is housekeeping, not news. `short` is the one
   * answer that changes what they should do next, and it is about the NEXT
   * keystroke rather than about work already lost -- nothing here is gone,
   * which is why it does not go through the door `lost` uses.
   */
  const shortOf = $derived(room?.phase === "short" ? room : undefined);

  const model = new Model();
</script>

<div class="flex h-full min-h-0 flex-col" data-region="workspace-pane">
  <!--
    A banner rather than a toast, because it is not an event: for as long as
    it says this, everything typed here is going nowhere but this tab, and a
    notice that fades would stop saying so while it was still true.
  -->
  {#if storage}
    <p
      class="bg-destructive/10 text-destructive border-destructive/30 shrink-0 border-b px-3 py-2 text-sm"
      data-region="storage-trouble"
    >
      {storage.says}.{storage.full
        ? " Free some space — until then, anything typed here only lives in this tab."
        : " Anything typed here only lives in this tab until it is sent."}
    </p>
  {/if}
  {#if shortOf}
    <p
      class="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
      data-region="out-of-room"
    >
      There is more unsent work here than this browser will hold. Reconnect so
      it can be saved, or close a workspace — until then, new changes may not be
      kept anywhere.
      {#if shortOf.workspaces.length > 1}
        Work is waiting in {shortOf.workspaces.length} workspaces.
      {/if}
    </p>
  {/if}
  <div class="min-h-0 flex-1" data-region="workspace-body">
    <Workspace
      {workspace}
      {liveblocks}
      {model}
      {courseEvent}
      {protocol}
      {system}
      {readonly}
    />
  </div>
</div>
