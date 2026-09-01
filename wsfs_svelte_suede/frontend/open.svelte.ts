/**
 * One entry, open in a tab -- and what happens to what somebody types into it.
 *
 * The hard-won part is the ORDER: a room is joined, and only then is an editor
 * bound to it. A binding makes the editor say whatever the `Y.Text` says the
 * moment it is made, so binding a document that has not arrived does not show
 * an empty file, it MAKES one -- and the next store writes that over the real
 * content. Typing that happened in between is carried in as edits.
 */
import { MappedDebouncer } from "../../wsfs_core_suede/frontend";
import type { Id, Workspace } from "../../wsfs_core_suede/frontend";
import * as unsaved from "../../wsfs_core_suede/frontend/unsaved";
import { become, Rooms, type Room, type Sending, type Written } from "./room.svelte";
import type { Editor, Pressed, UserEdit } from "./editor";
import { cleaner } from "./utils";

const typingDebouncer = new MappedDebouncer({ idleMs: 500, maxWaitMs: 2000 });

/** One entry in a tree, as much of one as this file needs. */
export type Entry = { id: Id; path: string };

/**
 * One run of a file, and what it produced.
 *
 * `outputs` IS OPAQUE HERE, the way it is opaque on the wire: core's
 * `executed` takes whatever a kernel produced without reading it, so that a
 * kernel learning a new kind of output changes nothing above it.
 */
export type Run = {
  at: string;
  outputs: unknown[];
  ok: boolean;
  /** What the kernel said if it ended badly and did not say so in outputs. */
  failure?: string;
  /**
   * The transaction this run was recorded as, once it has been.
   *
   * Undefined while it is still on its way, and for a run whose snapshot was
   * refused -- so anything naming runs to somebody else has to skip the ones
   * that have no name yet. A tutor cannot be shown output the server has
   * never heard of.
   */
  transaction?: string;
};

/**
 * One entry with a panel open on it, before anybody knows what it holds.
 *
 * A file can turn out to be text or bytes, and only reading it says which. So
 * this exists from the moment a tab opens, and `text` appears if and when the
 * content arrives as text.
 */
export class OpenEntry {
  readonly id: Id;
  readonly rooms: Rooms;
  readonly workspace: Workspace;
  readonly readonly: boolean;

  text = $state<OpenText>();
  path = $state("");

  #whenTextArrives = new Set<(text: OpenText) => void>();

  constructor(
    { id, path }: Entry,
    rooms: Rooms,
    workspace: Workspace,
    readonly: boolean,
  ) {
    this.id = id;
    this.path = path;
    this.rooms = rooms;
    this.workspace = workspace;
    this.readonly = readonly;
  }

  moved(path: string) {
    this.path = path;
    this.text?.moved(path);
  }

  /**
   * Called if and when this entry turns out to hold text, which is only known
   * once it has been read. Called at once if it already does.
   */
  onText(listener: (text: OpenText) => void) {
    if (this.text) listener(this.text);
    else this.#whenTextArrives.add(listener);
    return () => void this.#whenTextArrives.delete(listener);
  }

  /**
   * The file turned out to hold text, so there is something to edit.
   *
   * A second call is the same file being read again and is ignored: what the
   * person has typed since must not be replaced by what the server said
   * first.
   */
  holdsText(content: string) {
    if (this.text !== undefined) return;
    this.text = new OpenText(
      this.id,
      this.path,
      content,
      this.rooms,
      this.workspace,
      this.readonly,
    );
    for (const listener of this.#whenTextArrives) listener(this.text);
    this.#whenTextArrives.clear();
  }
}

/** The text half of an open entry: its room, its stores, and its rescues. */
export class OpenText {
  readonly id: Id;
  readonly workspace: Workspace;
  readonly rooms: Rooms;
  /** What the workspace handed the editor before any room answered. */
  readonly openedOn: string;

