<script lang="ts" module>
  /**
   * The shell: a file explorer on the left, and open files in dock tabs
   * beside it.
   *
   * WHAT IT DOES NOT KNOW is what a file is edited in. `editorFor` answers
   * that per path, and a path it has no answer for gets this package's plain
   * textarea. Nothing here has heard of Monaco, of Python, or of a tutor.
   *
   * WHAT A CONSUMER GETS BACK is `Shell` -- the grid itself, so a panel of its
   * own can go beside these; a snapshot of what the person is looking at; and
   * the door every write to a file goes through.
   */
  import type { ViewAPI } from "../../dockview-svelte-suede";
  import { WithEvents } from "../../with-events-suede";
  import type { FileOverride, Id } from "../../wsfs_core_suede/frontend";
  import Documents from "./Documents.svelte";
  import Explorer from "./Explorer.svelte";
  import Panel from "./Panel.svelte";
  import type { UserEdit } from "./edits";
  import type { OpenEntry, OpenText, Snapshot, Taking } from "./open.svelte";

  const panels = { explorer: Explorer, documents: Documents, panel: Panel };

  /** The grid the shell lays itself out on. */
  export type Grid = ViewAPI<"grid", typeof panels>;

  export type { Dock } from "./Documents.svelte";

  /** What this shell announces, for whoever is watching somebody work. */
  export type Announced = {
    opened: [file: OpenEntry, onScreen: string[]];
    closed: [entry: Id, onScreen: string[]];
    /** Which tab is in front, and everything on screen beside it. */
    focused: [entry: Id | undefined, onScreen: string[]];
    /** The person at this keyboard typed into a file. */
    edited: [file: OpenText, edit: UserEdit];
  };

  export class WorkspaceEvents extends WithEvents<Announced> {}

  /** What the shell hands back once it has laid itself out. */
  export type Shell = {
    /**
     * The grid, for a consumer adding a panel beside the ones the shell drew.
     *
     * `addComponentPanel("panel", { render }, { position })` takes a snippet,
     * so what goes in it is the consumer's and this package never sees it.
     */
    grid: Grid;
    /** What a new panel's position is given against. */
    beside: { explorer: string; documents: string };
    /** Everything this workspace holds, as it stands right now. */
    snapshot: (options?: Taking) => Snapshot;
    /**
     * The door every write to a file goes through.
     *
     * Built here because only the shell knows which files are open and what
     * they are showing, which is exactly what makes an open buffer win.
     */
    override: FileOverride;
    /** Open a file in a tab, as clicking it in the tree would. */
    open: (entry: Id) => Promise<void>;
    /** One open file, if it is open. */
    opened: (entry: Id) => OpenEntry | undefined;
    /** Which files the person can actually see, as paths. */
    onScreen: () => string[];
  };
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { LayoutPriority } from "dockview";

  import { GridView, Orientation, themes } from "../../dockview-svelte-suede";
  import "../../dockview-svelte-suede/styles/dockview.css";
  import type {
    Metadata,
    Path,
    Workspace as Filesystem,
  } from "../../wsfs_core_suede/frontend";
  import { hostedIn, persisting } from "../../wsfs_core_suede/frontend";
  import * as unsaved from "../../wsfs_core_suede/frontend/unsaved";
  import type { Dock } from "./Documents.svelte";
  import { Model as FileTreeModel } from "./FileTree.svelte";
  import { appearance } from "./appearance.svelte";
  import type { EditorFor } from "./editor";
  import { InView } from "./inview.svelte";
  import { OpenEntry as OpenedEntry, type EntrySnapshot } from "./open.svelte";
  import { Rooms, type Enter } from "./room.svelte";
  import { TextSizes } from "./textsize.svelte";
  import { cleaner } from "./utils";
  import { nameOf } from "./paths";

  let {
    workspace,
    entering,
    events = new WorkspaceEvents(),
    editorFor = () => undefined,
    onReady,
    protectedName,
    oneFileAtATime = false,
    readonly = false,
  }: {
    workspace: Filesystem;
    /**
     * How a room joins the shared document.
     *
     * `Provider` is this codebase's own type, not a vendor's, and two of its
     * members -- whether this client is holding changes, and waiting until it
     * is not -- are questions a real provider answers about a real connection.
     * A test that wants to say "given a room reaching nobody" has to be able
     * to answer them itself.
     */
    entering: Enter;
    /** Where what the person does is announced. */
    events?: WorkspaceEvents;
    /** What draws a text file. See `editor.ts`. */
    editorFor?: EditorFor;
    /** Handed the shell once it has laid itself out. */
    onReady?: (shell: Shell) => void;
    /** Files whose NAME is not the person's to change. See `FileTree`. */
    protectedName?: (path: Path) => boolean;
    /**
     * One file open at a time: opening a second closes the first.
     *
     * OFF BY DEFAULT, because a workspace where two files sit side by side is
     * the ordinary one. ON, it makes "what was the person looking at" a
     * question with one answer, which is what anything reading the first
     * visible file needs.
     */
    oneFileAtATime?: boolean;
    readonly?: boolean;
  } = $props();

  const chrome = $derived(themes[appearance.theme].className);

  /**
   * Held here rather than inside the panels, because the dock builds and
   * discards those -- a file view is made when a tab opens and gone when it
   * shuts -- and a size that went with the tab would be a size somebody set
   * for the last file.
   */
  const textSizes = new TextSizes();

  const cleanup = cleaner();
  const openFiles = new Map<Id, OpenedEntry>();
  const openInProgress = new Set<Id>();
  const inView = new InView();

  let tree = $state<FileTreeModel>();
  let dock = $state<Dock>();
  let rooms = $state<Rooms>();

  onDestroy(() => cleanup());

  const layOut = async (grid: Grid) => {
    cleanup();
    const files = startTheTree();
    const documents = await addTheDock(grid, files);
    const explorer = await addTheExplorer(grid, files, documents.reference);
    keepWhatWasTypedWhenThePageGoes();
    onReady?.(shellOver(grid, explorer.reference, documents.reference));
  };

  const startTheTree = () => {
    const joinRooms = oneRegistryForEveryRoom();
    const files = new FileTreeModel(workspace, { readonly });
    rooms = joinRooms;
    tree = files;
    cleanup.add(inView, () => joinRooms.dispose(), forgetEveryOpenFile);
    return files;
  };

  const addTheDock = (grid: Grid, files: FileTreeModel) =>
    grid.addComponentPanel(
      "documents",
      {
        theme: appearance.theme,
        onready: (api) => tabsAreReady(api, files, rooms!),
      },
      { priority: LayoutPriority.High },
    );

  const addTheExplorer = (grid: Grid, files: FileTreeModel, beside: string) =>
    grid.addComponentPanel(
      "explorer",
      { model: files, textSize: textSizes.explorer, protectedName },
      {
        size: 260,
        minimumWidth: 170,
        maximumWidth: 520,
        position: { direction: "left", referencePanel: beside },
      },
    );

  const shellOver = (grid: Grid, explorer: string, documents: string): Shell => ({
    grid,
    beside: { explorer, documents },
    snapshot,
    override,
    open: openInATab,
    opened: (entry) => openFiles.get(entry),
    onScreen,
  });

  /**
   * ONE registry for the whole workspace, and therefore ONE subscription to
   * the stream feeding every room. A room that subscribed for itself would
   * have to be open before it could hear anything, which would leave every
   * file that was ever closed and reopened quietly behind.
   */
  const oneRegistryForEveryRoom = () =>
    new Rooms(workspace, entering, hostedIn(workspace), persisting);

  const tabsAreReady = (api: Dock, files: FileTreeModel, rooms: Rooms) => {
    dock = api;
    cleanup.add(
      api.onDidActivePanelChange(({ panel }) => {
        files.select(panel?.id);
        events.fire("focused", panel?.id, onScreen());
      }),
      api.onDidAddPanel((panel) => {
        inView.watch(panel);
        const file = openFiles.get(panel.id);
        if (file) events.fire("opened", file, onScreen());
      }),
      api.onDidRemovePanel((panel) => {
        files.deselect(panel.id);
        inView.forget(panel.id);
        events.fire("closed", panel.id, onScreen());
        letTheFileGo(panel.id);
      }),
      files.subscribe({
        open: ({ id, path }) => void openTab(id, path, api, rooms),
        renamed: ({ id, path }) => renameTab(id, path),
        removed: ({ id }) => (tabFor(id)?.api.close(), letTheFileGo(id)),
      }),
    );
  };

  const tabFor = (entry: Id) => dock?.getPanel(entry);

  const openInATab = async (entry: Id) => {
    const path = workspace.index().of(entry);
    if (path === undefined) throw new Error(`no such entry: ${entry}`);
    if (dock === undefined || rooms === undefined)
      throw new Error("the shell has not laid itself out yet");
    await openTab(entry, path, dock, rooms);
  };

  const openTab = async (entry: Id, path: string, api: Dock, joinRooms: Rooms) => {
    const already = tabFor(entry);
    if (already) return void already.api.setActive();
    if (openInProgress.has(entry)) return;
    openInProgress.add(entry);
    try {
      await addTab(entry, path, api, joinRooms);
    } finally {
      /**
       * However it went. Left set, a file that has been opened once could
       * never be opened again -- and closing its panel is exactly when
       * somebody tries.
       */
      openInProgress.delete(entry);
    }
  };

  const addTab = async (
    entry: Id,
    path: string,
    api: Dock,
    joinRooms: Rooms,
  ) => {
    const opened = new OpenedEntry(
      { id: entry, path },
      joinRooms,
      workspace,
      readonly,
    );
    opened.onText((text) =>
      cleanup.add(text.edits((edit) => events.fire("edited", text, edit))),
    );
    openFiles.set(entry, opened);
    await api.addComponentPanel(
      "file",
      { opened, workspace, editorFor, textSize: textSizes.documents },
      { id: entry, title: nameOf(path) },
    );
    /**
     * AFTER the new panel is up, not before. Closing first would leave the
     * dock empty for as long as opening takes and -- worse -- would race two
     * fast clicks: the file being closed for is not added yet, so the one
     * already on its way in survives and there are two after all.
     */
    if (oneFileAtATime) closeEveryTabBut(entry);
  };

  const closeEveryTabBut = (entry: Id) => {
    for (const panel of [...(dock?.panels ?? [])])
      if (panel.id !== entry) panel.api.close();
  };

  const renameTab = (entry: Id, path: string) => {
    openFiles.get(entry)?.moved(path);
    const panel = tabFor(entry);
    if (panel === undefined) return;
    panel.api.updateParameters({ workspace, path });
    panel.api.setTitle(nameOf(path));
  };

  /**
   * Closing is the last chance to keep what was typed, and letting the file go
   * is what makes reopening it start clean rather than resume.
   */
  const letTheFileGo = (entry: Id) => {
    openFiles.get(entry)?.text?.dispose();
    openFiles.delete(entry);
  };

  const forgetEveryOpenFile = () => {
    for (const file of openFiles.values()) file.text?.dispose();
    openFiles.clear();
    /** Whatever is left claiming the unload prompt is claiming it for files
     *  that no longer exist. */
    unsaved.forgetAll();
  };

  /**
   * Which files the person can actually see, as paths.
   *
   * Read off the same snapshot everything else reads, so "visible" means here
   * what it means everywhere else -- a dock shows one panel per GROUP, so two
   * groups side by side are two visible files.
   */
  const onScreen = () => snapshot().visible.map((entry) => entry.path);

  /**
   * Everything this workspace holds, as it stands right now.
   *
   * Taken rather than watched: whoever asks is about to send it somewhere, and
   * what matters is that it describes the moment they asked.
   */
  const snapshot = ({ resolveDirty = false }: Taking = {}): Snapshot => {
    const stored = resolveDirty ? storeEveryDirtyFile() : new Map<Id, string>();
    const index = workspace.index();
    /**
     * Copied up front: reading the set is what makes a live view of this
     * re-render, and reading it per entry would not happen at all in a
     * workspace that is still empty.
     */
    const visible = new Set(inView.showing);

    const entries = [...workspace.entries().values()]
      .filter((entry) => entry.type !== "folder")
      .flatMap((entry) => {
        const path = index.of(entry.id);
        if (path === undefined) return [];
        return [described(entry, path, visible.has(entry.id), stored)];
      });

    return {
      taken: new Date(),
      entries,
      visible: entries.filter((entry) => entry.visible),
    };
  };

  /**
   * ONE PASS, before anything is read, so every entry is described as of the
   * same moment.
   *
   * The transaction is known synchronously or not at all: a snapshot describes
   * the moment it was asked for, so waiting on the write would describe a
   * later one. A room holding its writes still names one -- the draft the text
   * went into -- which the server can rebuild, so a snapshot naming it is as
   * portable as one naming a version.
   */
  const storeEveryDirtyFile = () => {
    const stored = new Map<Id, string>();
    for (const [entry, file] of openFiles) {
      if (!file.text?.dirty) continue;
      const transaction = file.text.versionBeingSaved();
      if (transaction !== undefined) stored.set(entry, transaction);
    }
    return stored;
  };

  const described = (
    entry: Metadata,
    path: string,
    visible: boolean,
    stored: Map<Id, string>,
  ): EntrySnapshot => {
    const text = openFiles.get(entry.id)?.text;
    const room = text?.rooms.get(entry.id);
    return {
      entry: entry.id,
      path,
      name: entry.name,
      versions: {
        name: entry.name_version,
        parent: entry.parent_version,
        deleted: entry.deleted_version,
        content: entry.content_version ?? null,
      },
      open: openFiles.has(entry.id),
      visible,
      dirty: text?.dirty === true,
      stage: room?.opening ?? "no room",
      watched: text?.watched === true,
      speaks: room?.speaks === true,
      runs: text?.runs.length ?? 0,
      ...(stored.has(entry.id) ? { stored: stored.get(entry.id) } : {}),
    };
  };

  /**
   * The door every write to a file goes through.
   *
   * A shared document is only the truth about a file while everything that
   * changed it went through here -- so anything else that writes has to be
   * given the chance to become an edit rather than a replacement.
   */
  const override: FileOverride = {
    get: (path) => textOpenAt(path)?.showing,

    put: (path, value) => {
      const text = textOpenAt(path);
      if (text === undefined) return false;
      if (writingBackWhatIsAlreadyShown(text, value)) return true;
      if (!roomHasSaidWhatItHolds(text)) return false;
      if (text.forceReplace(value)) void text.saveVersion();
      return true;
    },

    /**
     * Bytes replacing a file somebody has open as text.
     *
     * The remote case reaches the same conclusion by a different route: a
     * write from another client arrives over the stream and the room finds out
     * by READING the file, because nothing in a token says whether it names
     * text or bytes. This is that conclusion reached one step earlier, by a
     * caller already holding the bytes.
     *
     * TAKEN, and that is the only reason to be here at all: nothing is merged
     * -- there is nothing to merge bytes into -- so the write itself would be
     * identical down the ordinary path. What taking it buys is the TOKEN, and
     * the only way to know that before the round trip is to be the one who
     * sent it.
     */
    replaced: async (path, value, mime) => {
      const room = textOpenAt(path)?.room;
      if (room === undefined) return false;
      const { transaction, response } = workspace.write(path, value, mime);
      const answer = await response;
      if (!answer.rejected) room.tookAway(transaction, mime);
      return true;
    },
  };

  const textOpenAt = (path: string) => {
    const entry = tree?.mapping.of(path);
    return entry ? openFiles.get(entry)?.text : undefined;
  };

  /**
   * An editor writing back what it is already showing.
   *
   * It does this as it opens a file, and storing it is never right: at best a
   * version identical to the one before it, and at worst -- the case that cost
   * somebody a line -- a write of this person's own is still in flight, so
   * what the panel opened on is the text from BEFORE it, and putting that back
   * is that write undone by the act of looking at the file.
   */
  const writingBackWhatIsAlreadyShown = (
    text: { showing: string },
    value: string,
  ) => value === text.showing;

  /**
   * A room that has not said what it holds is not a room this write can go
   * into: editing a document that has not received its own content merges the
   * two rather than replacing one with the other, which is how a file ends up
   * saying everything twice. Refused, so the write goes the ordinary way and
   * the room picks it up as an ordinary gap when it does sync.
   */
  const roomHasSaidWhatItHolds = (text: { room?: { ready: boolean } }) =>
    text.room?.ready === true;

  /**
   * The page going away is a close that nobody clicked.
   *
   * A panel being shut is where unsaved typing is put away, and nothing shuts
   * the panels when the whole page goes -- but "I typed the last bit and then
   * closed the browser" is an ordinary way to stop working.
   *
   * `pagehide` rather than `beforeunload`: registering `beforeunload`
   * disqualifies the page from the back/forward cache in several browsers, and
   * this needs no prompt.
   */
  const keepWhatWasTypedWhenThePageGoes = () => {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", rescueEverything);
    document.addEventListener("visibilitychange", keepEverythingIfHidden);
    cleanup.add(() => {
      window.removeEventListener("pagehide", rescueEverything);
      document.removeEventListener("visibilitychange", keepEverythingIfHidden);
    });
  };

  const rescueEverything = () => {
    for (const file of openFiles.values()) file.text?.rescueWhatWasTyped();
  };

  /**
   * HIDDEN IS THE LAST MOMENT ANYTHING IS PROMISED. `pagehide` is not
   * guaranteed -- a tab discarded under memory pressure, a phone where the
   * browser is swapped out -- and several of those get `visibilitychange` and
   * nothing else.
   *
   * The ORDINARY keep here, not the rescue: the page is still alive and may
   * well come back, so this wants the outbox and its retries rather than a
   * single unacknowledged shot.
   */
  const keepEverythingIfHidden = () => {
    if (document.visibilityState !== "hidden") return;
    for (const file of openFiles.values()) file.text?.keepWhatWasTyped();
  };
</script>

<div class="bg-background h-full min-h-0 w-full {chrome}" data-region="shell">
  <GridView
    components={panels}
    orientation={Orientation.HORIZONTAL}
    proportionalLayout={false}
    onReady={({ api }) => layOut(api)}
  />
</div>
