<script lang="ts">
  /**
   * What this file has said, and a way back to any of it.
   *
   * The list a person opens when work seems to have gone. It is deliberately
   * not only what the server accepted: their own unsent writes come first,
   * because a user asking where their work went is usually asking about
   * exactly those, and their drafts and refusals are in it too -- a refusal
   * is the one place a lost compare-and-swap leaves what they typed.
   *
   * RESTORING IS A NEW WRITE, and the dialog says so rather than calling it
   * an undo. Nothing is rewound: the version restored from is still in this
   * list afterwards, and a restore can be refused like any other write if
   * somebody moved the file on meanwhile.
   */
  import Clock from "@lucide/svelte/icons/clock";
  import Eye from "@lucide/svelte/icons/eye";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { Told } from "../history";
  import type { Workspace } from "../";
  import type { Id } from "../contract";
  import { Badge } from "./shadcn/ui/badge";
  import { Button } from "./shadcn/ui/button";
  import * as Dialog from "./shadcn/ui/dialog";
  import { localised } from "../minted";
  import { untrack } from "svelte";

  let {
    workspace,
    entry,
    path,
    open = $bindable(false),
    onRestored,
  }: {
    workspace: Workspace;
    entry: Id;
    path: string;
    open?: boolean;
    /** Told what was put back, so a caller can say so where the file is. */
    onRestored?: (version: string) => void;
  } = $props();

  const PAGE = 10;

  let versions = $state<Told[]>([]);
  let more = $state(false);
  /** Whether the server answered. False means this list is the outbox alone. */
  let told = $state(true);
  let reading = $state(false);
  let failure = $state<string | undefined>(undefined);
  let restoring = $state<string | undefined>(undefined);

  /**
   * The version being looked at, and what it says.
   *
   * Restoring is a change to the file, and asking somebody to make one from a
   * timestamp and a character count is asking them to guess. Reading is how
   * you find out whether this is the version you meant.
   */
  let showing = $state<string | undefined>(undefined);
  let said = $state<string | undefined>(undefined);
  let reading_version = $state(false);

  const look = async (version: Told) => {
    if (showing === version.transaction) {
      /** Clicking the open one closes it: the list is the thing being used. */
      showing = undefined;
      said = undefined;
      return;
    }
    showing = version.transaction;
    said = undefined;
    reading_version = true;
    try {
      const held = await workspace.at(entry, version.transaction);
      said =
        held.kind === "text"
          ? held.text
          : `${held.mime} — ${held.bytes.byteLength} bytes, which cannot be shown here.`;
    } catch (reason) {
      said = reason instanceof Error ? reason.message : String(reason);
    } finally {
      reading_version = false;
    }
  };

  /**
   * The cursor is the OLDEST accepted time on show, and queued work has none
   * -- it has not been accepted by anybody. So paging is anchored to the last
   * row the server actually gave us, and unsent work never moves the window.
   */
  const oldest = () =>
    [...versions].reverse().find((one) => one.at.accepted !== null)?.at
      .accepted;

  const read = async (again: boolean) => {
    if (reading) return;
    reading = true;
    failure = undefined;
    try {
      const before = again ? (oldest() ?? undefined) : undefined;
      const found = await workspace.history(entry, { before, limit: PAGE });
      versions = again ? [...versions, ...found.versions] : found.versions;
      more = found.more;
      told = found.told;
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    } finally {
      reading = false;
    }
  };

  /**
   * Re-read whenever it is opened rather than once: the queued half changes
   * as writes drain, and a list that was right when the dialog was first
   * opened would quietly stop being right.
   *
   * UNTRACKED, because reading writes state that reading looks at -- so an
   * effect that watched it would answer its own write and go round for ever.
   * The only thing this depends on is being opened.
   */
  $effect(() => {
    if (!open) return;
    untrack(() => void read(false));
  });

  const restore = async (version: Told) => {
    restoring = version.transaction;
    failure = undefined;
    try {
      const { settled } = await workspace.restore(entry, version.transaction);
      const answer = await settled;
      if (answer.rejected) {
        failure = `That version was not put back: ${answer.reason}`;
        return;
      }
      onRestored?.(version.transaction);
      open = false;
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    } finally {
      restoring = undefined;
    }
  };

  /**
   * When the USER acted, shown on the clock they were looking at.
   *
   * `minted` rather than `accepted`: after a week offline the two are days
   * apart, and the one a person recognises is the moment they typed it. Falls
   * back to the server's only when the client said nothing.
   */
  const when = (one: Told) => {
    const reading = localised(one.at);
    if (reading !== undefined) return reading.local.toUTCString().slice(0, 22);
    return one.at.accepted === null
      ? "just now"
      : new Date(one.at.accepted).toUTCString().slice(0, 22);
  };

  const says: Record<Told["standing"], string> = {
    queued: "not sent yet",
    applied: "saved",
    draft: "kept here",
    refused: "not accepted",
  };

  const tone = (standing: Told["standing"]) =>
    standing === "applied"
      ? "secondary"
      : standing === "refused"
        ? "destructive"
        : "outline";

  /** Sentinel at the end of the list: seeing it is asking for the next page. */
  let sentinel = $state<HTMLElement | undefined>(undefined);
  $effect(() => {
    const held = sentinel;
    if (held === undefined || held === null || !more) return;
    const watching = new IntersectionObserver((entries) => {
      if (entries.some((one) => one.isIntersecting)) void read(true);
    });
    watching.observe(held);
    return () => watching.disconnect();
  });
