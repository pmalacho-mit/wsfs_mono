<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Assistant from "../../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from "../../../../../release/frontend/svelte/assistant/conversation.svelte";
  import { scripted } from "../harness/tutor";

  const IN_VIEW = ["/notebooks/analysis.py", "/data/readings.csv"];
  /** The same files, as the component wants them: with what goes along. */
  const ATTACHED = IN_VIEW.map((path, at) => ({
    entry: `entry-${at}`,
    path,
    executions: 0,
  }));

  /**
   * A transcript as the server hands one back.
   *
   * Given in the order they were asked and returned NEWEST FIRST, because
   * that is what the wire does -- and getting it the other way round here
   * would quietly test the panel against a shape it never sees.
   */
  const told = (questions: string[]) =>
    [...questions].reverse().map((text, at) => ({
      message: `told-${at}`,
      at: { minted: null, offset: null, accepted: `2026-08-24T0${at}:00:00Z` },
      text,
      snapshot: null,
      attached: [],
      answer: `answer to ${text}`,
      failure: null,
      model: "scripted",
    }));

  /** A transcript whose answer contains a fenced block, as a real one does. */
  const withCode = () => [
    {
      message: "told-code",
      at: { minted: null, offset: null, accepted: "2026-08-24T00:00:00Z" },
      text: "show me a decorator",
      snapshot: null,
      attached: [],
      answer:
        "Here is one:\n\n```python\ndef logger(func):\n    return func\n```\n\nThat is the shape.",
      failure: null,
      model: "scripted",
    },
  ];

  const bubbles = (within: HTMLElement) => [
    ...within.querySelectorAll("[data-turn]"),
  ] as HTMLElement[];

  const until = async (what: string, ready: () => boolean, within = 8_000) => {
    const deadline = Date.now() + within;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}`);
      await new Promise((carry) => setTimeout(carry, 25));
    }
  };

  class Pocket {
    readonly tutor: ReturnType<typeof scripted>;
    readonly conversation = new Conversation();
    attached = $state<{ entry: string; path: string; executions: number }[]>(
      ATTACHED,
    );

    constructor(told: any[] = [], more = false, breaks = 0) {
      /** A tutor that answers at once and always the same -- see `scripted`. */
      this.tutor = scripted(told, more);
      /** Broken BEFORE attaching, because attaching is what reads. */
      this.tutor.breaks(breaks);
      this.conversation.attach(this.tutor.workspace as any, (entry) => entry);
    }

    /** What the shell does for real: name the files, then ask. */
    ask = (text: string) =>
      this.conversation.ask(
        text,
        this.attached.map(({ entry, path }) => ({ entry, path, executions: [] })),
        "a-snapshot",
      );
  }
</script>

<!-- Side by side, so each panel is a column the width of a real sidebar. -->
<Sweater config category="Assistant" />

<Sweater
  name="names the files a question would carry"
  body={async ({ set, container, expect, capture, delay }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });

    const attached = () =>
      container.querySelector("[data-region='attached-files']");
    expect(attached()?.textContent).toContain("analysis.py");
    expect(attached()?.textContent).toContain("readings.csv");
    expect(
      container.querySelectorAll("[data-region='attached-files'] [data-path]"),
    ).toHaveLength(2);
    // Awaited, because the next line changes what a later read would find.
    await capture("png").uri;

    pocket.attached = [];
    await delay({ frames: 2 });
    expect(
      container.querySelector("[data-region='attached-none']"),
    ).not.toBeNull();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a sent question keeps the files that were in view"
  body={async ({ set, container, expect, capture, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    const box = container.querySelector("textarea");
    expect(box).not.toBeNull();

    await withUserFocus(async (user) => {
      await user.click(box!);
      await user.type(box!, "Why is this slow?");
    });
    capture("png");

    await withUserFocus(async (user) => {
      await user.type(box!, "{Enter}");
    });
    await delay({ frames: 4 });

    expect(pocket.conversation.turns[0]).toMatchObject({
      from: "user",
      text: "Why is this slow?",
      sent: IN_VIEW,
    });

    await delay({ seconds: 2 });
    expect(pocket.conversation.turns).toHaveLength(2);
    expect(pocket.conversation.turns[1].from).toBe("assistant");
    expect(pocket.conversation.status).toBe("ready");
    capture("png");
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a suggestion asks the same way typing does"
  body={async ({ set, container, expect, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    /**
     * The submit button rather than the first button on the panel: an answer
     * arriving now puts a scroll control in the transcript, so "the first
     * button" stopped meaning this one. Asking by clicking is the path a
     * suggestion takes, whichever control starts it.
     */
    const box = container.querySelector("textarea");
    await withUserFocus(async (user) => {
      await user.click(box!);
      await user.type(box!, "Why is this slow?");
      await user.click(container.querySelector("[type='submit']")!);
    });
    await delay({ seconds: 2 });
    expect(pocket.conversation.turns[0].sent).toEqual(IN_VIEW);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
<Sweater
  name="paints from the same tokens in dark"
  body={async ({ set, capture, delay }) => {
    const pocket = set(new Pocket());
    void pocket.ask("What does this file do?");
    await delay({ seconds: 2 });
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="dark bg-background text-foreground h-full w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={pocket.attached}
        onAsk={pocket.ask}
      />
    </div>
  {/snippet}
</Sweater>

{#snippet panel(pocket: Pocket)}
  <div class="bg-background h-full w-full">
    <Assistant
      conversation={pocket.conversation}
      attached={pocket.attached}
      onAsk={pocket.ask}
    />
  </div>
{/snippet}

<Sweater
  name="says how many runs go with each attached file"
  body={async ({ set, container, expect, capture, delay }: any) => {
    /**
     * What goes with the question, not just which files. A script that has
     * been run three times carries three runs' output, and the person asking
     * should be able to see that before they send it.
     */
    const pocket = set(new Pocket());
    pocket.attached = [
      { path: "/notebooks/analysis.py", executions: 3 },
      { path: "/data/readings.csv", executions: 0 },
    ];
    await delay({ frames: 2 });

    const badges = [...container.querySelectorAll("[data-path]")];
    expect(badges).toHaveLength(2);
    const said = (element: Element) =>
      element.textContent!.replace(/\s+/g, " ").trim();
    expect(said(badges[0]!)).toContain("3 runs");
    /** Nothing said for a file nobody has run: a zero is noise. */
    expect(said(badges[1]!)).not.toContain("run");
    await capture("png").uri;

    /** And it follows the file, so clearing the output window shows here. */
    pocket.attached = [
      { path: "/notebooks/analysis.py", executions: 0 },
      { path: "/data/readings.csv", executions: 0 },
    ];
    await delay({ frames: 2 });
    expect(
      container.querySelectorAll("[data-region='attached-runs']"),
    ).toHaveLength(0);

    /** One run reads as one run rather than "1 runs". */
    pocket.attached = [{ path: "/notebooks/analysis.py", executions: 1 }];
    await delay({ frames: 2 });
    expect(said(container.querySelector("[data-region='attached-runs']")!)).toContain(
      "1 run",
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[28rem] w-full">
      <Assistant conversation={pocket.conversation} attached={pocket.attached} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="opens on the conversation it already had"
  body={async ({ set, container, expect, delay, capture }) => {
    const pocket = set(new Pocket(told(["what is a dict?", "how do I sort?"])));
    await delay({ frames: 4 });
    await until("the transcript to arrive", () => bubbles(container).length >= 4);

    /**
     * Oldest at the top, and each question followed by its answer -- which is
     * the order they were said in, and the order a chat is read in.
     */
    expect(bubbles(container).map((one) => one.getAttribute("data-from"))).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(bubbles(container)[0]!.textContent).toContain("what is a dict?");
    expect(bubbles(container)[1]!.textContent).toContain("answer to what is a dict?");
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="an answer arrives a piece at a time"
  body={async ({ set, container, expect, delay }) => {
    const pocket = set(new Pocket());
    pocket.tutor.says("Because ", "the loop ", "never ends.");
    await delay({ frames: 2 });

    const asking = pocket.ask("why is this slow?");
    /**
     * Caught in the MIDDLE, which is the whole claim: a partial answer is on
     * screen before the whole one is. Without this the test would pass against
     * a panel that waited and painted once.
     */
    await until(
      "part of the answer to be showing",
      () => {
        const said = bubbles(container).at(-1)?.textContent ?? "";
        return said.startsWith("Because") && !said.includes("never ends.");
      },
      4_000,
    );
    await asking;

    expect(bubbles(container).at(-1)!.textContent).toContain(
      "Because the loop never ends.",
    );
    expect(pocket.conversation.status).toBe("ready");
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="scrolling back asks for what came before"
  body={async ({ set, container, expect, delay }) => {
    const pocket = set(new Pocket(told(["the newest one"]), true));
    await delay({ frames: 4 });
    await until("the first page", () => bubbles(container).length >= 2);

    /**
     * ASKED WITHOUT ANYBODY CLICKING. The offer sits at the top of the list,
     * so on a short conversation it is already on screen and the observer
     * fires straight away -- which is the behaviour: scrolling to the top
     * fetches what is above it, and a list that starts at the top is already
     * there.
     */
    await until(
      "the page before this one to be asked for",
      () => pocket.tutor.reads().length >= 2,
    );
    expect(pocket.tutor.reads()[0], "the first read is the newest page").toBe(
      undefined,
    );
    expect(
      pocket.tutor.reads()[1],
      "and the next asks from the oldest it has",
    ).toBe("2026-08-24T00:00:00Z");

    /** And then it stops: there is nothing older, so nothing offers to load
     *  it, and the observer has nothing left to fire on. */
    await until(
      "the offer to go once there is nothing older",
      () => pocket.conversation.more === false,
    );
    await delay({ frames: 4 });
    expect(container.querySelector("[data-region='earlier']")).toBeNull();
    expect(pocket.tutor.reads()).toHaveLength(2);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="an answer that stops halfway says so"
  body={async ({ set, container, expect, delay, capture }) => {
    const pocket = set(new Pocket());
    pocket.tutor.says("I was about to say");
    pocket.tutor.fails("the model hung up");
    await delay({ frames: 2 });

    await pocket.ask("explain this");
    await delay({ frames: 4 });

    /** Half an answer is still what the person was shown, so it stays -- and
     *  the panel says why there is no more of it. */
    expect(bubbles(container).at(-1)!.textContent).toContain("I was about to say");
    const said = container.querySelector("[data-region='answer-failed']");
    expect(said, "the panel says it stopped").not.toBeNull();
    expect(said!.textContent).toContain("the model hung up");
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a long conversation scrolls, and starts at the newest"
  body={async ({ set, container, expect, delay, capture }) => {
    /**
     * The complaint this exists for: ask enough and the answer goes off the
     * bottom with no way to reach it. A transcript that cannot scroll does not
     * hide the newest message, it CUTS IT OFF -- so this asserts the panel is
     * a scroller and that it is looking at the end of the list.
     */
    const pocket = set(
      new Pocket(
        told(
          Array.from({ length: 12 }, (_, at) => `question number ${at} about a file`),
        ),
      ),
    );
    await delay({ frames: 4 });
    await until("the transcript to arrive", () => bubbles(container).length >= 24);
    await delay({ frames: 6 });

    const scroller = container.querySelector(
      "[role='log'] > div",
    ) as HTMLElement;
    expect(scroller, "the transcript's scrolling element").not.toBeNull();

    /** More content than room for it, which is the whole premise. */
    expect(
      scroller.scrollHeight,
      `scrollHeight ${scroller.scrollHeight} vs client ${scroller.clientHeight}`,
    ).toBeGreaterThan(scroller.clientHeight + 20);

    /** And it can actually be moved, which is what `overflow` buys. */
    scroller.scrollTop = 0;
    await delay({ frames: 2 });
    expect(scroller.scrollTop, "scrolled to the top").toBe(0);
    scroller.scrollTop = scroller.scrollHeight;
    await delay({ frames: 2 });
    expect(scroller.scrollTop, "and back to the bottom").toBeGreaterThan(0);
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[28rem] w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={pocket.attached}
        onAsk={pocket.ask}
      />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="a transcript that will not load says so, and tries again"
  body={async ({ set, container, expect, delay, withUserFocus }) => {
    /**
     * The failure this exists for: one unreadable transcript at load used to
     * be indistinguishable from having never said anything, so somebody whose
     * conversation was safely on the server saw an empty panel and concluded
     * it was gone.
     */
    /** More failures than the read will tolerate, so it gives up and says so. */
    const pocket = set(new Pocket(told(["what did I ask before?"]), false, 10));
    await delay({ frames: 2 });

    await until(
      "the panel to admit it could not read the transcript",
      () => !!container.querySelector("[data-region='transcript-failed']"),
      12_000,
    );
    /** Whitespace-normalised: the sentence wraps across lines in the markup. */
    const said = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(said).toContain("could not be loaded");
    expect(said).toContain("It has not been lost");

    /** And going again works, once whatever it was has passed. */
    pocket.tutor.breaks(0);
    const retry = container.querySelector(
      "[data-region='transcript-retry']",
    ) as HTMLElement;
    await withUserFocus(async (user) => user.click(retry));
    await until(
      "the conversation to arrive on the second try",
      () => bubbles(container).length >= 2,
    );
    expect(container.querySelector("[data-region='transcript-failed']")).toBeNull();
    expect(bubbles(container)[0]!.textContent).toContain("what did I ask before?");
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a read that loses a race is retried rather than left empty"
  body={async ({ set, container, expect, delay }) => {
    /** One failure, which is what a page opening everything at once produces
     *  -- and the read now has more than one go, so nobody sees it. */
    const pocket = set(new Pocket(told(["still here"]), false, 1));
    await delay({ frames: 2 });

    await until("the conversation to arrive anyway", () => bubbles(container).length >= 2);
    expect(container.querySelector("[data-region='transcript-failed']")).toBeNull();
    expect(pocket.tutor.reads().length).toBeGreaterThanOrEqual(2);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a code block in an answer can be copied and downloaded"
  body={async ({ set, container, expect, delay, capture }) => {
    /**
     * The tutor answers with code more often than not, so the two controls on
     * a code block are part of the feature rather than decoration. Both were
     * doing nothing, and a button that does nothing looks exactly like one
     * that is not there.
     */
    const pocket = set(new Pocket(withCode()));
    await delay({ frames: 4 });
    await until("the answer to arrive", () => bubbles(container).length >= 2);
    await until(
      "the code block to be highlighted",
      () => !!container.querySelector("[data-streamdown='code-block']"),
      12_000,
    );
    await delay({ frames: 6 });

    const buttons = [
      ...container.querySelectorAll(
        "[data-streamdown='code-block-actions'] button",
      ),
    ] as HTMLButtonElement[];
    expect(buttons.length, "a download and a copy button").toBe(2);
    for (const button of buttons)
      expect(button.disabled, `${button.title} is clickable`).toBe(false);

    /**
     * HIT-TESTED, not just present. These sit in a sticky shell that is pulled
     * up over the header, so "rendered" and "reachable by a pointer" are two
     * different claims and only the second one matters to somebody clicking.
     */
    for (const button of buttons) {
      /**
       * Brought into view first. These tests share one page, so a control
       * that is off-screen would be hit-tested against whatever else happens
       * to occupy those viewport coordinates -- another test's panel.
       */
      button.scrollIntoView({ block: "center" });
      await delay({ frames: 2 });
      const { left, top, width, height } = button.getBoundingClientRect();
      const at = container.ownerDocument.elementFromPoint(
        left + width / 2,
        top + height / 2,
      );
      const shell = button.closest(
        "[data-streamdown='code-block-actions-shell']",
      ) as HTMLElement;
      const inner = button.parentElement as HTMLElement;
      const seen = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          pointer: style.pointerEvents,
          position: style.position,
          z: style.zIndex,
          margin: style.marginTop,
          box: `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`,
        };
      };
      expect(
        button.contains(at) || button === at,
        `${button.title}: click landed on ${at?.tagName}.${String((at as HTMLElement)?.className).slice(0, 40)} | ` +
          `button ${JSON.stringify(seen(button))} | inner ${JSON.stringify(seen(inner))} | ` +
          `shell ${JSON.stringify(seen(shell))}`,
      ).toBe(true);
    }
    /**
     * ON THE LANGUAGE'S ROW, which is the other half of the complaint. The
     * controls are lifted onto the header by a negative margin; without it
     * they drop to a row of their own and leave the header looking like an
     * empty bar with the language stranded at one end. Compared by centre
     * line, so this says "beside" rather than "within a pixel".
     */
    const header = container.querySelector(
      "[data-streamdown='code-block-header']",
    ) as HTMLElement;
    const shellOf = buttons[0]!.closest(
      "[data-streamdown='code-block-actions-shell']",
    ) as HTMLElement;
    const middle = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    expect(
      Math.abs(middle(header) - middle(shellOf)),
      `header centre ${middle(header)} vs controls ${middle(shellOf)}`,
    ).toBeLessThan(10);

    /**
     * AND THEY DO SOMETHING. Reachable is not the same as wired, and "nothing
     * happens" was the whole complaint -- so this watches the two APIs the
     * controls end in and clicks them for real.
     */
    const window_ = container.ownerDocument.defaultView as any;
    const copied: string[] = [];
    const saved: Blob[] = [];
    const clipboard = window_.navigator.clipboard;
    const madeUrl = window_.URL.createObjectURL;
    Object.defineProperty(window_.navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
    window_.URL.createObjectURL = (blob: Blob) => (
      saved.push(blob), "blob:stubbed"
    );
    try {
      const download = buttons.find((one) => /download/i.test(one.title))!;
      const copy = buttons.find((one) => /cop/i.test(one.title))!;
      download.click();
      copy.click();
      await until("the copy to reach the clipboard", () => copied.length === 1);
    } finally {
      Object.defineProperty(window_.navigator, "clipboard", {
        value: clipboard,
        configurable: true,
      });
      window_.URL.createObjectURL = madeUrl;
    }

    expect(copied[0], "the code, and only the code").toBe(
      "def logger(func):\n    return func",
    );
    expect(saved, "one file offered for download").toHaveLength(1);
    expect(await saved[0]!.text()).toContain("def logger(func):");
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[30rem] w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={pocket.attached}
        onAsk={pocket.ask}
      />
    </div>
  {/snippet}
</Sweater>
