<script lang="ts">
  /**
   * What the person was asked to write, above the file they are writing it in.
   *
   * Expanded on mount and collapsible from there. A panel mounts when the file
   * is opened, so "expanded when it opens" is the same statement as "expanded
   * on mount" -- nothing is remembered between openings on purpose: the
   * problem is the first thing to read, every time the file is opened.
   *
   * Capped and scrolled rather than allowed to grow. A long problem otherwise
   * takes the whole panel and pushes the editor -- the thing being worked in
   * -- off the bottom of it.
   */
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ClipboardList from "@lucide/svelte/icons/clipboard-list";
  import { MessageResponse } from "./shadcn/ai-elements/message";

  let {
    content,
    label = "The problem",
  }: { content: string; label?: string } = $props();

  let open = $state(true);

  /** Streamdown's shadcn base leaves lists unmarked. These are the markers,
   *  and the sizes that keep a problem statement smaller than the code. */
  const PROSE =
    "text-sm leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 " +
    "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_pre]:text-xs " +
    "[&_code]:text-xs [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm";

  /**
   * The first line of it, for the collapsed bar -- so a header that is folded
   * away still says which problem it is folded away from. Markdown's markers
   * are stripped rather than rendered: this is one line of plain text in a
   * row that has no room to be anything else.
   */
  const opening = $derived(
    (content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("```")) ?? "")
      // `$` joins the markers for the same reason the rest are here: this row
      // renders nothing, so a delimiter left in it is punctuation the reader
      // has to look past rather than maths they get to read.
      .replace(/[*_`#>$]/g, "")
      .trim(),
  );
</script>

<section
  class="bg-muted/40 flex min-h-0 min-w-0 flex-col border-b"
  data-region="problem-header"
>
  <button
    type="button"
    class="hover:bg-muted/70 flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-left"
    data-region="problem-header-toggle"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <ChevronDown
      class="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 {open
        ? ''
        : '-rotate-90'}"
    />
    <ClipboardList class="text-muted-foreground size-3.5 shrink-0" />
    <!-- A span rather than a heading: a button may only hold phrasing
         content, and this one is the whole bar so that the target is the bar. -->
    <span
      class="text-muted-foreground shrink-0 font-semibold tracking-[0.08em] uppercase text-(length:--text-2xs)"
    >
      {label}
    </span>
    {#if !open}
      <!-- Only when folded: open, it would repeat the line underneath it. -->
      <span class="text-muted-foreground/80 truncate text-xs" data-region="problem-header-opening">
        {opening}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      class="max-h-56 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-3 pt-0.5 pb-3"
      data-region="problem-header-body"
    >
      <MessageResponse {content} class={PROSE} />
    </div>
  {/if}
</section>