  path = $state("");
  runs = $state<Run[]>([]);

  /**
   * The room, once it has synced AND reconciled.
   *
   * Undefined until then, which is also how anything rendering this knows not
   * to bind an editor yet.
   */
  room = $state<Room>();

  /** The room being joined, before `room` is answered for. */
  joining = $state<Room>();

  /** The shared text an editor binds to, once there is one to bind to. */
  document = $derived(this.room?.text);

  readonly cleanup = cleaner();

  #editor = $state<Editor>();
  #keyListeners = new Set<(pressed: Pressed) => void>();
  #editListeners = new Set<(edit: UserEdit) => void>();
  #disposed = false;
  #dirty = $state(false);

  constructor(
    id: Id,
    path: string,
    content: string,
    rooms: Rooms,
    workspace: Workspace,
    readonly: boolean,
  ) {
    this.id = id;
    this.path = path;
    this.openedOn = content;
    this.rooms = rooms;
    this.workspace = workspace;
    this.readonly = readonly;
    this.joining = rooms.get(id);
    void this.#join(rooms);
  }

  readonly readonly: boolean;

  /** Whether an editor is on screen and reporting this person's edits. */
  get watched() {
    return this.#editor !== undefined;
  }

  /** What the person can see: the room's text, or the editor's, or neither. */
  get showing(): string {
    return (
      this.document?.toString() ?? this.#editor?.text() ?? this.openedOn
    );
  }

