<script lang="ts">
  /**
   * What sits above a workspace: where you can go, what you are looking at,
   * and how it should be painted.
   *
   * The middle column names the workspace twice over -- once by its own name
   * and once by the course event it belongs to -- because the same workspace
   * exists for several events and the name alone does not say which.
   */
  import type { Snippet } from "svelte";
  import CircleHelpIcon from "@lucide/svelte/icons/circle-help";
  import { Button } from "../shadcn/ui/button";
  import { Separator } from "../shadcn/ui/separator";
  import * as Tooltip from "../shadcn/ui/tooltip";
  import ModeToggle from "./ModeToggle.svelte";
  import { navigation } from "./navigation";

  let {
    title,
    event,
    course,
    /**
     * MORE PLACES TO GO, beside the ones this shell knows about.
     *
     * Rendered inside the nav rather than beside it, because that is what it
     * is: a control that takes you to a different workspace belongs with the
     * other controls that take you somewhere, under the same landmark a
     * screen reader is given to find them by.
     */
    destinations,
    /**
     * What the HOST does to THIS workspace, beside the one control this shell
     * owns.
     *
     * The right of the strip is where a thing that acts on what you are
     * looking at goes -- sharing it, painting it -- as against the left,
     * which is where you go to stop looking at it.
     *
     * Both halves are holes because both answers belong to a particular
     * backend: who owns this, what a link to it looks like, which of them you
     * are subscribed to. None of that is something a shell can answer or
     * should have to carry.
     */
    actions,
  }: {
    title: string;
    event: string;
    course: string;
    destinations?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<header
  class="bg-background/95 supports-[backdrop-filter]:bg-background/75 grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-3 backdrop-blur"
  data-region="header"
>
  <nav class="flex items-center gap-1" aria-label="Workspace navigation">
    {#each navigation as destination (destination.label)}
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                aria-label={destination.label}
                onclick={destination.go}
              >
                <destination.icon />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="bottom">{destination.label}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/each}
    {#if destinations}{@render destinations()}{/if}
  </nav>

  <div class="flex min-w-0 flex-col items-center text-center" data-region="workspace-identity">
    <h1 class="truncate text-sm leading-tight font-semibold">{title}</h1>
    <p class="text-muted-foreground truncate text-xs leading-tight">
      {course}: {event}
    </p>
  </div>

  <div class="flex items-center justify-end gap-1">
    <!-- <Button variant="ghost" size="icon-sm" aria-label="Help">
      <CircleHelpIcon />
    </Button> -->
    {#if actions}
      {@render actions()}
      <Separator orientation="vertical" class="mx-1 h-5" />
    {/if}
    <ModeToggle />
  </div>
</header>