</script>

<Dialog.Root bind:open>
  <!--
    A COLUMN, not the grid the dialog is by default.
    A grid with no rows declared gives every child an `auto` track, so the
    list below sizes to its whole content, overflows the dialog's height, and
    is clipped by it -- which looks exactly like a panel that will not scroll,
    because that is what it is. The list needs a track that is bounded before
    `overflow-auto` on it means anything.
  -->
  <Dialog.Content
    class="flex max-h-[80dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
  >
    <Dialog.Header class="shrink-0 border-b px-5 py-4">
      <Dialog.Title class="flex items-center gap-2 text-base">
        <Clock class="size-4" />
        History of <span class="font-mono text-sm">{path}</span>
      </Dialog.Title>
      <Dialog.Description>
        Everything this file has said, newest first — including your own unsent
        and unaccepted writes. View one to see what it held; putting it back is
        a new change, not an undo.
      </Dialog.Description>
    </Dialog.Header>

    <div class="min-h-0 flex-1 overflow-auto px-2 py-2" data-region="history">
      {#if !told}
        <p
          class="text-muted-foreground px-3 py-2 text-xs"
          data-region="history-partial"
        >
          The server could not be reached, so this is only what has not been
          sent yet from this browser.
        </p>
      {/if}
      {#if failure}
        <p
          class="text-destructive px-3 py-2 text-sm"
          data-region="history-failed"
        >
          {failure}
        </p>
      {/if}

      {#each versions as version (version.transaction)}
        <div
          class="rounded-md"
          data-region="version"
          data-standing={version.standing}
          data-transaction={version.transaction}
        >
          <div
            class="hover:bg-muted/60 flex items-center gap-3 rounded-md px-3 py-2"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <Badge variant={tone(version.standing)} class="shrink-0">
                  {says[version.standing]}
                </Badge>
                <span class="text-muted-foreground truncate text-xs">
                  {when(version)}
                </span>
              </div>
              {#if version.why}
                <p class="text-muted-foreground mt-1 truncate text-xs">
                  {version.why}
                </p>
              {/if}
            </div>
            <span
              class="text-muted-foreground shrink-0 font-mono text-[0.7rem]"
            >
              {version.size === null ? "" : `${version.size} chars`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              data-region="preview-toggle"
              onclick={() => look(version)}
            >
              <Eye />
              {showing === version.transaction ? "Hide" : "View"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-region="restore"
              disabled={restoring !== undefined || version.kind !== "text"}
              onclick={() => restore(version)}
            >
              <RotateCcw />
              {restoring === version.transaction ? "Putting back…" : "Restore"}
            </Button>
          </div>

          {#if showing === version.transaction}
            <div class="px-3 pb-3" data-region="preview">
              {#if reading_version}
                <p class="text-muted-foreground text-xs">Reading…</p>
              {:else}
                <pre
                  class="bg-muted/60 max-h-56 overflow-auto rounded-md p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap">{said}</pre>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        {#if !reading}
          <p class="text-muted-foreground px-3 py-6 text-center text-sm">
            Nothing has been written to this file yet.
          </p>
        {/if}
      {/each}

      {#if more}
        <div bind:this={sentinel} class="p-2">
          <!-- A button as well as the observer: an observer that never fires
               -- a hidden panel, a browser that does not run it -- would
               leave the rest of the history unreachable with nothing to
               click. -->
          <Button
            variant="outline"
            size="sm"
            class="w-full"
            data-region="load-more"
            disabled={reading}
            onclick={() => read(true)}
          >
            {reading ? "Loading…" : "Load more"}
          </Button>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