  /**
   * Whether this holds anything that has NOT been submitted as a version.
   *
   * "Does what the user is looking at exist anywhere else yet" -- which is
   * what anything about to send this file somewhere needs to know.
   */
  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * Every transition through one door, so the unload prompt cannot drift.
   *
   * A setter rather than a call at each of the four sites that change it,
   * because the sites are the problem: one of them forgetting is a page that
   * asks about work it already sent, or worse, one that does not ask about
   * work it did not.
   */
  set dirty(value: boolean) {
    if (this.#dirty === value) return;
    this.#dirty = value;
    if (value) unsaved.hold(this.id);
    else unsaved.release(this.id);
  }

  /**
   * An editor is on screen and drawing this file. Returns the undo.
   *
   * Separate from construction because the panel is what comes and goes: a
   * tab dragged to another group is torn down and rebuilt, and what the
   * person typed must not go with it.
   */
  mounted(editor: Editor): () => void {
    this.#editor = editor;
    const stopWatchingEdits = editor.edits.subscribe({
      edited: (edit) => this.#typed(edit),
    });
    const stopWatchingKeys = editor.keys?.((pressed) => this.#pressed(pressed));
    return () => {
      stopWatchingEdits();
      stopWatchingKeys?.();
      if (this.#editor === editor) this.#editor = undefined;
    };
  }

  /** Every key pressed with hands in this file's editor. Returns the undo. */
  keys(listener: (pressed: Pressed) => void): () => void {
    this.#keyListeners.add(listener);
    return () => void this.#keyListeners.delete(listener);
  }

  /** Every edit the person at this keyboard made. Returns the undo. */
  edits(listener: (edit: UserEdit) => void): () => void {
    this.#editListeners.add(listener);
    return () => void this.#editListeners.delete(listener);
  }

  /** Stores a version now, and stops being dirty. */
  saveVersion(): Promise<Written> {
    const sent = this.submitVersion();
    if (sent.withheld) return Promise.resolve(sent);
    return sent.response.then((answer) => ({
      withheld: false as const,
      transaction: sent.transaction,
      rejected: answer.rejected,
    }));
  }

  /**
   * The same write, answered with the transaction and not waited on.
   *
   * What a snapshot uses: it describes the moment it was asked for, and
   * waiting on the server would describe a later one.
   */
  submitVersion(): Sending {
    const sent = this.room?.submitVersion() ?? notOpenYet;
    if (this.#leftThisMachine(sent)) this.#nothingUnsent();
    return sent;
  }

  /**
   * The version this file's text was put on the server as, whichever way.
   *
   * Undefined only when there was no text to put anywhere.
   */
  versionBeingSaved(): string | undefined {
    const sent = this.submitVersion();
    return sent.withheld ? (sent.draft ?? undefined) : sent.transaction;
  }

  /**
   * Makes the shared text say `next`, changing as little as possible.
   *
   * NOT FOR CHANGES COMING FROM THE SERVER -- the room carries those. This is
   * for a local environment writing the file on the person's behalf: a script
   * writing it, an editor refactoring it.
   */
  forceReplace(next: string): boolean {
    if (this.showing === next) return false;
    const document = this.document;
    if (document) become(document, next);
    else this.#editor?.replace(next);
    return true;
  }

  moved(path: string) {
    this.path = path;
  }

  /**
   * Put away anything typed here that is not anywhere else yet.
   *
   * Closing a tab is not a decision to throw work away. When a document holds
   * the text this is one ordinary store; when none does yet -- opened, typed
   * and shut inside the second a room takes to open -- the text is in the
   * editor and nowhere at all, and it goes the way the document itself would
   * have sent it.
   *
   * Not awaited, because a closing panel has nothing to wait with: the
   * transaction is in the durable outbox before this returns, and the outbox
   * is what promises delivery.
   */
  keepWhatWasTyped() {
    if (!this.dirty) return;
    if (this.room !== undefined) return void this.saveVersion();

    const onScreen = this.#editor?.text();
    if (onScreen === undefined || onScreen === this.openedOn) return;
    void this.workspace.shares(this.id, onScreen).response.catch(ignored);
    this.#nothingUnsent();
  }

  /**
   * The same intent, for the moment the page goes.
   *
   * `keepWhatWasTyped` is right everywhere the page is still alive, because
   * it goes through the outbox and the outbox promises eventual delivery. It
   * is WRONG on the way out of the document: the outbox hashes and writes to
   * IndexedDB before anything reaches the network, and a document being torn
   * down does not come back from those awaits.
   */
  rescueWhatWasTyped() {
    if (!this.dirty) return;
    const onScreen = this.showing;
    if (onScreen === this.openedOn) return;
    this.workspace.rescue(this.id, onScreen);
    this.#nothingUnsent();
  }

  dispose() {
    if (this.#disposed) return;
    this.keepWhatWasTyped();
    this.#disposed = true;
    this.cleanup();
    this.#keyListeners.clear();
    this.#editListeners.clear();
    this.rooms.close(this.id);
  }

  async #join(rooms: Rooms) {
    try {
      const room = await rooms.open(this.id);
      if (this.#disposed) return;
      this.#carryInWhatWasTypedWhileJoining(room);
      this.room = room;
      this.#saveWhatTheRoomWasNotOpenFor();
    } catch (reason) {
      this.#roomNeverOpened(reason);
    }
  }

  /**
   * Typing that happened while the room was still opening.
   *
   * Opening is two round trips and a socket, and somebody who opens a file and
   * types straight away is typing into an editor bound to nothing yet. Without
   * this, that typing is not lost quietly at the far end: it is discarded on
   * screen, at the moment collaboration starts, in front of the person who
   * typed it.
   *
   * Carried in as EDITS rather than as a value, so everybody else's copy
   * merges them rather than being overwritten -- and ONLY when the room still
   * says what this editor opened on, because then the difference between the
   * two is this person's typing and nothing else. If the room has moved on,
   * the difference is somebody else's text as well, and replaying it would
   * carry theirs away. The room wins there: it is the only one of the two
   * that more than one person can see.
   */
  #carryInWhatWasTypedWhileJoining(room: Room) {
    if (!this.dirty) return;
    const onScreen = this.#editor?.text();
    if (onScreen === undefined) return;
    const roomSays = room.text.toString();
    if (roomSays === onScreen || roomSays !== this.openedOn) return;
    become(room.text, onScreen);
  }

  /**
   * The store this file already asked for, which was refused for having
   * nowhere to put it.
   *
   * Typing enqueues a debounced store, and one made before the room is open is
   * answered "the room is not open yet" and held -- correctly. But nothing
   * asked again, so the file stayed dirty until the person typed one more
   * character, and if they did not, what they had written sat in an editor on
   * one machine and went with the tab.
   */
  #saveWhatTheRoomWasNotOpenFor() {
    if (this.dirty) void this.saveVersion();
  }

  /**
   * A room that never syncs leaves the editor on the content the workspace
   * handed it, unshared and unbound -- a worse experience than collaborating
   * and a much better one than an empty file.
   *
   * Silent when the registry has gone: the open was interrupted by the
   * workspace being put away, and there is nobody left to show a document to.
   */
  #roomNeverOpened(reason: unknown) {
    if (this.rooms.gone) return;
    console.error(`room ${this.id} did not open`, reason);
  }

  #typed(edit: UserEdit) {
    this.dirty = true;
    typingDebouncer.enqueue(this.id, () => this.saveVersion());
    for (const listener of this.#editListeners) listener(edit);
  }

  #pressed(pressed: Pressed) {
    for (const listener of this.#keyListeners) listener(pressed);
  }

  #leftThisMachine(sent: Sending) {
    return !sent.withheld || sent.draft !== null;
  }

  #nothingUnsent() {
    typingDebouncer.clear(this.id);
    this.dirty = false;
  }
}

const notOpenYet: Sending = {
  withheld: true,
  why: "the room is not open yet",
  draft: null,
  response: null,
};

const ignored = () => undefined;

/**
 * One entry, as anything about to describe this workspace needs it.
 *
 * All four tokens, not just the content one, because together they are the
 * entry: what it is called, where it lives, whether it is gone, and what is in
 * it. A snapshot naming all four can be rebuilt into the filesystem as it
 * stood -- and it stays rebuildable even if the server later refuses one of
 * those transactions, because what it records is what the user was looking at,
 * which happened whether or not anybody agreed to it.
 */
export type EntrySnapshot = {
  entry: Id;
  path: string;
  name: string;
  versions: {
    name: string;
    parent: string;
    deleted: string;
    content: string | null;
  };
  open: boolean;
  /** On screen right now. Two panels side by side are both on screen. */
  visible: boolean;
  /**
   * What the user is looking at is not any of the versions above yet.
   *
   * Never true in a snapshot taken with `resolveDirty`, which is the point of
   * that option.
   */
  dirty: boolean;
  /** How far opening this file's room has got. Diagnostic. */
  stage: string;
  /** Whether an editor is on screen reporting this person's edits. */
  watched: boolean;
  /** Whether this file's room may write it back right now. Diagnostic. */
  speaks: boolean;
  /**
   * How many runs of this file go with it.
   *
   * On the snapshot rather than counted where it is shown, so the thing that
   * DECIDES what accompanies a question and the thing that displays it read
   * one number.
   */
  runs: number;
  /**
   * The transaction this snapshot submitted for it, if it submitted one.
   *
   * Its content version does not exist yet -- the token above is still the old
   * one -- so this is what names the version the user was actually looking at.
   */
  stored?: string;
};

export type Snapshot = {
  taken: Date;
  entries: EntrySnapshot[];
  /** The subset the user can actually see, which is the useful default. */
  visible: EntrySnapshot[];
};

export type Taking = {
  /**
   * Submit every dirty editor first, in ONE pass, and record what was
   * submitted.
   *
   * Without it a caller has to check `dirty`, store, and check again -- and
   * something typed in between leaves it looping, or worse, describing a state
   * that was never on screen. One pass says: this is what the user had at the
   * moment I asked.
   */
  resolveDirty?: boolean;
};
