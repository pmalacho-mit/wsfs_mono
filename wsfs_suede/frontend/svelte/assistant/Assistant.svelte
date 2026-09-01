<script lang="ts">
  /**
   * The assistant panel: what has been said, and the box that says the next
   * thing.
   *
   * It is handed the files rather than asking for them, so what a question
   * carries is decided by whoever knows what is on screen -- and so this can
   * be looked at, in a test, with any set of files at all.
   */
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import {
    Conversation as Transcript,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
  } from "../shadcn/ai-elements/conversation";
  import { Loader } from "../shadcn/ai-elements/loader";
  import {
    Message,
    MessageContent,
    MessageResponse,
  } from "../shadcn/ai-elements/message";
  import {
    PromptInput,
    PromptInputBody,
    PromptInputHeader,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputToolbar,
    PromptInputTools,
    type PromptInputMessage,
  } from "../shadcn/ai-elements/prompt-input";
  //import { Suggestion, Suggestions } from "../shadcn/ai-elements/suggestion";
  import PanelHeading from "../shell/PanelHeading.svelte";
  import TextSizeSlider from "../shell/TextSizeSlider.svelte";
  import AttachedFiles from "./AttachedFiles.svelte";
  import type { Conversation } from "./conversation.svelte";
  import type { Id } from "../../contract";
  import { Button } from "../shadcn/ui/button";
  import { TextSize } from "../textsize.svelte";

  let {
    conversation,
    attached,
    oninput,
    onAsk,
    /**
     * How big this panel's text is.
     *
     * Handed in, because a workspace remembers one size for this panel and
     * the panel is drawn by whoever is holding that. Its own when nobody
     * says -- which is what makes this component something a test, or any
     * other host, can put on a page by itself.
     */
    textSize = new TextSize("assistant"),
  }: {
    conversation: Conversation;
    /** What goes with the next question, and how much goes with each. */
    attached: { entry: Id; path: string; executions: number }[];
    oninput?: (input: Event) => void;
    /** Asks, once whoever knows what is on screen has said what that is. */
    onAsk?: (text: string) => void;
    textSize?: TextSize;
  } = $props();

  /** Streamdown's shadcn base leaves lists unmarked. These are the markers. */
  const LISTS =
    "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5";

  const openers = ["Explain this file", "Why did it fail?", "Write a test"];

  const ask = (text: string) => onAsk?.(text);

  /**
   * Asking for older turns when somebody scrolls to the top of them.
   *
   * A sentinel and an observer rather than a scroll handler, for the same
   * reason the version history uses one: it fires once when the top comes into
   * view instead of on every pixel of every scroll.
   */
  let earlier = $state<HTMLElement | undefined>(undefined);
  $effect(() => {
    const held = earlier;
    if (held === undefined || !conversation.more) return;
    const watching = new IntersectionObserver((entries) => {
      if (entries.some((one) => one.isIntersecting)) void conversation.earlier();
    });
    watching.observe(held);
    return () => watching.disconnect();
  });
</script>

<section
  class="bg-sidebar grid h-full min-h-0 w-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
  data-region="assistant"
  data-text-scale
  style:--wsfs-text-scale={textSize.scale}
>
  <PanelHeading label="Assistant" icon={MessagesSquare}>
    {#snippet controls()}
      <TextSizeSlider size={textSize} label="Assistant text size" />
    {/snippet}
  </PanelHeading>

  <Transcript class="min-h-0 min-w-0">
    <ConversationContent class="gap-6 p-3">
      {#if conversation.failed}
        <!--
          An unreadable transcript must not look like an empty one. What is on
          the server is still there; this says so, and offers to go again.
        -->
        <div
          class="border-destructive/30 bg-destructive/10 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          data-region="transcript-failed"
        >
          <p class="text-destructive min-w-0 text-xs">
            Your earlier conversation could not be loaded. It has not been
            lost — {conversation.failed}
          </p>
          <Button
            variant="outline"
            size="sm"
            class="shrink-0"
            data-region="transcript-retry"
            disabled={conversation.reading}
            onclick={() => conversation.reload()}
          >
            {conversation.reading ? "Trying…" : "Try again"}
          </Button>
        </div>
      {/if}
      {#if conversation.more}
        <!-- Seeing this is asking for the page before it; the button is for
             a browser that never fires the observer, and for somebody who
             would rather click than scroll. -->
        <div bind:this={earlier} class="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            data-region="earlier"
            disabled={conversation.reading}
            onclick={() => conversation.earlier()}
          >
            {conversation.reading ? "Loading…" : "Earlier questions"}
          </Button>
        </div>
      {/if}
      {#each conversation.turns as turn (turn.id)}
        <Message from={turn.from} data-turn={turn.id} data-from={turn.from}>
          <MessageContent>
            <MessageResponse content={turn.text} class={LISTS} />
            {#if turn.failed}
              <p
                class="text-destructive mt-2 text-xs"
                data-region="answer-failed"
              >
                The tutor stopped before finishing: {turn.failed}
              </p>
            {/if}
          </MessageContent>
        </Message>
      {:else}
        <ConversationEmptyState
          title="Ask about what you are looking at"
          description="Whatever is open in the dock goes along with your question."
        >
          {#snippet icon()}
            <MessagesSquare class="size-6" />
          {/snippet}
        </ConversationEmptyState>
      {/each}
      {#if conversation.pending}
        <Message from="assistant" data-region="pending">
          <MessageContent>
            <Loader />
          </MessageContent>
        </Message>
      {/if}
    </ConversationContent>
    <ConversationScrollButton />
  </Transcript>

  <div class="flex min-w-0 flex-col gap-2 border-t p-3">
    <!-- {#if conversation.turns.length === 0}
      <Suggestions>
        {#each openers as opener (opener)}
          <Suggestion suggestion={opener} onclick={ask} />
        {/each}
      </Suggestions>
    {/if} -->
    <PromptInput onSubmit={(message: PromptInputMessage) => ask(message.text)}>
      <PromptInputHeader class="border-b px-3 py-2">
        <AttachedFiles {attached} />
      </PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea
          placeholder="Ask about the files in view…"
          {oninput}
        />
      </PromptInputBody>
      <PromptInputToolbar class="px-2 pb-2">
        <PromptInputTools />
        <PromptInputSubmit status={conversation.status} />
      </PromptInputToolbar>
    </PromptInput>
  </div>
</section>
