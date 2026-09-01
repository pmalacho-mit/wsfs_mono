<script lang="ts" module>
  /**
   * The application shell: a tree, a dock of open files, a tutor beside them,
   * and the study instrument watching all of it.
   *
   * WHY THIS IS THE PACKAGE IT IS IN. It is the only one that may depend on
   * everything it composes -- Monaco through `wsfs_python_suede`, the chat
   * panel through `wsfs_assistant_suede`, the tree and the dock through
   * `wsfs_svelte_suede`, the filesystem through core. Every piece below is
   * imported; none of it is declared here, which is what makes this a
   * composition root rather than a fourth copy of the system.
   *
   * WHAT IT ADDS that none of them could: the nudge protocol. Noticing that a
   * student is stuck needs edits attributed to THIS person (Monaco's), runs
   * and their outcomes (the kernel's), what is on screen (the dock's) and a
   * model to judge progress with (the assistant's seam) -- which is exactly
   * why the dependency graph has this at the bottom.
   */
  export type { Execution, EntrySnapshot, Snapshot, Taking } from "../../wsfs_svelte_suede/frontend/open.svelte";
  export { OpenFile, SharedTextFile } from "../../wsfs_svelte_suede/frontend/open.svelte";

  import { WithEvents } from "../../with-events-suede";
  import type { Id, Submitting } from "../../wsfs_core_suede/frontend";
  import type { Outcome } from "../../wsfs_python_suede/frontend";
  import type { SharedTextFile } from "../../wsfs_svelte_suede/frontend";

  /** Every run this workspace recorded, for a host that wants to hear. */
  export class Model extends WithEvents<{
    executed: [
      entry: Id,
      snapshot: Submitting,
      output: unknown[],
      outcome: Outcome,
    ];
  }> {}
</script>

