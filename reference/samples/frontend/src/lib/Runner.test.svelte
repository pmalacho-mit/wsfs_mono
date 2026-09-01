<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Runner, {
    type Outcome,
  } from "../../../../release/frontend/svelte/Runner.svelte";
  import { WarmPool } from "../../../../release/frontend/svelte/pool";
  import { Kernel } from "wsfs_suede.python-web-kernel-suede";
  import fs from "wsfs_suede.python-web-kernel-suede/fs";
  import { nameOf } from "../../../../release/frontend/svelte/paths";
  import type { Execution } from "../../../../release/frontend/svelte/Workspace.svelte";

  /** Unclosed on purpose: the point is a run that ends badly. */
  const BROKEN = `print("hello world"`;

  const ROOT = "/home/pyodide";

  class Pocket {
    source = $state(BROKEN);
    /** Where runs accumulate: on the file, not in the panel showing them. */
    executions = $state<Execution[]>([]);
    id = "example";
    started = $state<{
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }>();
    outcome = $state<Outcome>();
    file = { path: "example.py" };

    /** One file, so the run fails on the code rather than on an empty disk. */
    readonly held = new Map([[`${ROOT}/example.py`, BROKEN]]);

    readonly pool = new WarmPool<Kernel>({
      create: () =>
        new Kernel({
          fs: fs.readWrite({
            root: ROOT,
            get: (path) => this.held.get(path),
            listDirectory: (path) =>
              path === ROOT ? [...this.held.keys()].map(nameOf) : [],
            put: (path, value) =>
              typeof value === "string"
                ? void this.held.set(path, value)
                : void this.held.delete(path),
          }),
          input: async (prompt) => window.prompt(prompt) ?? "",
        }),
    });
  }
</script>

<Sweater config category="Runner" />

<Sweater
  name="reports a run that ended badly to whoever is listening"
  body={async ({
    set,
    container,
    expect,
    capture,
    delay,
    definition,
    withUserFocus,
  }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    await capture("png").uri;

    const run = container.querySelector("[data-region='run']") as HTMLElement;
    await withUserFocus(async (user) => user.click(run));

    const { outcome } = await definition("outcome");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.because).toContain(
      "SyntaxError: '(' was never closed",
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-full w-full">
      <Runner
        shared={pocket}
        kernelPool={pocket.pool}
        onFinished={(outcome) => (pocket.outcome = outcome)}
      />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="keeps every run, delineated, with the newest at the bottom"
  body={async ({ set, container, expect, capture, delay, withUserFocus }: any) => {
    /**
     * A log, not a display of the last thing that happened. Somebody
     * comparing two runs needs both on screen, and the one they just asked
     * for at the end -- which is where their eye already is.
     */
    const pocket: Pocket = set(new Pocket());
    pocket.source = 'print("first")\n';
    await delay({ frames: 2 });

    const runs = async (times: number) => {
      for (let at = 0; at < times; at += 1) {
        const before = pocket.executions.length;
        const button = container.querySelector(
          "[data-region='run']",
        ) as HTMLElement;
        await withUserFocus(async (user: any) => user.click(button));
        const deadline = Date.now() + 120_000;
        while (pocket.executions.length === before) {
          if (Date.now() > deadline) throw new Error("a run never finished");
          await delay({ milliseconds: 100 });
        }
      }
    };

    await runs(1);
    pocket.source = 'print("second")\n';
    await runs(1);
    await delay({ frames: 2 });

    /** Two runs, each with its own header rather than one wall of output. */
    const headers = [
      ...container.querySelectorAll("[data-region='execution']"),
    ];
    expect(headers).toHaveLength(2);
    expect(headers[0]!.textContent).toContain("Run 1");
    expect(headers[1]!.textContent).toContain("Run 2");

    /** Oldest first, so the newest is at the bottom where a log ends. */
    const shown = container.querySelector(
      "[data-region='outputs']",
    ) as HTMLElement;
    expect(shown.textContent!.indexOf("first")).toBeLessThan(
      shown.textContent!.indexOf("second"),
    );
    expect(pocket.executions).toHaveLength(2);
    await capture("png").uri;

    /** And Clear empties what the FILE holds, which is what anything else
        counting them is looking at. */
    const clear = container.querySelector(
      "[data-region='clear']",
    ) as HTMLElement;
    await withUserFocus(async (user: any) => user.click(clear));
    await delay({ frames: 2 });
    expect(pocket.executions).toHaveLength(0);
    expect(
      container.querySelectorAll("[data-region='execution']"),
    ).toHaveLength(0);
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[24rem] w-full">
      <Runner shared={pocket} kernelPool={pocket.pool} />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="hands a run's promise to whoever asked, as it starts"
  body={async ({ set, container, expect, delay, withUserFocus }: any) => {
    /**
     * The promise rather than the answer, so a caller can wait on the run
     * without owning it -- which is what recording it against a snapshot
     * needs, while the panel goes on drawing output as it arrives.
     */
    const pocket: Pocket = set(new Pocket());
    pocket.source = 'print("hello")\n';
    await delay({ frames: 2 });

    const button = container.querySelector("[data-region='run']") as HTMLElement;
    await withUserFocus(async (user: any) => user.click(button));

    const deadline = Date.now() + 120_000;
    while (pocket.started === undefined) {
      if (Date.now() > deadline) throw new Error("nobody was told it started");
      await delay({ milliseconds: 50 });
    }
    expect(pocket.started!.entry).toBe("example");
    const outcome = await pocket.started!.result;
    expect(outcome.ok).toBe(true);
    /** Told as it STARTED: the file already holds it by the time it resolves. */
    expect(pocket.executions).toHaveLength(1);
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[24rem] w-full">
      <Runner
        shared={pocket}
        kernelPool={pocket.pool}
        onRun={(started) => (pocket.started = started)}
      />
    </div>
  {/snippet}
</Sweater>
