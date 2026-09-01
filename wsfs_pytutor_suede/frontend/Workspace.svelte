<script lang="ts" module>
  /**
   * The application: a wsfs workspace, with Python in it and a tutor beside
   * it.
   *
   * WHAT THIS PACKAGE ADDS to the shell it renders is the nudge protocol --
   * noticing that a student is stuck, deciding whether to say anything, and
   * recording what happened either way. Everything else is composed:
   *
   *   the shell, the tree, the dock       `wsfs_svelte_suede`
   *   Monaco, the kernel, the terminal    `wsfs_python_suede`
   *   the chat panel and its transcript   `wsfs_assistant_suede`
   *   the filesystem underneath all of it `wsfs_core_suede`
   *
   * It is the only package that may depend on all four, which is why the
   * composition lives here.
   */
  import { WithEvents } from "../../with-events-suede";
  import type { Id, Submitting } from "../../wsfs_core_suede/frontend";
  import type { Outcome as RunOutcome } from "../../wsfs_python_suede/frontend";

  /** Every run this workspace recorded, for a host that wants to hear. */
  export class Model extends WithEvents<{
    executed: [
      entry: Id,
      snapshot: Submitting,
      outputs: unknown[],
      outcome: RunOutcome,
    ];
  }> {}
</script>

<script lang="ts">
  import { onDestroy } from "svelte";

  import type { Authorized, Workspace as Filesystem } from "../../wsfs_core_suede/frontend";
  import {
    Workspace as Shell,
    WorkspaceEvents,
    type Enter,
    type OpenText,
    type Shell as LaidOut,
    type Snapshot,
    type Taking,
  } from "../../wsfs_svelte_suede/frontend";
  import {
    AssistantPanel,
    Conversation,
    assistant as chattingWith,
    type Assistant as Chat,
  } from "../../wsfs_assistant_suede/frontend";
  import {
    kernels,
    type EditorProps,
    type KernelPool,
    type Outcome,
  } from "../../wsfs_python_suede/frontend";
  import PythonFile from "./PythonFile.svelte";
  import { headerFor } from "./headers";
  import type { Configured, Episode } from "./stuck";
  import { tutoring, type Tutoring } from "./tutoring";
  import { Watching } from "./watching.svelte";

  let {
    model = new Model(),
    workspace,
    entering,
    onSnapshot,
    onStuck,
    protocol,
    courseEvent,
    oneFileAtATime = false,
    system = "",
    readonly = false,
    base,
    authorize,
    editor = {},
  }: {
    /** Where runs are announced, for a host that wants to hear them. */
    model?: Model;
    workspace: Filesystem;
    /** How a room joins the shared document. See the shell. */
    entering: Enter;
    /** Handed the snapshot taker, for anything outside this component that
     *  needs to describe what the user is looking at. */
    onSnapshot?: (take: (options?: Taking) => Snapshot) => void;
    /**
     * Every stuck episode, whatever became of it.
     *
     * Handed out rather than sent anywhere, because the ones that were
     * randomized into silence are the half a study cannot do without.
     */
    onStuck?: (episode: Episode) => void;
    /**
     * What this course was set up to run, if anybody said.
     *
     * Beneath the URL, never over it: `?nudge.cooldown=5` still wins, which is
     * what makes a configured term watchable in a minute.
     */
    protocol?: Configured;
    /** Which sitting of which course this is, as the host names it. */
    courseEvent?: string;
    /** One file open at a time: opening a second closes the first. */
    oneFileAtATime?: boolean;
    /**
     * Standing instructions for every question asked here.
     *
     * A course's, not this component's -- what is being taught, what not to
     * give away. Empty by default, which is a workspace outside a course.
     */
    system?: string;
    readonly?: boolean;
    /**
     * Where this workspace's chat and study routes are, and how to reach them.
     *
     * REQUIRED, both of them. The chat and the study mount over core's prefix
     * and build their own requests, so they need the same base URL and the
     * same authorisation the transport was built with -- and a default that
     * sent no credentials would be a silent 4xx that types cannot catch and a
     * person experiences as "the tutor stopped before finishing".
     */
    base: string;
    authorize: Authorized;
    /** What every Monaco editor in this workspace is configured with. */
    editor?: EditorProps;
  } = $props();

  /**
   * The two satellites, composed beside the workspace rather than hung off it.
   *
   * Core's `Workspace` carries no `tutor` and no `study` group, deliberately:
   * a filesystem that knew a chat panel existed would be the boundary the
   * split is about.
   */
  const routes = { base, authorize };
  const chat: Chat = chattingWith(workspace, routes);
  const study: Tutoring = tutoring(workspace, routes);
  const conversation = new Conversation();
  const events = new WorkspaceEvents();

  let shell = $state<LaidOut>();
  let pool = $state<KernelPool>();

  /**
   * What the person is looking at, as the rules ask for it.
   *
   * The FIRST visible file, which with two panels open is a coin toss dressed
   * up as a fact -- see `oneFileAtATime`.
   */
  const whatTheyAreLookingAt = () => {
    const open = shell?.snapshot().visible.at(0);
    const text = open && shell?.opened(open.entry)?.text;
    return text ? { entry: open.entry, path: open.path, text: text.showing } : undefined;
  };

  const watching = new Watching({
    workspace: workspace.id,
    study,
    protocol,
    courseEvent,
    looking: () => whatTheyAreLookingAt(),
    goalFor: (path) => headerFor(path),
    ask: (question) => void askTheTutor(question),
    onEpisode: (episode) => onStuck?.(episode),
  });

  onDestroy(() => (watching.stop(), conversation.dispose()));

  events.subscribe({
    opened: (_file, onScreen) => watching.acted("panel opened", { onScreen }),
    closed: (entry, onScreen) => watching.acted("panel closed", { entry, onScreen }),
    focused: (entry, onScreen) => watching.acted("panel active", { entry, onScreen }),
    edited: (_file, edit) => {
      watching.typed();
      watching.acted("edit", {
        did: edit.did,
        via: edit.via,
        offset: edit.at,
        removed: edit.removed,
        inserted: edit.inserted.slice(0, 1_000),
        shared: edit.shared,
        version: edit.version,
      });
    },
  });


  const laidOut = (laid: LaidOut) => {
    shell = laid;
    pool = kernels(workspace, laid.override);
    onSnapshot?.(laid.snapshot);
    /**
     * Asked FRESH each time rather than closing over one index: a file can be
     * renamed between a question being asked and it being read back, and what
     * a person wants to see is where the file is NOW.
     */
    conversation.attach(chat, (entry) => workspace.index().of(entry) ?? entry);
    void putTheTutorOnTheRight(laid);
  };

  const putTheTutorOnTheRight = (laid: LaidOut) =>
    laid.grid.addComponentPanel(
      "panel",
      { render: assistant },
      {
        size: 340,
        minimumWidth: 200,
        maximumWidth: 640,
        position: { direction: "right", referencePanel: laid.beside.documents },
      },
    );

  const filesInView = (taken: Snapshot | undefined) =>
    (taken?.visible ?? []).map((file) => ({
      entry: file.entry,
      path: file.path,
      executions: runsRecordedFor(file.entry),
    }));

  /**
   * What a QUESTION carries: the files on screen, stored first so that the
   * versions named are the ones the person was looking at.
   *
   * Storing is a write, so this belongs to the moment somebody asks and
   * nowhere else -- see `filesOnScreen` for the half that only draws.
   */
  const attachable = () => {
    const taken = shell?.snapshot({ resolveDirty: true });
    return { entries: taken?.entries ?? [], visible: filesInView(taken) };
  };

  /**
   * What the PANEL draws, taken without storing anything.
   *
   * The distinction is not tidiness. This is read from a template
   * expression, and a plain snapshot only reads; the resolving one stores
   * every dirty file, which sets `dirty` on each. Svelte forbids a state
   * change inside a template expression, so asking for the resolving
   * snapshot here threw `state_unsafe_mutation`, the assignment was refused,
   * and the file stayed dirty for as long as it was open -- with the write
   * itself already sent, so nothing was lost and nothing looked wrong until
   * a test asked whether the file had settled.
   */
  const filesOnScreen = () =>
    filesInView(shell?.snapshot()).map(({ entry, path, executions }) => ({
      entry,
      path,
      executions: executions.length,
    }));

  /**
   * Runs the server has heard of. A tutor cannot be shown output it has never
   * seen, so a run still on its way is skipped rather than named.
   */
  const runsRecordedFor = (entry: string) =>
    (shell?.opened(entry)?.text?.runs ?? [])
      .map((run) => run.transaction)
      .filter((named): named is string => named !== undefined);

  /**
   * Put a question to the tutor, with what the person is looking at.
   *
   * A SNAPSHOT FIRST, and awaited: the tutor is shown the files as they stood
   * when the question was asked, and a snapshot is what says which versions
   * those were. `resolveDirty` is what makes that possible for a file being
   * typed into.
   *
   * A REFUSED SNAPSHOT IS NOT A REFUSED QUESTION. It names a version this
   * server never issued, which happens when work has not arrived; the question
   * still goes, with nothing attached, and a person waiting on an answer
   * should not be given an error about bookkeeping.
   */
  const askTheTutor = async (text: string) => {
    watching.acted("asked", { length: text.length });
    const { entries, visible } = attachable();
    const taken = workspace.snapshot(entries.map((file) => file.entry));
    const named = await landedOrNot(taken);
    await conversation.ask(
      text,
      named === undefined ? [] : visible,
      instructionsFor(visible.map(({ path }) => path)),
      named,
    );
  };

  const landedOrNot = async (taken: Submitting) => {
    try {
      const answer = await taken.response;
      return answer.rejected ? undefined : taken.transaction;
    } catch {
      return undefined;
    }
  };

  const instructionsFor = (paths: string[]) => {
    const problems = paths
      .map(headerFor)
      .filter((problem): problem is string => problem !== undefined)
      .map((problem) => `The user is currently working on the following problem: ${problem}`)
      .join("\n\n");
    return problems ? `${system}\n\n${problems}` : system;
  };

  /**
   * A run is one of the things `Watching` watches, and the only one that can
   * fire the repeated-error rule. NOT AN OFFER IN ITSELF: one error is
   * somebody working, and the SAME error twice is somebody stuck.
   */
  const finished = (outcome: Outcome) => watching.ran(outcome);

  /**
   * A run, recorded: a snapshot of what the person could see, and then the
   * output against it. Both are transactions, so both go through the outbox
   * and survive being offline -- which is the only reason either is worth
   * recording at all.
   *
   * The snapshot is taken as the run STARTS, because that is the state the
   * output is evidence about; taking it afterwards would name whatever the
   * file had become by then.
   */
  const recordTheRun = async ({
    entry,
    at,
    result,
  }: {
    entry: string | undefined;
    at: string;
    result: Promise<Outcome>;
  }) => {
    if (entry === undefined) return;
    /**
     * STARTING a run is acting, and it is not the same event as finishing one.
     * A program that takes a minute used to leave the person who started it
     * looking idle for that minute.
     */
    watching.acted("run", { entry });
    const taken = workspace.snapshot(
      (shell?.snapshot().entries ?? []).map((file) => file.entry),
    );
    const outcome = await result;
    const text = shell?.opened(entry)?.text;
    const outputs = text?.runs.at(-1)?.outputs ?? [];
    model.fire("executed", entry, taken, outputs, outcome);

    /** Awaited so a snapshot that was refused does not leave a run pointing at
     *  nothing. */
    const written = await taken.response;
    if (written.rejected || text === undefined) return;
    const recorded = workspace.executed(entry, taken.transaction, outputs, outcome.ok);
    nameTheRun(text, at, recorded.transaction);
  };

  /**
   * Stamped onto the run it belongs to, by the marker the runner keyed it
   * with. Without this the panel knows a file has been run three times and
   * cannot name any of them, which is exactly what attaching one needs.
   */
  const nameTheRun = (text: OpenText, at: string, transaction: string) => {
    text.runs = text.runs.map((run) =>
      run.at === at ? { ...run, transaction } : run,
    );
  };

  /** Monaco for every text file, with a terminal under the ones that run. */
  const editorFor = () => pythonFile;
</script>

{#snippet pythonFile(file: OpenText, size: number)}
  {#if pool}
    <PythonFile
      {file}
      {size}
      kernels={pool}
      {editor}
      onFinished={finished}
      onRun={recordTheRun}
    />
  {/if}
{/snippet}

{#snippet assistant()}
  <div class="h-full min-h-0 border-l" data-region="assistant">
    <AssistantPanel
      {conversation}
      onAsk={(text: string) => void askTheTutor(text)}
      oninput={(event: Event) =>
        watching.acted("prompt typing", {
          length: (event.currentTarget as HTMLTextAreaElement | null)?.value.length ?? 0,
        })}
      attached={filesOnScreen()}
    />
  </div>
{/snippet}

<Shell
  {workspace}
  {entering}
  {events}
  {editorFor}
  {oneFileAtATime}
  {readonly}
  onReady={laidOut}
  protectedName={(path) => headerFor(path) !== undefined}
/>