<script lang="ts">
  import {
    DockView,
    GridView,
    Orientation,
    type PanelProps,
    themes,
    type ViewAPI,
  } from "../../dockview-svelte-suede";
  import "../../dockview-svelte-suede/styles/dockview.css";
  import { LayoutPriority } from "dockview";
  import { onDestroy } from "svelte";
  import FileText from "@lucide/svelte/icons/file-text";
  import FolderTree from "@lucide/svelte/icons/folder-tree";

  import type {
    FileOverride,
    Workspace,
  } from "../../wsfs_core_suede/frontend";
  import { mint } from "../../wsfs_core_suede/frontend";
  import {
    FileTree,
    FileTreeModel,
    FileView,
    InView,
    OpenFile,
    PanelHeading,
    TextSizeSlider,
    TextSizes,
    appearance,
    cleaner,
    nameOf,
    type EntrySnapshot,
    type Pressed,
    type UserEdit,
    type Enter,
    type Snapshot,
    type SurfaceFor,
    type Taking,
  } from "../../wsfs_svelte_suede/frontend";
  import { Rooms } from "../../wsfs_svelte_suede/frontend";
  import {
    hostedIn,
    persisting,
  } from "../../wsfs_core_suede/frontend";
  import * as unsaved from "../../wsfs_core_suede/frontend/unsaved";
  import {
    AssistantPanel,
    Conversation,
    assistant as chattingWith,
    type Assistant as Chat,
  } from "../../wsfs_assistant_suede/frontend";
  import {
    Runner,
    kernels,
    monaco,
    provider,
    type EditorProps,
    type KernelPool,
  } from "../../wsfs_python_suede/frontend";
  import { Editor } from "../../python-monaco-suede";
  import { Nudge } from "./nudge";
  import {
    deadlinesIn,
    settingsFrom,
    settingsWith,
    Stuck,
    tickFor,
    type Configured,
    type Episode,
  } from "./stuck";
  import { Activity } from "./activity";
  import { headerFor } from "./headers";
  import ProblemHeader from "./ProblemHeader.svelte";
  import { tutoring, type Tutoring } from "./tutoring";

  let {
    model = new Model(),
    workspace,
    entering,
    surfaceFor,
    onEditor,
    onSnapshot,
    onStuck,
    protocol,
    courseEvent,
    oneFileAtATime = false,
    system = "",
    readonly = false,
    base,
    authorize,
  }: {
    /** Where runs are announced, for a host that wants to hear them. */
    model?: Model;
    workspace: Workspace;
    /**
     * How a room joins the shared document, for a caller that has to say.
     *
     * `Provider` is this codebase's own type, not Liveblocks', and two of its
     * members -- whether this client is holding changes, and waiting until it
     * is not -- are questions a real provider answers about a real
     * connection. A test that wants to say "given a room reaching nobody"
     * has to be able to answer them itself, and no amount of pretending to
     * be a Liveblocks room lets it.
     */
    entering: Enter;
    /**
     * Which surface a file is edited in.
     *
     * Defaulted to Monaco for everything, because this shell is a Python
     * workspace -- but it is a prop and not a constant, so a test can drive a
     * plain one and a host with a notebook cell can register that instead.
     */
    surfaceFor?: SurfaceFor;
    /**
     * Every Monaco editor as it mounts.
     *
     * Only meaningful for the DEFAULT surface, which is why it is a separate
     * prop rather than a member of `SurfaceFor`: a consumer registering its
     * own surface configures that surface's own way in.
     */
    onEditor?: EditorProps["onEditor"];
    /** Handed the snapshot taker once there is one, for anything outside
     *  this component that needs to describe what the user is looking at. */
    onSnapshot?: (take: (options?: Taking) => Snapshot) => void;
    /**
     * Every stuck episode, whatever became of it.
     *
     * Handed out rather than sent anywhere, because where it goes is a host's
     * decision and not this component's -- and because the ones that were
     * randomized into silence are the half a study cannot do without.
     */
    onStuck?: (episode: Episode) => void;
    /**
     * What this course was set up to run, if anybody said.
     *
     * Carried the same way `courseEvent` is, and for the same reason: the
     * numbers live in a course's configuration, which is a thing the host
     * knows about and this component does not. Absent -- or any field of it
     * left unset -- means `DEFAULTS`, so a workspace opened outside a study
     * behaves the way it always did.
     *
     * Beneath the URL, never over it: `?nudge.cooldown=5` still wins, which
     * is what makes a configured term watchable in a minute.
     */
    protocol?: Configured;
    /**
     * Which sitting of which course this is, as the host names it.
     *
     * Carried rather than derived, because this component knows about
     * workspaces and files and has never heard of a course. It goes on every
     * study record so that a term's data can be grouped by the thing a
     * researcher actually cares about.
     */
    courseEvent?: string;
    /**
     * One file open at a time: opening a second closes the first.
     *
     * OFF BY DEFAULT, because a workspace where two files sit side by side is
     * the ordinary one and this component is not only a study's instrument.
     *
     * ON, it makes "what the student was looking at" a question with one
     * answer. The stuck rules ask that question constantly -- the code
     * snapshot on every episode, and the before-and-after the progress rule
     * compares -- and each of them reads the FIRST visible file, which with
     * two panels open is a coin toss dressed up as a fact. A term run this
     * way has a snapshot per episode that is actually the program the student
     * was working on.
     */
    oneFileAtATime?: boolean;
    /**
     * Standing instructions for every question asked here.
     *
     * A course's, not this component's -- what is being taught, what not to
     * give away. Empty by default, which is a workspace outside a course.
     */
    system?: string;
    /** whether or not the workspace is written in readonly mode */
    readonly?: boolean;
    /**
     * Where this workspace's routes are, and how to authenticate to them.
     *
     * The chat and the study mount over core's prefix, so they are the same
     * base URL the transport was built with -- named again here because this
     * component is handed a `Workspace` rather than the transport behind it.
     */
    base?: string;
    authorize?: () => HeadersInit | Promise<HeadersInit>;
  } = $props();

  /**
   * The two satellites, composed beside the workspace rather than hung off it.
   *
   * Core's `Workspace` carries no `tutor` and no `study` group, deliberately:
   * a filesystem that knew a chat panel existed would be the boundary this
   * split is about. So the chat and the study build their own requests
   * against the same base URL and the same authorisation.
   */
  const at = { base: base ?? "/wsfs", authorize: authorize ?? (() => ({})) };
  const chat: Chat = chattingWith(workspace, at);
  const study: Tutoring = tutoring(workspace, at);

  /** Monaco for everything, unless a host says otherwise. See `surfaceFor`. */
  const monacoSurface = monaco(onEditor ? { onEditor } : {});
  const surfaces: SurfaceFor = surfaceFor ?? (() => monacoSurface);

  /**
   * What the terminal snippet needs, filled in once the dock is up.
   *
   * The snippet is in markup scope and the wiring is inside `onAPI`, which is
   * a closure -- so the few things that have to cross that line do it here,
   * named, rather than by the snippet reaching into a scope it cannot see.
   */
  let runtime = $state<{
    kernels: KernelPool;
    finished: (outcome: Outcome) => void;
    ran: (started: {
      entry: string | undefined;
      at: string;
      result: Promise<Outcome>;
    }) => void;
  }>();

  /** One terminal per open file, so a key press can find the right one. */
  const running: Record<string, { run: () => void } | undefined> = $state({});

  /**
   * The keys that run the file, for somebody whose hands are in the editor.
   *
   * SAVE RUNS IT. There is nothing to save -- what is typed is already in the
   * room and already what the kernel reads -- so ctrl/cmd+S is a key people
   * press out of habit that would otherwise offer to write the page to disk.
   * Shift+Enter is the other one those hands already know, from every
   * notebook they have used.
   */
  const runKeys = (entry: string) => (pressed: Pressed) => {
    const terminal = running[entry];
    if (terminal === undefined) return;
    const saving = (pressed.ctrl || pressed.meta) && pressed.key.toLowerCase() === "s";
    /** Plain shift: ctrl+shift+enter is the editor's own, and stays it. */
    const asked =
      pressed.shift && pressed.key === "Enter" && !pressed.ctrl && !pressed.meta;
    if (!saving && !asked) return;
    pressed.claim();
    /** Refused while a run is going -- see `run` in `Runner.svelte`. */
    terminal.run();
  };

  const chrome = $derived(themes[appearance.theme].className);

  /**
   * How big the text in each panel is, and it is remembered.
   *
   * Held here rather than inside the panels because the dock builds and
   * discards them -- a file view is made when a tab opens and gone when it
   * shuts -- and a size that went with the tab would be a size somebody set
   * for the last file. See `textsize.svelte.ts`.
   */
  const textSizes = new TextSizes();

  const conversation = new Conversation();

  /**
   * Watching for somebody who is stuck.
   *
   * Built here rather than inside `onAPI` so it exists for the whole life of
   * the panel -- a person can be idle before the dock has finished laying
   * itself out, and that minute counts.
   */
  let stuck = $state<Stuck | undefined>(undefined);
  const nudge = new Nudge();

  /**
   * The rich record of a post-episode window.
   *
   * Armed by every eligible episode, offered and silent alike, and quiet the
   * rest of the time -- which is nearly all of it. See `activity.ts` for why
   * this is allowed to lose a batch and the outbox is not.
   */
  const activity = new Activity({
    flush: ({ episode, moments }, closing) =>
      study.study.activity(
        {
          episode,
          moments: moments.map(({ at, ...rest }) => ({
            ...rest,
            at: new Date(at).toISOString(),
          })),
        },
        /** The last batch is often sent as the page is going away, and an
         *  ordinary fetch dies with the document. */
        { keepalive: closing },
      ),
  });

  /**
   * A plain click, keystroke or scroll anywhere in the workspace.
   *
   * THE CATCH-ALL BEHIND `acted`, which is below. The named doors -- an edit,
   * a run, a question -- cover the things worth naming; this covers the rest,
   * because "idle" in the protocol means nobody is there, and somebody
   * reading their own traceback, scrolling through their code or dragging a
   * panel is there.
   *
   * The idle clock is reset EVERY time and the log is written at most every
   * couple of seconds: the first is free and the second, unthrottled, would
   * be a line per keystroke on top of the edits already recorded.
   */
  const STIR = 2_000;
  let stirred = 0;
  const stir = (how: string) => {
    stuck?.acted();
    const at = Date.now();
    if (at - stirred < STIR) return;
    stirred = at;
    activity.note("interaction", { how });
  };

  let shell = $state<HTMLElement | undefined>(undefined);

  /**
   * Listened for imperatively, and on the shell rather than on the window.
   *
   * ON THE SHELL because the workspace is one region of somebody else's page,
   * and a click in their header is not this student working. IN CAPTURE
   * because a handler further in may stop the event -- an editor that
   * swallows keystrokes would otherwise make typing look like idleness. And
   * ADDED IN CODE rather than as attributes because a `<div>` carrying key
   * handlers is a thing every a11y linter is right to ask about, and the
   * answer here -- it is not a control, it is a room -- is not one an
   * attribute can give.
   */
  $effect(() => {
    const on = shell;
    if (on === undefined) return;
    const pointer = () => stir("pointer");
    const key = () => stir("key");
    const wheel = () => stir("wheel");
    on.addEventListener("pointerdown", pointer, true);
    on.addEventListener("keydown", key, true);
    on.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => {
      on.removeEventListener("pointerdown", pointer, true);
      on.removeEventListener("keydown", key, true);
      on.removeEventListener("wheel", wheel, true);
    };
  });

  /**
   * Anything the person did, wherever they did it.
   *
   * ONE DOOR, and everything that counts as working goes through it: typing
   * in a file, typing to the tutor, running something, opening a tab, or a
   * plain click anywhere in the workspace. The idle rule is about a PERSON --
   * "idle" in the protocol means nobody is there -- and a student reading
   * their own traceback or scrolling through their code is there.
   *
   * `stuck` rather than a captured instance because this is called from the
   * markup as well as from `onAPI`, and the watcher is built inside it.
   */
  const acted = (kind: string, what: Record<string, unknown> = {}) => {
    stuck?.acted();
    activity.note(kind, what);
  };

  /**
   * What the assistant is asked on the person's behalf when they take the
   * offer of help. It quotes the failure, because "help me" on its own says
   * less than the traceback already on screen does.
   */
  const stuckOn = ({ because }: Extract<Outcome, { ok: false }>) =>
    `My last run ended in an error:\n\n\`\`\`\n${because}\n\`\`\`\n\nCan you help me work out why?`;

  /**
   * What the person is asked on their behalf, given why they look stuck.
   *
   * Phrased as THEM asking, because that is what the panel will show and what
   * the tutor will answer -- and because a question that opens by telling
   * somebody a system decided they were stuck is a worse question.
   */
  const becauseOf = (episode: Episode) => {
    if (episode.rule === "the same error twice")
      return `I keep getting the same error -- ${episode.detail}. Can you help me work out why?`;
    if (episode.rule === "no progress")
      return "I think I am stuck on this. Can you point me at what to try next?";
    return "I am not sure what to do next here. Can you help me get started?";
  };

  const snippets = { explorer, dock, assistant };
  const tabs = { file: FileView };
  type Grid = ViewAPI<"grid", typeof snippets>;

  const cleanup = cleaner();

  const onAPI = async (api: Grid) => {
    cleanup();

    const tree = new FileTreeModel(workspace, { readonly });

    /**
     * One registry for the whole workspace, and therefore ONE subscription to
     * the stream feeding every room. A room that subscribed for itself would
     * have to be open before it could hear anything -- which is exactly the
     * case `rooms.opening` exists to cover, and would leave every file that
     * was ever closed and reopened quietly behind.
     */
    const rooms = new Rooms(
      workspace,
      entering,
      hostedIn(workspace),
      persisting,
    );

    const openInProgress = new Set<Id>();
    const openFiles = new Map<Id, OpenFile>();
    const inView = new InView();
    cleanup.add(inView, () => rooms.dispose());

    /**
     * Everything this workspace holds, as it stands right now.
     *
     * Taken rather than watched: whoever asks is about to send it somewhere,
     * and what matters is that it describes the moment they asked. `dirty`
     * is the one to read first -- an entry showing it has a version named
     * here that the user has already moved past, so store before sending.
     */
    const snapshot = ({ resolveDirty = false }: Taking = {}): Snapshot => {
      // One pass, before anything is read, so every entry below is described
      // as of the same moment.
      const stored = new Map<Id, string>();
      if (resolveDirty)
        for (const [entry, open] of openFiles) {
          const shared = open.sharedText;
          if (!shared?.dirty) continue;
          /**
           * The transaction is known SYNCHRONOUSLY or not at all. A snapshot
           * describes the moment it was asked for, so waiting on the write
           * would describe a later one.
           *
           * A room that is holding its writes still names one: the draft the
           * text went into. That is the whole point of drafts -- the server
           * can rebuild it, so a snapshot naming it is as portable as one
           * naming a version. Only text that went nowhere at all leaves an
           * entry dirty here.
           */
          const transaction = shared.storing();
          if (transaction !== undefined) stored.set(entry, transaction);
        }

      const index = workspace.index();
      // Copied up front: reading the set is what makes a live view of this
      // re-render, and reading it per entry would not happen at all in a
      // workspace that is still empty.
      const showing = new Set(inView.showing);
      const entries: EntrySnapshot[] = [];
      for (const entry of workspace.entries().values()) {
        const path = index.of(entry.id);
        if (path === undefined || entry.type === "folder") continue;
        const open = openFiles.get(entry.id);
        entries.push({
          entry: entry.id,
          path,
          name: entry.name,
          versions: {
            name: entry.name_version,
            parent: entry.parent_version,
            deleted: entry.deleted_version,
            content: entry.content_version ?? null,
          },
          open: open !== undefined,
          visible: showing.has(entry.id),
          dirty: open?.sharedText?.dirty === true,
          stage: open?.sharedText?.rooms?.get(entry.id)?.opening ?? "no room",
          watching: open?.sharedText?.watching === true,
          speaks: open?.sharedText?.rooms?.get(entry.id)?.speaks === true,
          executions: open?.sharedText?.executions.length ?? 0,
          ...(stored.has(entry.id) ? { stored: stored.get(entry.id) } : {}),
        });
      }
      return {
        taken: new Date(),
        entries,
        visible: entries.filter((held) => held.visible),
      };
    };

    type TabsAPI = ViewAPI<"dock", typeof tabs>;
    let _tabsAPI: TabsAPI | undefined = undefined;

    const dock = await api.addSnippetPanel(
      "dock",
      { onready: (api) => (_tabsAPI = api) },
      {
        priority: LayoutPriority.High,
      },
    );

    const [explorer, assistant] = await Promise.all([
      api.addSnippetPanel(
        "explorer",
        { model: tree },
        {
          size: 260,
          minimumWidth: 170,
          maximumWidth: 520,
          position: { direction: "left", referencePanel: dock.reference },
        },
      ),
      api.addSnippetPanel(
        "assistant",
        {
          snapshot,
          conversation,
          /**
           * Lazy on purpose: the panel exists before the function that
           * answers it does, and a person cannot click faster than the rest
           * of this setup runs.
           */
          ask: (text: string) => void askTheTutor(text),
          /**
           * The chat box counts as working too. Idleness is about a PERSON,
           * not about a pane, so somebody composing a long question to the
           * tutor is not idle -- and used to be told so after three minutes.
           *
           * The LENGTH goes in the record and the text does not: what a
           * student is drafting to a tutor is theirs until they send it, and
           * how much of it there is at each moment is what a study of when
           * they reached for help actually needs.
           */
          typed: (length: number) => acted("prompt typing", { length }),
        },
        {
          size: 340,
          minimumWidth: 200,
          maximumWidth: 640,
          position: { direction: "right", referencePanel: dock.reference },
        },
      ),
    ]);

    if (_tabsAPI === undefined)
      throw new Error("Tabs API did not initialize in time");

    const tabsAPI: TabsAPI = _tabsAPI!;

    /**
     * The terminal for each open file, and the key press that runs it.
     *
     * `FileView` hands a key on rather than acting on it -- "ctrl+S runs the
     * file" is a sentence about Python, and that package has never heard of
     * Python. So the answer is here, keyed by the panel it belongs to.
     */
    const runnable = (path: string) => path.endsWith(".py");

    const tab = (idOrEntry: FileTreeModel.Entry | FileTreeModel.Entry["id"]) =>
      tabsAPI.getPanel(
        typeof idOrEntry === "string" ? idOrEntry : idOrEntry.id,
      );

    /**
     * Close every file but this one. See `oneFileAtATime`.
     *
     * Nothing is disposed here: `onDidRemovePanel` is what keeps what was
     * typed and lets the room go, and it runs for a panel closed from here
     * exactly as it does for one closed by its own tab.
     */
    const onlyKeep = (id: Id) => {
      for (const panel of [...tabsAPI.panels])
        if (panel.id !== id) panel.api.close();
    };

    const override: FileOverride = {
      get: (path) => {
        const id = tree.mapping.of(path);
        if (id) return openFiles.get(id)?.sharedText?.source;
      },
      put: (path, value) => {
        const id = tree.mapping.of(path);
        if (!id) return false;
        const sharedText = openFiles.get(id)?.sharedText;
        /**
         * The editor writing back what it is already showing.
         *
         * It does this as it opens a file, and storing it is never right. At
         * best it is a version identical to the one before it. At worst --
         * and this is the one that cost somebody a line -- a write of this
         * person's own is still in flight, so what the panel opened on is the
         * text from BEFORE it, and putting that back is that write undone by
         * the act of looking at the file.
         *
         * Taken and dropped rather than passed on, because there is nothing
         * in it: it is a copy of what this panel is holding. A write that
         * says something new -- a script's, an assistant's -- is not this,
         * and goes on down.
         */
        if (sharedText !== undefined && value === sharedText.source)
          return true;
        /**
         * A room that has not said what it holds is not a room this write can
         * go into: editing a document that has not received its own content
         * merges the two rather than replacing one with the other, which is
         * how a file ends up saying everything twice. Refused, so the write
         * goes to the workspace the ordinary way and the room picks it up as
         * an ordinary gap when it does sync.
         *
         * This is the `ready` check that used to be commented out here. It
         * was right; what was missing was something that could answer it,
         * and `Room.ready` -- synced AND reconciled -- is that.
         */
        if (sharedText?.shared?.ready !== true) return false;

        // Only if it actually said something new. The editor writes what it
        // is showing back through here as it opens a file, and storing that
        // would be a version identical to the one before it -- which is waste
        // at best, and at worst a second write racing the first with the same
        // token to present.
        if (sharedText.forceReplace(value)) void sharedText.store();
        return true;
      },
      /**
       * Bytes replacing a file somebody has open as text.
       *
       * The remote case reaches the same conclusion by a different route: a
       * write from another client arrives over the stream and the room finds
       * out by READING the file, because nothing in a token says whether it
       * names text or bytes. This is that conclusion reached one step
       * earlier, by a caller already holding the bytes.
       */
      replaced: async (path, bytes, mime) => {
        const id = tree.mapping.of(path);
        if (!id) return false;
        const room = openFiles.get(id)?.sharedText?.shared;
        if (room === undefined) return false;

        /**
         * TAKEN, and that is the only reason to be here at all.
         *
         * Nothing is merged -- there is nothing to merge bytes into -- so the
         * write itself would be identical down the ordinary path. What taking
         * it buys is the TOKEN: the room has to be told which version ended
         * it, and the only way to know that before the round trip is to be
         * the one who sent it.
         *
         * Awaited because the kernel's caller is: a script that writes a file
         * and reads it back expects to have been told.
         */
        const { transaction, settled } = workspace.write(path, bytes, mime);
        const answer = await settled;
        if (!answer.rejected) room.tookAway(transaction, mime);
        return true;
      },
    };

    /**
     * The editor's own view of the workspace, and the kernel's.
     *
     * Both go through `override`, which is what makes "what Python reads is
     * what the editor shows" true rather than merely intended -- see
     * `FileOverride` in core.
     */
    Editor.provideFiles(provider(workspace, override), { searchRoot: "" });

    /**
     * The transcript is the SERVER's, so the panel reads it back rather than
     * starting empty every time somebody opens the workspace. Entries are
     * named here because only this side knows where a file lives.
     */
    /**
     * Asked FRESH each time rather than closing over one index.
     *
     * `index` here used to name the local inside the snapshot builder, which
     * is a different scope -- so this threw `index is not defined` the moment
     * it was called, which is when a turn with a file attached to it is drawn.
     * The throw was caught by the read around it, so the whole transcript came
     * back as nothing and the panel opened empty on every reload.
     *
     * Fresh is also the right answer: a file can be renamed or moved between
     * a question being asked and it being read back, and what a person wants
     * to see is where the file is NOW.
     */
    conversation.attach(chat, (entry) => workspace.index().of(entry) ?? entry);

    /**
     * The stuck watcher, and the one tick that drives its time-based rules.
     *
     * A single interval rather than a timer per rule: the rules are questions
     * about elapsed time, so asking them together on a coarse tick is both
     * simpler and cheaper than three timers being reset by every keystroke.
     * The tick is short relative to the shortest rule so that "three minutes"
     * means three minutes and not three-and-a-tick.
     */
    const settings = settingsFrom(
      typeof window === "undefined" ? "" : window.location.search,
      settingsWith(protocol),
    );

    /**
     * The cooldown and window this workspace was left in, if it was left in
     * one. Keyed by the workspace itself, which is the only id in scope that
     * means "this student, on this thing" -- see `deadlinesIn`.
     */
    const deadlines = deadlinesIn(workspace.id);

    /**
     * EVERY DETECTION, IN THE CONSOLE, whatever became of it.
     *
     * The protocol's difficulty is that most of what it does is INVISIBLE. A
     * detection randomized into silence, one that arrived during a cooldown
     * and one that never happened at all look identical from the outside --
     * like nothing. Somebody watching a student over their shoulder, or
     * checking that `?nudge.idle=10` did what they asked, needs the ones that
     * never reach a screen and, for each, which rule held it back.
     *
     * `console.info` rather than `console.error`: none of this is wrong, and
     * a student's console should not say it is.
     */
    const clock = (at: number) =>
      at === 0 ? "never" : new Date(at).toLocaleTimeString();

    const becameBecause = (episode: Episode) => {
      if (episode.became === "offered") return "PROMPTING";
      if (episode.became === "silent")
        return `no prompt -- the coin said silent (offer rate ${settings.offerRate})`;
      if (episode.became === "held back by the cooldown")
        return `no prompt -- a cooldown is running until ${clock(held.cooldownUntil)}`;
      return `no prompt -- a post-episode window is open until ${clock(held.windowUntil)}`;
    };

    const announce = (episode: Episode) =>
      console.info(
        `[stuck] ${episode.rule} (${episode.detail}) -- ${becameBecause(episode)}`,
        {
          episode: episode.id,
          at: clock(episode.at),
          became: episode.became,
          path: episode.code?.path,
          window: episode.window
            ? `${clock(episode.window.from)} to ${clock(episode.window.until)}`
            : "none",
          cooldown: episode.cooldown
            ? `${clock(episode.cooldown.from)} to ${clock(episode.cooldown.until)}`
            : "none",
        },
      );

    console.log("Stuck settngs", settings);

    const held = new Stuck({
      settings,
      resume: deadlines.read(),
      remember: deadlines.write,
      offer: (episode, forMs) =>
        nudge.offer(
          () => {
            /**
             * TAKING THE OFFER IS A FACT ABOUT THE STUDENT, and it is recorded
             * before the question goes anywhere: what is being measured is
             * whether they accepted, not whether the tutor answered.
             */
            console.info(`[stuck] offer accepted`, { episode: episode.id });
            void offerTaken(episode);
            acted("offer accepted", { episode: episode.id });
            void askTheTutor(becauseOf(episode));
          },
          forMs,
          settings.floor,
        ),
      record: (episode) => {
        announce(episode);
        onStuck?.(episode);
        /**
         * The window opens for BOTH arms, which is the whole comparison --
         * and only for episodes that opened one, so a detection held back by
         * a cooldown cannot start a second recording inside the first.
         */
        if (episode.window) activity.open(episode.id, episode.window.until);
        activity.note("stuck", {
          episode: episode.id,
          rule: episode.rule,
          became: episode.became,
        });
        void recordEpisode(episode);
      },
      looking: () => {
        const open = snapshot().visible.at(0);
        if (open === undefined) return undefined;
        const showing = openFiles.get(open.entry)?.sharedText;
        return showing === undefined
          ? undefined
          : { entry: open.entry, path: open.path, text: showing.source };
      },
      goalFor: (path) => headerFor(path),
      judging: (asking) => study.progressing(asking),
    });
    stuck = held;
    /**
     * ONE INTERVAL, sized from the settings rather than fixed.
     *
     * A five-second tick is fine for a three-minute rule and useless for a
     * four-second one, which is what somebody testing with `?nudge.idle=4`
     * asks for: they set a threshold the tick cannot resolve and conclude the
     * setting does nothing. See `tickFor`.
     */
    const ticking = setInterval(
      () => (held.check(), activity.check()),
      tickFor(settings),
    );
    cleanup.add(
      () => (held.stop(), activity.dispose(), clearInterval(ticking)),
    );
    onSnapshot?.(snapshot);

    /**
     * The study's records, posted and forgotten.
     *
     * `catch` on every one of them, and it is the point rather than an
     * oversight: an unhandled rejection here would be a study's bookkeeping
     * showing up as an error in a student's console. See `study.py`.
     */
    const when = (at: number) => new Date(at).toISOString();

    const recordEpisode = (episode: Episode) =>
      study.study
        .detected({
          episode: episode.id,
          at: when(episode.at),
          rule: episode.rule,
          became: episode.became,
          /**
           * TRIMMED TO WHAT THE CONTRACT ACCEPTS. A refused body is a lost
           * episode, and a student with a very long path or a very large file
           * is exactly the student a study should not quietly drop.
           */
          detail: episode.detail.slice(0, 2_000),
          course_event: courseEvent?.slice(0, 200) ?? null,
          entry: episode.code?.entry ?? null,
          path: episode.code?.path.slice(0, 1_000) ?? null,
          code: episode.code?.text.slice(0, 400_000) ?? null,
          cooldown: episode.cooldown
            ? {
                began: when(episode.cooldown.from),
                ends: when(episode.cooldown.until),
              }
            : null,
          window: episode.window
            ? {
                began: when(episode.window.from),
                ends: when(episode.window.until),
              }
            : null,
        })
        .catch(() => undefined);

    const offerTaken = (episode: Episode) =>
      study.study
        .accepted({
          offer: mint(),
          episode: episode.id,
          at: new Date().toISOString(),
          course_event: courseEvent?.slice(0, 200) ?? null,
          entry: episode.code?.entry ?? null,
        })
        .catch(() => undefined);

    const kernelPool: KernelPool = kernels(workspace, override);

    /**
     * A run is one of the things `Stuck` watches, and the only one that can
     * fire the repeated-error rule.
     *
     * NOT AN OFFER IN ITSELF any more. A failing run used to prompt every
     * time, which is both more often than the protocol allows and a worse
     * signal than the protocol asks for: one error is somebody working, and
     * the SAME error twice is somebody stuck. Whether anything is said is
     * decided in one place now -- see `stuck.ts`.
     */
    const finished = (outcome: Outcome) => {
      if (outcome.ok) nudge.withdraw();
      activity.note("ran", {
        ok: outcome.ok,
        ...(outcome.ok ? {} : { because: outcome.because.slice(0, 2_000) }),
      });
      /** `ran` counts as acting, so this is the idle clock too. */
      stuck?.ran(
        outcome.ok ? { ok: true } : { ok: false, because: outcome.because },
      );
    };

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
    const onCodeExecution = async ({
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
       * STARTING a run is acting, and it is not the same event as finishing
       * one. A program that takes a minute used to leave the person who
       * started it looking idle for that minute.
       */
      acted("run", { entry });
      const taken = workspace.snapshot(
        snapshot().entries.map((held) => held.entry),
      );
      const outcome = await result;
      const open = openFiles.get(entry)?.sharedText;
      const outputs = open?.executions.at(-1)?.outputs ?? [];
      model.fire("executed", entry, taken, outputs, outcome);
      /**
       * Awaited so a snapshot that was refused -- naming a version the server
       * never issued -- does not leave an execution pointing at nothing.
       */
      const kept = await taken.settled;
      if (kept.rejected) return;
      const recorded = workspace.executed(
        entry,
        taken.transaction,
        outputs,
        outcome.ok,
      );
      /**
       * Stamped onto the run it belongs to, by the marker the runner keyed it
       * with. Without this the panel knows a file has been run three times and
       * cannot name any of them, which is exactly what attaching one needs.
       */
      const held = openFiles.get(entry)?.sharedText;
      if (held !== undefined)
        held.executions = held.executions.map((one) =>
          one.at === at ? { ...one, transaction: recorded.transaction } : one,
        );
    };

    runtime = { kernels: kernelPool, finished, ran: onCodeExecution };

    /**
     * Put a question to the tutor, with what the person is looking at.
     *
     * A SNAPSHOT FIRST, and awaited. The tutor is shown the files as they
     * stood when the question was asked, and a snapshot is what says which
     * versions those were -- so it has to have landed before the question
     * names it. `resolveDirty` is what makes that possible for a file being
     * typed into: it stores what is on screen and names the transaction,
     * rather than naming a version that does not exist yet.
     *
     * A REFUSED SNAPSHOT IS NOT A REFUSED QUESTION. It names a version this
     * server never issued, which happens when work has not arrived; the
     * question still goes, with nothing attached, and the tutor answers from
     * what was asked. A person waiting on an answer should not be given an
     * error about bookkeeping.
     */
    const askTheTutor = async (text: string) => {
      /**
       * SENDING is acting, and it is not covered by typing.
       *
       * A question can be pasted and clicked, or taken from a suggestion, and
       * a student who has just asked for help is the least idle person in the
       * room. This used to be reachable only through the chat box's `oninput`.
       */
      acted("asked", { length: text.length });
      const held = snapshot({ resolveDirty: true });
      const taken = workspace.snapshot(held.entries.map((one) => one.entry));
      const attached = held.visible.map((one) => ({
        entry: one.entry,
        path: one.path,
        executions: (openFiles.get(one.entry)?.sharedText?.executions ?? [])
          .map((run) => run.transaction)
          .filter((named): named is string => named !== undefined),
      }));

      let named: string | undefined;
      try {
        const kept = await taken.settled;
        if (!kept.rejected) named = taken.transaction;
      } catch {
        /** Unsent. The question goes without it -- see above. */
      }
      const problemDescription = attached
        .map(({ path }) => {
          const header = headerFor(path);
          if (header)
            return `The user is currently working on the following problem: ${header}`;
        })
        .join("\n\n");
      await conversation.ask(
        text,
        named === undefined ? [] : attached,
        problemDescription ? system + "\n\n" + problemDescription : system,
        named,
      );
    };

    /**
     * Typing is the clearest evidence somebody is not stuck: it withdraws an
     * offer that is already up, and it is what the idle rule counts.
     *
     * WHOSE typing is the whole question, and it is answered by whichever
     * surface reported it -- see `edits.ts` in `wsfs_svelte_suede` for the
     * two signals and which of them is the sufficient one.
     */
    const edited = (edit: UserEdit) => {
      nudge.withdraw();
      acted("edit", {
        did: edit.did,
        via: edit.via,
        offset: edit.at,
        removed: edit.removed,
        inserted: edit.inserted.slice(0, 1_000),
        shared: edit.shared,
        version: edit.version,
      });
    };

    /**
     * The page going away is a close that nobody clicked.
     *
     * A panel being shut is where unsaved typing is put away, and nothing
     * shuts the panels when the whole page goes -- but "I typed the last bit
     * and then closed the browser" is an ordinary way to stop working, and it
     * has to keep the last bit.
     *
     * `pagehide` rather than `beforeunload`, for the reason the debouncer
     * gives: registering `beforeunload` disqualifies the page from the
     * back/forward cache in several browsers, and this needs no prompt.
     *
     * RESCUE RATHER THAN THE ORDINARY KEEP, which is the whole of the fix
     * here: the ordinary one queues, and queueing is a round trip to
     * IndexedDB that a dying document never returns from. See
     * `rescueWhatWasTyped`.
     */
    const keepWhatNobodySaved = () => {
      openFiles.forEach((open) => open.sharedText?.rescueWhatWasTyped());
      /** And whatever the window has recorded and not yet sent. `close`
       *  flushes with `keepalive`, which is the only kind of request that
       *  outlives the document it was made from. */
      activity.close();
    };

    /**
     * HIDDEN IS THE LAST MOMENT ANYTHING IS PROMISED.
     *
     * `pagehide` is not guaranteed: a tab discarded under memory pressure, a
     * phone where the browser is swapped out, a window closed by the system
     * -- several of those get `visibilitychange` and nothing else, and it is
     * the only event the spec suggests treating as the end of a session.
     *
     * The ORDINARY keep here, not the rescue: the page is still alive and may
     * well come back, so this wants the outbox and its retries rather than a
     * single unacknowledged shot. Being cheap when nothing is dirty is what
     * makes it safe to run on every tab switch -- both of these start by
     * asking, and a file whose text has already left is not asked twice.
     */
    const keepBeforeHidden = () => {
      if (document.visibilityState !== "hidden") return;
      openFiles.forEach((open) => open.sharedText?.keepWhatWasTyped());
    };

    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", keepWhatNobodySaved);
      document.addEventListener("visibilitychange", keepBeforeHidden);
      cleanup.add(() => {
        window.removeEventListener("pagehide", keepWhatNobodySaved);
        document.removeEventListener("visibilitychange", keepBeforeHidden);
      });
    }

    /**
     * Which files the person can actually see, as a list of paths.
     *
     * Read off the same snapshot everything else reads, so "visible" means
     * here what it means everywhere else -- dockview shows one panel per
     * GROUP, so two groups side by side are two visible files.
     */
    const onScreen = () => snapshot().visible.map((one) => one.path);

    cleanup.add(
      () => (
        openFiles.forEach((open) => open.sharedText?.dispose()),
        /* Whatever is left claiming the prompt is claiming it for files that
           no longer exist. */
        unsaved.forgetAll()
      ),
      tabsAPI.onDidActivePanelChange(({ panel }) => {
        tree.select(panel?.id);
        acted("panel active", { entry: panel?.id, visible: onScreen() });
      }),
      tabsAPI.onDidAddPanel((panel) => {
        inView.watch(panel);
        acted("panel opened", { entry: panel.id, visible: onScreen() });
      }),
      tabsAPI.onDidRemovePanel((panel) => {
        tree.deselect(panel.id);
        inView.forget(panel.id);
        acted("panel closed", { entry: panel.id, visible: onScreen() });
        // Closing is the last chance to keep what was typed, and letting the
        // file go is what makes reopening it start clean rather than resume.
        openFiles.get(panel.id)?.sharedText?.dispose();
        openFiles.delete(panel.id);
      }),
      tree.subscribe({
        open: async (entry) => {
          const panel = tab(entry);
          if (panel) return panel.api.setActive();
          const { id, path } = entry;
          if (openInProgress.has(id)) return;
          openInProgress.add(id);
          try {
            const title = nameOf(path);
            const opened = new OpenFile(
              entry,
              rooms,
              surfaces(entry),
              workspace,
              readonly,
              edited,
            );
            openFiles.set(id, opened);
            await tabsAPI.addComponentPanel(
              "file",
              {
                opened,
                workspace,
                textSize: textSizes.documents,
                beneath: terminal,
                hasCompanion: runnable,
                onKeys: runKeys(id),
                above: problemFor,
              },
              { id, title },
            );
            /**
             * AFTER the new panel is up, not before.
             *
             * Closing first would leave the dock empty for as long as opening
             * takes, and -- worse -- would race two fast clicks: the file
             * being closed for is not added yet, so the one already on its
             * way in survives and there are two after all. Closing whatever
             * is not the panel just added is the same instruction written so
             * that arriving in either order gives the same answer.
             */
            if (oneFileAtATime) onlyKeep(id);
          } finally {
            // However it went. Left set, a file that has been opened once can
            // never be opened again -- and closing its panel is exactly when
            // somebody tries.
            openInProgress.delete(id);
          }
        },
        renamed: ({ id, path }) => {
          openFiles.get(id)?.move(path);
          const panel = tab(id);
          if (panel === undefined) return;
          panel.api.updateParameters({ workspace, path });
          panel.api.setTitle(nameOf(path));
        },
        removed: ({ id }) => {
          tab(id)?.api.close();
          openFiles.get(id)?.sharedText?.dispose();
          openFiles.delete(id);
        },
      }),
    );
  };

  onDestroy(() => {
    cleanup();
    conversation.dispose();
    /** `close` and not `withdraw`: the panel is going, so there is no floor
     *  left to honour and nothing to honour it on. */
    nudge.close();
  });
