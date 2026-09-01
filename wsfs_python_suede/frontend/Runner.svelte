<script lang="ts" module>
  import type { Output } from "../../python-web-kernel-suede";

  /**
   * How a run ended, as anything downstream of it needs to know.
   *
   * `because` is there so that whoever reacts to a failure can say what
   * failed without going back to the outputs to work it out again.
   */
  export type Outcome = { ok: true } | { ok: false; because: string };

  /**
   * The outputs of one run, as THIS package knows them.
   *
   * Opaque everywhere above -- core stores whatever a kernel produced without
   * reading it, so a kernel learning a new kind of output changes nothing --
   * and this is the one place that knows which kernel produced them.
   */
  export const produced = (outputs: unknown[]) => outputs as Output.Specific[];

  const raised = (outputs: Output.Specific[]) =>
    outputs.find((output) => output.output_type === "error") as
      | Output.Error
      | undefined;

  const outcomeOf = (
    outputs: Output.Specific[],
    failure: string | undefined,
  ): Outcome => {
    if (failure !== undefined) return { ok: false, because: failure };
    const error = raised(outputs);
    if (error === undefined) return { ok: true };
    return { ok: false, because: `${error.ename}: ${error.evalue}` };
  };
</script>

<script lang="ts">
  /**
   * The terminal that belongs to one file.
   *
   * The kernel reads the workspace through the same filesystem the editor
   * writes to, so running a file runs what is on screen -- including imports
   * of siblings nobody has saved by hand.
   */
  import Square from "@lucide/svelte/icons/square";
  import Play from "@lucide/svelte/icons/play";
  import Eraser from "@lucide/svelte/icons/eraser";
  import { snippets } from "../../python-web-kernel-suede";
  import { Button } from "../../wsfs_svelte_suede/frontend/shadcn/ui/button";
  import { Separator } from "../../wsfs_svelte_suede/frontend/shadcn/ui/separator";
  import type { OpenText } from "../../wsfs_svelte_suede/frontend";
  import type { KernelPool } from "./kernel";

  let {
    kernelPool,
    file,
    onFinished,
    onRun,
  }: {
    kernelPool: KernelPool;
    file: Pick<OpenText, "id" | "path" | "showing" | "runs">;
    /** Every run, as it ends. A refused run is not a run and is not reported. */
    onFinished?: (outcome: Outcome) => void;
    /**
     * Every run, as it STARTS, with the promise it will finish by.
     *
     * Handed the promise rather than the answer so a caller can wait on the
     * run without owning it -- recording it, say -- while the panel goes on
     * drawing output as it arrives.
     */
    onRun?: (started: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => void;
  } = $props();

  let running = $state<{ interrupt: () => void } | undefined>(undefined);

  /**
   * The run in progress, appended to as output arrives.
   *
   * Kept apart from `file.runs` until it ends, so a run that is still
   * going does not look like a finished one to anything counting them.
   */
  let live = $state<Output.Specific[]>([]);
  let failure = $state<string | undefined>(undefined);

  /**
   * Run what is on screen.
   *
   * EXPORTED, so that whoever mounted this can start a run without a click --
   * `FileView` binds the keyboard to it. A run that is already going is
   * refused rather than queued: the button says "Stop" while one is, and a
   * second kernel job over the same file is not what anybody meant by
   * pressing the key twice.
   */
  export const run = async () => {
    if (running) return;
    failure = undefined;
    live = [];
    const at = new Date().toISOString();

    let finished: (outcome: Outcome) => void = () => {};
    const result = new Promise<Outcome>((done) => (finished = done));
    onRun?.({ entry: file.id, at, result });

    kernelPool.use(async (kernel) => {
      const job = kernel.run({
        code: file.showing,
        path: file.path,
        on: { output: (output) => (live = [...live, output]) },
      });
      running = job;
      try {
        await job.result;
      } catch (reason) {
        failure = reason instanceof Error ? reason.message : String(reason);
      } finally {
        running = undefined;
        const outcome = outcomeOf(live, failure);
        /**
         * Oldest first, which is the order a log is read in: the newest is at
         * the bottom, where the eye already is.
         */
        file.runs = [
          ...file.runs,
          { at, outputs: live, ok: outcome.ok, failure },
        ];
        live = [];
        failure = undefined;
        finished(outcome);
        onFinished?.(outcome);
      }
    });
  };

  /**
   * Following the newest output, unless the person has scrolled away from it.
   *
   * A log that pulls you back to the bottom while you are reading something
   * further up is worse than one that does not follow at all.
   */
  let view = $state<HTMLElement | undefined>(undefined);
  let following = $state(true);

  const watching = () => {
    const scroller = view;
    if (scroller === undefined) return;
    following =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 24;
  };

  $effect(() => {
    /** Read so this runs again as output arrives. */
    void file.runs.length;
    void live.length;
    if (following && view !== undefined) view.scrollTop = view.scrollHeight;
  });

  const cleared = () => {
    file.runs = [];
    live = [];
    failure = undefined;
  };

  const anything = $derived(file.runs.length > 0 || live.length > 0);
</script>

<section
  class="bg-sidebar grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-t"
  data-region="runner"
>
  <!-- `min-h-9` rather than `h-9`: the labels on these grow with the
       panel's text size, and a row that cannot is a row that clips them. -->
  <header class="flex min-h-9 shrink-0 items-center gap-1 px-2">
    {#if running}
      <Button
        size="xs"
        variant="destructive"
        onclick={() => running?.interrupt()}
      >
        <Square />
        Stop
      </Button>
    {:else}
      <Button size="xs" onclick={run} data-region="run">
        <Play />
        Run
      </Button>
    {/if}
    <Button
      size="xs"
      variant="ghost"
      onclick={cleared}
      disabled={!anything}
      data-region="clear"
    >
      <Eraser />
      Clear
    </Button>
    <Separator orientation="vertical" class="mx-1 h-4" />
    <span class="text-muted-foreground truncate font-mono text-(length:--text-2xs-mono)">
      {file.path}
    </span>
  </header>
  <output
    bind:this={view}
    onscroll={watching}
    class="block overflow-auto px-3 pb-3 font-mono text-(length:--text-xs-mono) leading-relaxed whitespace-pre-wrap"
    data-region="outputs"
  >
    {#each file.runs as execution, at (execution.at + at)}
      <!-- Delineated, because three runs' output in a row reads as one
           confusing run. The header is what says where each one began. -->
      <div
        class="text-muted-foreground mt-3 flex items-center gap-2 border-t pt-1 text-(length:--text-2xs) first:mt-0 first:border-t-0"
        data-region="execution"
        data-ok={execution.ok}
      >
        <span>Run {at + 1}</span>
        <span>{execution.at.slice(11, 19)}</span>
        {#if !execution.ok}
          <span class="text-destructive">ended with an error</span>
        {/if}
      </div>
      {#each produced(execution.outputs) as output}
        {@render snippets.output.any(output)}
      {/each}
      <!-- Only when the outputs did not already say it: a kernel that raised
           reports it as an output AND rejects the job. -->
      {#if execution.failure && raised(produced(execution.outputs)) === undefined}
        <span class="text-destructive block">{execution.failure}</span>
      {/if}
    {/each}

    {#if running || live.length > 0}
      <div
        class="text-muted-foreground mt-3 flex items-center gap-2 border-t pt-1 text-(length:--text-2xs) first:mt-0 first:border-t-0"
        data-region="execution"
        data-ok="running"
      >
        <span>Run {file.runs.length + 1}</span>
        <span>running…</span>
      </div>
      {#each live as produced}
        {@render snippets.output.any(produced)}
      {/each}
    {/if}

    {#if !anything && !running}
      <span class="text-muted-foreground italic">Run to see output.</span>
    {/if}
  </output>
</section>
