<script lang="ts">
  /**
   * The history a person actually opens, against a real backend.
   *
   * Reading one before restoring it, and the panel that holds them.
   *
   * SPLIT FROM `History.test.svelte`, and not for tidiness: sweater-vest runs
   * one component's tests in one page, and six of these -- each opening a
   * workspace, a client and a stream against a real backend -- is more than
   * one page finishes. Every one passed alone and in any five; six together
   * never reported at all.
   *
   * NAMED `Versions` rather than `HistoryPreview` for a reason worth knowing:
   * `--component` matches by prefix, so a file called `HistoryPreview` is
   * also selected by `--component History` -- which quietly put all six back
   * in one run and made the split look as though it had not worked.
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

<Sweater config category="Versions" orientation="vertical" mode="serial" />

<Sweater
  name="shows what a version held before anyone restores it"
  body={async ({ set, container, expect, capture, delay, onAbort, withUserFocus }: any) => {
    /**
     * Restoring is a change to the file, and choosing one from a timestamp
     * and a character count is guessing. Reading is how a person finds out
     * whether this is the version they meant.
     */
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    await workspace.write(pocket.path, "the second thing\n").settled;

    pocket.open = true;
    await delay({ frames: 4 });
    await until("the versions to arrive", () => rows(container).length >= 2);

    /** The oldest, which is the file as it was born. */
    const oldest = rows(container).at(-1)!;
    await withUserFocus(async (user: any) =>
      user.click(oldest.querySelector("[data-region='preview-toggle']")),
    );
    await until("the version to be read", () =>
      (preview(container)?.textContent ?? "").includes("one"),
    );
    expect(preview(container)!.textContent).toContain("one");
    await capture("png").uri;

    /** Clicking it again closes it: the list is the thing being used. */
    await withUserFocus(async (user: any) =>
      user.click(oldest.querySelector("[data-region='preview-toggle']")),
    );
    await delay({ frames: 2 });
    expect(preview(container)).toBeNull();
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
  name="shows a version only this browser has"
  body={async ({ set, container, expect, capture, delay, onAbort, withUserFocus }: any) => {
    /**
     * The server has never heard of this one, so asking the wire for it would
     * get a 404 -- the right answer to the wrong question. This client is the
     * only place that write exists, and it is the one being asked.
     */
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    pocket.wire!.reachable(false);
    const stranded = workspace.write(pocket.path, "typed with no server\n");
    void stranded.settled.catch(() => undefined);
    await delay({ milliseconds: 300 });

    pocket.open = true;
    await delay({ frames: 4 });
    await until("the queued write to be listed", () => rows(container).length >= 1);

    const queued = rows(container)[0]!;
    expect(queued.getAttribute("data-standing")).toBe("queued");
    await withUserFocus(async (user: any) =>
      user.click(queued.querySelector("[data-region='preview-toggle']")),
    );
    await until("the queued version to be read", () =>
      (preview(container)?.textContent ?? "").includes("no server"),
    );
    expect(preview(container)!.textContent).toContain("typed with no server");

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
  name="scrolls when there is more history than fits"
  body={async ({ set, container, expect, capture, delay, onAbort, withUserFocus }: any) => {
    /**
     * Measured rather than looked at. A dialog is a grid by default, and a
     * grid with no rows declared gives the list an `auto` track -- so it
     * sizes to its whole content, overflows the dialog, and is clipped by it.
     * That looks exactly like a panel that will not scroll, and no assertion
     * about which rows are present can see it.
     */
    onAbort(resetMode);
    setMode("light");
    const pocket: Pocket = set(new Pocket());
    onAbort(() => ((pocket.open = false), pocket.dispose()));
    const workspace = await pocket.start();

    /**
     * Enough to need a second page and to be taller than the dialog, and no
     * more: every one of these is a round trip, and a soak of the paging
     * control is not what this is for.
     */
    for (let at = 0; at < 14; at += 1)
      await workspace.write(pocket.path, `version ${at}\n`).settled;

    pocket.open = true;
    await delay({ frames: 4 });
    await until("a full page of versions", () => rows(container).length >= 10);

    /**
     * Everything, which is also the only test of the paging control: one page
     * at a time until the list says there are no more.
     */
    const more = () =>
      [...container.ownerDocument.querySelectorAll("[data-region='history']")]
        .at(-1)
        ?.querySelector("[data-region='load-more']") as HTMLElement | null;
    for (let page = 0; page < 6 && more() !== null; page += 1) {
      const before = rows(container).length;
      await withUserFocus(async (user: any) => user.click(more()!));
      await until(
        "the next page",
        () => rows(container).length > before || more() === null,
      );
    }
    expect(rows(container).length).toBeGreaterThan(10);
    await delay({ frames: 2 });

    const list = [
      ...container.ownerDocument.querySelectorAll("[data-region='history']"),
    ].at(-1) as HTMLElement;

    /** More content than room for it, which is the precondition. */
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight + 8);

    /** And the list is what holds it, rather than spilling out of the dialog. */
    const dialog = list.closest("[data-slot='dialog-content']") as HTMLElement;
    expect(list.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      dialog.getBoundingClientRect().bottom + 1,
    );

    /** Scrolling it moves it, which is the whole complaint when it does not. */
    list.scrollTop = list.scrollHeight;
    await delay({ frames: 2 });
    expect(list.scrollTop).toBeGreaterThan(0);
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