</script>

{#snippet explorer({
  params: { model },
}: PanelProps<"grid", { model: FileTreeModel }>)}
  <section
    class="bg-sidebar grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r"
    data-region="explorer"
    data-text-scale
    style:--wsfs-text-scale={textSizes.explorer.scale}
  >
    <PanelHeading label="Explorer" icon={FolderTree}>
      {#snippet controls()}
        <TextSizeSlider size={textSizes.explorer} label="Explorer text size" />
      {/snippet}
    </PanelHeading>
    <FileTree {model} />
  </section>
{/snippet}

{#snippet dock({
  params: { onready },
}: PanelProps<
  "grid",
  { onready: (api: ViewAPI<"dock", typeof tabs>) => void }
>)}
  <div class="h-full min-h-0 w-full min-w-0" data-region="documents">
    <DockView
      theme={appearance.theme}
      components={tabs}
      watermark={{ snippet: nothingOpen }}
      onReady={({ api }) => onready(api)}
    />
  </div>
{/snippet}

{#snippet problemFor(path: string)}
  <!--
    The problem this file is an answer to, for the files somebody wrote one
    down for. Looked up by path each time rather than read once, so a file
    that is renamed stops -- or starts -- carrying a header with the name.
  -->
  {@const problem = headerFor(path)}
  {#if problem !== undefined}
    <ProblemHeader content={problem} />
  {/if}
{/snippet}

{#snippet terminal(shared: SharedTextFile)}
  <!--
    THE RUNNER IS PASSED IN rather than reached for, because a terminal under
    a program is a Python idea and `FileView` has never heard of Python. What
    it knows is that something goes beneath the editor when the panel says so.
  -->
  {#if runtime}
    <Runner
      kernelPool={runtime.kernels}
      {shared}
      onFinished={runtime.finished}
      onRun={runtime.ran}
      bind:this={running[shared.id]}
    />
  {/if}
{/snippet}

{#snippet nothingOpen()}
  <div
    class="bg-background text-muted-foreground grid h-full w-full place-items-center gap-2 text-sm"
    data-region="nothing-open"
  >
    <div class="flex flex-col items-center gap-2">
      <FileText class="size-6" />
      Open a file from the explorer.
    </div>
  </div>
{/snippet}

{#snippet assistant({
  params: { snapshot, conversation, ask, typed },
}: PanelProps<
  "grid",
  {
    snapshot: () => Snapshot;
    conversation: Conversation;
    ask: (text: string) => void;
    typed: (length: number) => void;
  }
>)}
  <div class="h-full min-h-0 border-l" data-region="assistant">
    <AssistantPanel
      {conversation}
      textSize={textSizes.assistant}
      onAsk={ask}
      oninput={(event: Event) =>
        typed(
          (event.currentTarget as HTMLTextAreaElement | null)?.value.length ??
            0,
        )}
      attached={snapshot().visible.map(({ path, executions, entry }) => ({
        entry,
        path,
        executions,
      }))}
    />
  </div>
{/snippet}

<div
  class="bg-background h-full min-h-0 w-full {chrome}"
  data-region="shell"
  bind:this={shell}
>
  <GridView
    {snippets}
    orientation={Orientation.HORIZONTAL}
    proportionalLayout={false}
    onReady={({ api }) => onAPI(api)}
  />
</div>
