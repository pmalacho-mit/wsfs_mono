<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import WorkspaceFrame from "../../../../release/frontend/svelte/shell/WorkspaceFrame.svelte";
  import WorkspacePane from "../../../../release/frontend/svelte/shell/WorkspacePane.svelte";
  import { solo } from "$lib/harness/liveblocks";
  import {
    connect,
    http,
    type Faltering,
    type Keeping,
    type Reclamation,
    type Workspace as Client,
    startPersistence,
    createClient,
  } from "$wsfs";
  import { toast } from "svelte-sonner";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";

  const USER = "ada@example.com";
  const BACKEND = "/wsfs";

  /** What this page is looking at. A real host reads it off the route. */
  const TITLE = "Workspace Example";
  const EVENT = "Example";
  const COURSE = "Example";

  /** The sample's stand-in for a session. A real host sends a cookie. */
  const asUser = (email: string) => async () => ({ "X-User-Email": email });

  /**
   * Collaboration is opt-in: with a key, files are shared with whoever else
   * has the workspace open; without one the editor still works and still
   * saves, it is simply the only one in the room.
   */
  const key = import.meta.env.VITE_LIVEBLOCKS_KEY as string | undefined;

  console.log(key);

  let workspace = $state<Client | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  /**
   * The two things about storage a user has to be told, and neither of them
   * is an error the app can recover from on their behalf.
   */
  let storage = $state<Faltering | undefined>(undefined);
  /**
   * What the last pass at making room found. Only ONE of its answers is worth
   * a person's attention, and it is not the one about having succeeded.
   */
  let room = $state<Reclamation>({ phase: "idle" });
  let unwatch: (() => void) | undefined;
  let kept: Keeping | undefined;

  /**
   * Queued work whose bytes are gone. An event, not a state -- it happened
   * once, to particular changes -- so it is said the way this app says
   * things that happen, and it does not dismiss itself.
   */
  const cannotBeSent = (count: number) =>
    toast.error(
      count === 1
        ? "A change could not be sent"
        : `${count} changes could not be sent`,
      {
        description:
          "They were queued here and can no longer be read back. Anything you typed and did not see arrive may need typing again.",
        duration: Number.POSITIVE_INFINITY,
      },
    );

  const project = async (email: string) => {
    const response = await fetch("/projects", {
      method: "POST",
      headers: { "X-User-Email": email },
    });
    if (!response.ok)
      throw new Error(`could not open a project: ${response.status}`);
    return ((await response.json()) as { id: string }).id;
  };

  let id = $state("");
  let liveblocks = $state<ReturnType<typeof createClient>>();

  const start = async () => {
    try {
      const { searchParams } = page.url;
      const email = searchParams.get("user") ?? USER;
      id = searchParams.get("project") ?? (await project(email));
      const newUrl = new URL(page.url);
      newUrl.searchParams.set("user", email);
      newUrl.searchParams.set("project", id);
      goto(newUrl.href, { keepFocus: true });
      const persistence = await startPersistence(id, (issue, reclaiming) => {
        storage = issue;
        room = reclaiming;
      });

      unwatch = persistence.unwatch;

      liveblocks = createClient({
        authEndpoint: async (room) => {
          const answer = await fetch(
            `/liveblocks/token?rooms=${encodeURIComponent(room ?? "")}`,
            { headers: { "X-User-Email": email } },
          );
          if (!answer.ok)
            throw new Error(`token: ${answer.status} ${await answer.text()}`);
          return (await answer.json()) as { token: string };
        },
      });
      workspace = connect({
        workspace: id,
        transport: http(BACKEND, asUser(email)),
        bytes: persistence.database.bytes,
        kept: persistence.database.kept,
        restored: persistence.database.restored,
        lost: (entries) => cannotBeSent(entries.length),
      });
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    }
  };

  onMount(start);
  /**
   * Put down, and then waited for.
   *
   * A page that is navigating away can wait for the queue's bookkeeping to
   * reach the disk, and a page that is being killed cannot -- so the one that
   * can, does. Without it an answer still on its way is simply lost, and the
   * next visit calls work that is safely on the server unsettled.
   */
  onDestroy(() => {
    unwatch?.();
    workspace?.stop();
    void kept?.flushed();
  });
</script>

<!-- The frame fills whatever it is given, so the page is what says "all of
     it" -- a test gives it a card-sized box instead. -->
<div class="h-dvh w-full">
  <WorkspaceFrame title={TITLE} event={EVENT} course={COURSE}>
    {#if failure}
      <p class="text-destructive p-4 text-sm">{failure}</p>
    {:else if workspace && liveblocks}
      <WorkspacePane {workspace} {liveblocks} {storage} {room} courseEvent={EVENT} />
    {:else}
      <p class="text-muted-foreground p-4 text-sm">Opening a workspace…</p>
    {/if}
  </WorkspaceFrame>
</div>
