<script lang="ts">
  /**
   * A workspace, and the chrome that says which one.
   *
   * The workspace fills whatever it is given, so this is what decides that
   * "whatever" is the page minus the header.
   */
  import type { Snippet } from "svelte";
  import Header from "./Header.svelte";

  let {
    title,
    event,
    course,
    /** The host's own controls on the header strip. See `Header.svelte`. */
    destinations,
    actions,
    children,
  }: {
    title: string;
    event: string;
    course: string;
    destinations?: Snippet;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="bg-background text-foreground grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
  <Header {title} {event} {course} {destinations} {actions} />
  <main class="min-h-0">
    {@render children()}
  </main>
</div>
