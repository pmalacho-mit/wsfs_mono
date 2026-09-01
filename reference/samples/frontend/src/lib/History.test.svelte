<script lang="ts">
  /**
   * The history a person actually opens, against a real backend.
   *
   * What only a browser can answer: that the line is there on an open file,
   * that clicking it lists what the file has said, that unsent work is in
   * that list ahead of what the server holds, and that Restore puts old text
   * back where the user can see it.
   *
   * The merge itself is unit-tested in `tests/frontend/history.test.ts`; what
   * this adds is the wire and the DOM.
   */
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { setMode, resetMode } from "mode-watcher";
  import { connect, http, inMemory, mint, type Workspace as Client } from "$wsfs";
  import { switchable } from "./harness/collaboration";
  import History from "../../../../release/frontend/svelte/History.svelte";
  import { project } from "./harness/testing.svelte";

  const BACKEND = "/wsfs";
  const USER = "ada@example.com";
  const asUser = (email: string) => async () => ({ "X-User-Email": email });

  class Pocket {
    workspace = $state<Client>();
    wire = $state<ReturnType<typeof switchable>>();
    entry = $state("");
    path = $state("history.py");
    open = $state(false);
    said = $state("");

    async start() {
      const id = await project(USER);
      const wire = switchable(http(BACKEND, asUser(USER)));
      this.wire = wire;
      const workspace = connect({
        workspace: id,
        transport: wire,
        bytes: inMemory(),
      });
      this.workspace = workspace;
      /** A moment for Initialize, so the create below has a workspace to land in. */
      await new Promise((carry) => setTimeout(carry, 400));
      const made = workspace.create(this.path, "one\n");
      this.entry = made.entry;
      await made.settled;
      return workspace;
    }

    dispose() {
      this.workspace?.stop();
    }
  }

  /**
   * The rows of THIS test's dialog.
   *
   * A dialog renders into the document rather than into the box the test was
   * given, and these run one after another in one page -- so an earlier
   * test's list is still reachable from `querySelectorAll`. The newest one is
   * the one this test just opened.
   */
  const rows = (within: HTMLElement) => {
    const lists = [
      ...within.ownerDocument.querySelectorAll("[data-region='history']"),
    ];
    const mine = lists.at(-1);
    return mine === undefined
      ? []
      : [...mine.querySelectorAll("[data-region='version']")];
  };

  const preview = (within: HTMLElement) => {
    const lists = [
      ...within.ownerDocument.querySelectorAll("[data-region='history']"),
    ];
    return lists.at(-1)?.querySelector("[data-region='preview']") ?? null;
  };

  const partial = (within: HTMLElement) => {
    const lists = [
      ...within.ownerDocument.querySelectorAll("[data-region='history']"),
    ];
    return lists.at(-1)?.querySelector("[data-region='history-partial']") ?? null;
  };

  const until = async (
    what: string,
    ready: () => boolean,
    within = 15_000,
    look?: () => Promise<void>,
  ): Promise<void> => {
    const deadline = Date.now() + within;
    for (;;) {
      await look?.();
      if (ready()) return;
      if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}`);
      await new Promise((carry) => setTimeout(carry, 100));
    }
  };
</script>

<Sweater config category="History" orientation="vertical" mode="serial" />

<Sweater
  name="lists what the file has said, newest first"
  body={async ({ set, container, expect, capture, delay, onAbort }: any) => {
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    let at = workspace.entries().get(pocket.entry)!.content_version!;
    for (const said of ["two\n", "three\n"]) {
      const written = workspace.write(pocket.path, said);
      await written.settled;
      at = written.transaction;
    }

    pocket.open = true;
    await delay({ frames: 4 });
    await until("the versions to arrive", () => rows(container).length >= 3);

    const standing = rows(container).map((row) =>
      row.getAttribute("data-standing"),
    );
    expect(standing.slice(0, 3)).toEqual(["applied", "applied", "applied"]);
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[30rem] w-full">
      {#if pocket.workspace}
        <History
          workspace={pocket.workspace}
          entry={pocket.entry}
          path={pocket.path}
          bind:open={pocket.open}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="shows work that has not been sent, ahead of what has"
  body={async ({ set, container, expect, capture, delay, onAbort }: any) => {
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    /**
     * The half the server cannot see, and the half a person asking where
     * their work went usually means.
     */
    pocket.wire!.reachable(false);
    const stranded = workspace.write(pocket.path, "typed with no server\n");
    void stranded.settled.catch(() => undefined);
    await delay({ milliseconds: 300 });

    /**
     * Opened while STILL unreachable, because that is the whole case: the
     * person who cannot reach the server is the one asking where their work
     * went, and the outbox is the only place the answer is.
     */
    pocket.open = true;
    await delay({ frames: 4 });
    await until("the queued write to be listed", () => rows(container).length >= 1);

    /**
     * ONE row, and it is the unsent one. The server holds three versions of
     * this file and could not be asked for them, so the list is the outbox
     * alone -- which is the half that was ever at risk, and the half this
     * person is asking about.
     */
    const found = rows(container);
    expect(found).toHaveLength(1);
    expect(found[0]!.getAttribute("data-standing")).toBe("queued");
    expect(found[0]!.getAttribute("data-transaction")).toBe(stranded.transaction);
    expect(found[0]!.textContent).toContain("not sent yet");

    /** And it says it is partial rather than looking like the whole history. */
    expect(partial(container)).not.toBeNull();

    pocket.wire!.reachable(true);
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[30rem] w-full">
      {#if pocket.workspace}
        <History
          workspace={pocket.workspace}
          entry={pocket.entry}
          path={pocket.path}
          bind:open={pocket.open}
        />
      {/if}
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="puts an old version back as a new change"
  body={async ({ set, container, expect, capture, delay, onAbort, withUserFocus }: any) => {
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    await workspace.write(pocket.path, "second\n").settled;
    await workspace.write(pocket.path, "third\n").settled;

    pocket.open = true;
    await delay({ frames: 4 });
    await until("the versions to arrive", () => rows(container).length >= 3);

    /** The oldest on show is the file as it was born. */
    const oldest = rows(container).at(-1)!;
    const restore = oldest.querySelector(
      "[data-region='restore']",
    ) as HTMLElement;
    await withUserFocus(async (user: any) => user.click(restore));

    /** The restore is an ordinary write, so this waits for it to land. */
    let said = "";
    await until("the file to say what it said before", () => said === "one\n", 15_000, async () => {
      const held = await workspace.read(pocket.path);
      said = held?.kind === "text" ? held.text : "";
    });
    pocket.said = said;
    expect(said).toBe("one\n");

    /**
     * A NEW change, not a rewind: everything that was there is still there,
     * and the restore is one more on top.
     */
    const after = await workspace.history(pocket.entry, { limit: 10 });
    expect(after.versions.length).toBe(4);
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[30rem] w-full">
      {#if pocket.workspace}
        <History
          workspace={pocket.workspace}
          entry={pocket.entry}
          path={pocket.path}
          bind:open={pocket.open}
        />
      {/if}
      <pre data-region="said">{pocket.said}</pre>
    </div>
  {/snippet}
</Sweater>
