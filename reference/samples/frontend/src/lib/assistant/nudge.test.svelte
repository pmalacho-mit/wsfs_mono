<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { Toaster } from "../../../../../release/frontend/svelte/shadcn/ui/sonner";
  import Assistant from "../../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from ".../../../../../release/frontend/svelte/assistant/conversation.svelte";
  import { Nudge } from "../../../../../release/frontend/svelte/assistant/nudge";
  import { scripted } from "../harness/tutor";
  import {
    DEFAULTS,
    Stuck,
    type Episode,
    type Settings,
  } from "../../../../../release/frontend/svelte/assistant/stuck";

  /** The same phrasing the shell uses, so the assertions are about one thing. */
  const becauseOf = (episode: Episode) =>
    episode.rule === "the same error twice"
      ? `I keep getting the same error -- ${episode.detail}.`
      : "I am not sure what to do next here.";

  const until = async (what: string, ready: () => boolean, within = 8_000) => {
    const deadline = Date.now() + within;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}`);
      await new Promise((carry) => setTimeout(carry, 25));
    }
  };

  const IN_VIEW = ["/notebooks/analysis.py"];
  const ATTACHED = IN_VIEW.map((path, at) => ({
    entry: `entry-${at}`,
    path,
    executions: 0,
  }));
  const STUCK = "My last run ended in an error. Can you help?";

  class Pocket {
    readonly tutor = scripted();
    readonly conversation = new Conversation();
    readonly nudge = new Nudge();

    constructor() {
      this.conversation.attach(this.tutor.workspace as any, (entry) => entry);
    }

    ask = (text: string) =>
      this.conversation.ask(
        text,
        ATTACHED.map(({ entry, path }) => ({ entry, path, executions: [] })),
        "a-snapshot",
      );

    /**
     * A watcher wired to this panel exactly as the shell wires one, with the
     * settings the test wants rather than the ones a term wants.
     */
    watch(over: Partial<Settings> = {}) {
      const held = new Stuck({
        settings: { ...DEFAULTS, ...over },
        offer: (episode, forMs) =>
          this.nudge.offer(() => void this.ask(becauseOf(episode)), forMs),
      });
      return held;
    }

    /** What the workspace does when a run fails, minus the workspace. */
    offerHelp() {
      this.nudge.offer(() => void this.ask(STUCK));
    }
  }

  /** An offer on its way out is still in the document, and does not count. */
  const offered = (container: HTMLElement) =>
    container.querySelector("[data-sonner-toast]:not([data-removed='true'])");

  const takeOffer = (container: HTMLElement) =>
    [...(offered(container)?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Yes, show me",
    );
</script>

<!--
  Serial, and each test leaves the screen empty. Every toaster on the page
  draws every toast, so two of these running at once would each be looking at
  an offer the other one made.
-->
<Sweater config category="Nudge" mode="serial" />

<Sweater
  name="offers help when a run ends in an error"
  body={async ({ set, container, expect, capture, delay }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });

    expect(pocket.nudge.offered).toBe(true);
    expect(offered(container)?.textContent).toContain("Want a hint?");

    await capture("png").uri;

    pocket.nudge.withdraw();
    await delay({ seconds: 1 });
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render stage(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="taking the offer sends a message to the assistant"
  body={async ({ set, container, expect, capture, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });

    const take = takeOffer(container);
    expect(take).toBeDefined();

    await withUserFocus(async (user) => {
      await user.click(take!);
    });
    await delay({ frames: 4 });

    expect(pocket.conversation.turns[0]).toMatchObject({
      from: "user",
      text: STUCK,
    });
    expect(pocket.nudge.offered).toBe(false);

    await delay({ seconds: 2 });
    expect(pocket.conversation.turns).toHaveLength(2);
    expect(pocket.conversation.turns[1].from).toBe("assistant");
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render darkStage(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="withdraws the offer once the person is typing again"
  body={async ({ set, container, expect, delay }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });
    expect(offered(container)).not.toBeNull();

    pocket.nudge.withdraw();
    await delay({ seconds: 2 });

    expect(pocket.nudge.offered).toBe(false);
    expect(offered(container)).toBeNull();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render stage(pocket)}
  {/snippet}
</Sweater>

{#snippet stage(pocket: Pocket)}
  {@render lit(pocket, "")}
{/snippet}

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
{#snippet darkStage(pocket: Pocket)}
  {@render lit(pocket, "dark")}
{/snippet}

{#snippet lit(pocket: Pocket, mode: string)}
  <div
    class="bg-background text-foreground relative h-full w-full overflow-hidden {mode}"
    data-region="toast-stage"
  >
    <Toaster position="top-center" richColors closeButton />
    <Assistant
      conversation={pocket.conversation}
      attached={ATTACHED}
      onAsk={pocket.ask}
    />
  </div>
{/snippet}

<style>
  /* A toaster is fixed to the viewport, and a capture only sees the vest.
     Pinning it to this stage is what puts the offer in the picture. */
  :global([data-region="toast-stage"] [data-sonner-toaster]) {
    position: absolute;
  }
</style>

<Sweater
  name="a stuck episode randomized into an offer shows a prompt that goes on its own"
  body={async ({ set, container, expect, delay }) => {
    /**
     * The protocol on a real toast. `Stuck` itself is unit tested to the
     * millisecond in `tests/frontend/stuck.test.ts`; what this adds is that
     * an offered episode reaches a screen, and that it leaves again -- a
     * prompt that outstays its welcome stops being non-blocking, and an
     * ignored offer is only an answer if it can be ignored.
     */
    const pocket = set(new Pocket());
    const watching = pocket.watch({ offerRate: 1, banner: 400 });
    await delay({ frames: 2 });

    watching.ran({ ok: false, because: "NameError: a" });
    watching.ran({ ok: false, because: "NameError: b" });
    await until("the prompt to appear", () => !!offered(container));
    expect(watching.episodes.at(-1)!.became).toBe("offered");

    await until("the prompt to withdraw itself", () => !offered(container), 6_000);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render lit(pocket, "")}
  {/snippet}
</Sweater>

<Sweater
  name="a stuck episode randomized into silence shows nothing at all"
  body={async ({ set, container, expect, delay }) => {
    const pocket = set(new Pocket());
    const watching = pocket.watch({ offerRate: 0 });
    await delay({ frames: 2 });

    watching.ran({ ok: false, because: "TypeError: a" });
    watching.ran({ ok: false, because: "TypeError: b" });
    await delay({ frames: 6 });

    expect(watching.episodes.at(-1)!.became, "it was detected").toBe("silent");
    expect(offered(container), "and nothing was said about it").toBeNull();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render lit(pocket, "")}
  {/snippet}
</Sweater>

<Sweater
  name="a second episode inside the cooldown is recorded and not shown"
  body={async ({ set, container, expect, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    const watching = pocket.watch({ offerRate: 1, cooldown: 60_000 });
    await delay({ frames: 2 });

    watching.ran({ ok: false, because: "NameError: a" });
    watching.ran({ ok: false, because: "NameError: b" });
    await until("the first prompt", () => !!offered(container));

    /** Dismissed by the student, which the protocol says changes nothing:
     *  the cooldown began when it was SHOWN. */
    const take = takeOffer(container);
    if (take) await withUserFocus(async (user) => user.click(take));
    await delay({ frames: 4 });

    watching.ran({ ok: false, because: "ValueError: a" });
    watching.ran({ ok: false, because: "ValueError: b" });
    await delay({ frames: 6 });

    expect(watching.episodes.at(-1)!.became).toBe("held back by the cooldown");
    expect(
      watching.episodes.filter((one) => one.became === "offered"),
      "one prompt, not two",
    ).toHaveLength(1);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render lit(pocket, "")}
  {/snippet}
</Sweater>
