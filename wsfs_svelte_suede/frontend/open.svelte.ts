/**
 * One file, open -- and what happens to what somebody types into it.
 *
 * THE SURFACE IS NOT NAMED HERE. What a file is edited in is `Editing` (see
 * `surface.ts`), so everything below works the same whether the person is
 * looking at Monaco, at this package's textarea, or at something a consumer
 * registered. What is here is the part that is the same either way: when the
 * room may be bound to, when what was typed becomes a version, and where it
 * goes when the panel or the page is taken away.
 *
 * THE HARD-WON PART IS THE ORDER. Opened, then bound -- never the other way
 * about -- and typing that happened in between carried in as EDITS. Both are
 * explained at their call sites, and both were paid for by somebody losing
 * what they had written.
 */
import { MappedDebouncer } from "../../wsfs_core_suede/frontend";
import type {
  Id,
  Workspace,
} from "../../wsfs_core_suede/frontend";
import * as unsaved from "../../wsfs_core_suede/frontend/unsaved";
import { become, Rooms, type Room, type Sending, type Written } from "./room.svelte";
import type { Editing, Surface } from "./surface";
import type { UserEdit } from "./edits";
import { cleaner } from "./utils";

const typingDebouncer = new MappedDebouncer({
  idleMs: 500,
  maxWaitMs: 2000,
});

/** One entry in a tree, as much of one as this file needs. */
export type Entry = { id: Id; path: string };

export class OpenFile {
  readonly id: Id;
  readonly rooms: Rooms;
  readonly surface: Surface;
  readonly workspace: Workspace;
  readonly readonly: boolean;
  readonly onEdit: ((edit: UserEdit) => void) | undefined;

  sharedText = $state<SharedTextFile>();
  path = $state("");

  constructor(
    { id, path }: Entry,
    rooms: Rooms,
    surface: Surface,
    workspace: Workspace,
    readonly: boolean,
    onEdit?: (edit: UserEdit) => void,
  ) {
    this.id = id;
    this.path = path;
    this.rooms = rooms;
    this.surface = surface;
    this.workspace = workspace;
    this.readonly = readonly;
    this.onEdit = onEdit;
  }

  move(path: string) {
    this.path = path;
    this.sharedText?.moved(path);
  }

  /**
   * The file turned out to hold text, so there is something to edit.
   *
   * Called once, by whatever read the content. A second call is the same file
   * being read again and is ignored -- what the person has typed since must
   * not be replaced by what the server said first.
   */
  share(content: string) {
    const { id, path, rooms, surface } = this;
    this.sharedText ??= new SharedTextFile(
      id,
      path,
      content,
      rooms,
      surface,
      this.workspace,
      this.readonly,
      this.onEdit,
    );
  }
}

/**
 * One run of this file, and what it produced.
 *
 * `outputs` IS OPAQUE HERE, the way it is opaque on the wire: core's
 * `executed` takes whatever a kernel produced without reading it, so that a
 * kernel learning a new kind of output changes nothing above it. Whoever ran
 * the file is the one that knows what these are.
 */
export type Execution = {
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
   * that have no name yet. That is not a gap to paper over: a tutor cannot
   * be shown output the server has never heard of.
   */
  transaction?: string;
};

export class SharedTextFile {
  readonly id: Id;
  readonly workspace: Workspace;
  /** The surface's own handle on this file. See `surface.ts`. */
  readonly editing: Editing;
  readonly initialContent: string;

  /** Every room the containing workspace holds -- one event stream feeds all of them. */
  readonly rooms: Rooms;

  /**
   * Every run of this file, oldest first.
   */
  executions = $state<Execution[]>([]);

  /**
   * The protocol, shared with the two-browser suite.
   *
   * Undefined until the room has synced AND reconciled, which is also how
   * anything rendering this knows not to show an editor yet.
   */
  shared = $state<Room>();

  /** The room being opened, before `shared` is answered for. */
  opening = $state<Room>();

  readonly cleanup = cleaner();

  /** Whether the surface is reporting this person's edits yet. */
  get watching() {
    return this.editing.edits !== undefined;
  }

  /**
   * Whether this holds anything that has NOT been submitted as a version.
   *
   * The question it answers is "does what the user is looking at exist
   * anywhere else yet" -- which is what anything about to send this file
   * somewhere needs to know, so it can store first.
   */
  #dirty = $state(false);

  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * Every transition through one door, so the prompt cannot drift.
   *
   * Whether to warn a person on their way out is the same question as this
   * flag, asked of every open file at once -- so it is answered here rather
   * than at the four places that set it. A setter and not a call at each
   * site because the sites are the problem: one of them forgetting is a
   * page that asks about work it already sent, or worse, one that does not
   * ask about work it did not. See `unsaved.ts`.
   */
  set dirty(value: boolean) {
    if (this.#dirty === value) return;
    this.#dirty = value;
    if (value) unsaved.hold(this.id);
    else unsaved.release(this.id);
  }

  constructor(
    id: Id,
    path: string,
    content: string,
    rooms: Rooms,
    surface: Surface,
    workspace: Workspace,
    readonly: boolean,
    onEdit?: (edit: UserEdit) => void,
  ) {
    this.id = id;
    this.initialContent = content;
    this.workspace = workspace;
    this.path = path;
    this.editing = surface.open({ path, content, readonly });
    this.#announce = onEdit;

    /**
     * Opened, then bound -- and never the other way about.
     *
     * `Rooms.open` does not resolve until the document has been RECEIVED and
     * reconciled against what the server holds. Binding before that is not a
     * cosmetic race: `MonacoBinding` makes the model say whatever the
     * `Y.Text` says the moment it is constructed, so binding an
     * unsynchronised document does not show an empty file, it MAKES one --
     * and the next store writes that over the real content.
     *
     * This is what the old `subscribe("status")` wiring got wrong. Liveblocks
     * says `connected` when the SOCKET is up, which is a strictly earlier
     * moment than the Yjs provider having the document.
     */
    this.rooms = rooms;
    this.opening = rooms.get(id);
    void rooms
      .open(id)
      .then((room) => {
        if (this.#disposed) return;
        this.#carryInWhatWasTypedWhileOpening(room);
        this.shared = room;
        this.editing.bind(room.text);
        /**
         * And store it, because the store it already asked for was refused.
         *
         * Typing enqueues a debounced store, and a store made before the
         * room is open is answered "the room is not open yet" and held --
         * correctly, since there was nowhere to put it. But nothing asked
         * again. The file stayed dirty until the person typed one more
         * character, and if they did not, what they had written sat in a
         * model on one machine: not on the server, not in the room, not in
         * a draft, and gone with the tab.
         *
         * Opening is the moment that stops being true, so it is the moment
         * to ask again.
         */
        if (this.dirty) void this.store();
      })
      /**
       * A room that never syncs leaves the surface on the content the
       * workspace handed it, unshared and unbound -- which is a worse
       * experience than collaborating and a much better one than an empty
       * file. Nothing is bound, so `source` falls back to what the surface
       * holds, and `store` answers that it was held.
       */
      .catch((reason) => {
        /**
         * Silent when the registry has gone: the open was interrupted by
         * the workspace being put away, and there is nobody left to show
         * the document to. Anything else is worth saying.
         */
        if (rooms.gone) return;
        console.error(`room ${id} did not open`, reason);
      });

  }

  /**
   * Start listening to whichever surface is drawing this file.
   *
   * Separate from construction because a surface only reports edits once
   * there is a view watching -- see `Editing.edits` -- and the panel that
   * draws it comes and goes. Returns the undo, so a view can call this on
   * mount and hand it back.
   */
  watch(): () => void {
    const edits = this.editing.edits;
    if (edits === undefined) return () => undefined;
    return edits.subscribe({
      edited: (edit) => {
        this.dirty = true;
        typingDebouncer.enqueue(this.id, () => this.store());
        this.#announce?.(edit);
      },
    });
  }

  readonly #announce: ((edit: UserEdit) => void) | undefined;

  /**
   * Typing that happened while the room was still opening.
   *
   * Opening is two round trips and a socket, and a person who opens a file
   * and types straight away is typing into a model that is bound to
   * nothing yet. `MonacoBinding` makes the model say whatever the `Y.Text`
   * says the moment it is constructed -- so without this, that typing is
   * not lost slowly or quietly at the far end. It is discarded on screen,
   * at the moment collaboration starts, in front of the person who typed
   * it, and the only sign is that the characters go away.
   *
   * Carried in as EDITS rather than as a value, because the document is the
   * shared one: what arrives has to be the insertions it actually was, so
   * that everybody else's copy merges them rather than being overwritten.
   *
   * ONLY WHEN THE ROOM STILL SAYS WHAT THIS EDITOR OPENED ON. Then the
   * difference between the two is this person's typing and nothing else,
   * which is the whole reason replaying it is safe. If the room is somewhere
   * else -- somebody stored while this was opening, or it is holding work
   * from a session that closed before a store landed -- then the difference
   * is their text as well, and replaying it would carry theirs away. That
   * case is left as it was: the room wins, because it is the only one of
   * the two that more than one person can see.
   */
  #carryInWhatWasTypedWhileOpening(room: Room) {
    if (!this.dirty) return;
    const typed = this.editing.value();
    if (typed === undefined) return;
    const holds = room.text.toString();
    if (holds === typed || holds !== this.initialContent) return;
    become(room.text, typed);
  }

  /**
   * Stores a version now, and stops being dirty.
   */
  store(): Promise<Written> {
    const sent = this.send();
    if (sent.held) return Promise.resolve(sent);
    return sent.settled.then((answer) => ({
      held: false as const,
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
  send(): Sending {
    const { id } = this;
    const room = this.shared;
    const sent: Sending =
      room === undefined
        ? {
            held: true,
            why: "the room is not open yet",
            draft: null,
            settled: null,
          }
        : room.send();
    /**
     * Cleared once the text has left this machine, whichever way it left.
     */
    if (!sent.held || sent.draft !== null) {
      typingDebouncer.clear(id);
      this.dirty = false;
    }
    return sent;
  }

  /** The transaction a snapshot can name for this file, if there is one. */
  /**
   * The version this file's text was put on the server as, whichever way.
   *
   * Undefined only when there was no text to put anywhere.
   */
  storing(): string | undefined {
    const sent = this.send();
    return sent.held ? (sent.draft ?? undefined) : sent.transaction;
  }

  /**
   * Makes the shared text say `value`, changing as little as possible.
   *
   * This shouldn't be used with changes coming from the server
   * (we rely on yjs / liveblocks for that).
   *
   * Instead, this is for cases when a user's local environment wants to update
   * their content (and thus they are responsible for it -- e.g. python writes, monaco refactors)
   */
  forceReplace(value: string): boolean {
    if (this.source === value) return false;
    const text = this.editing.bound();
    if (text) become(text, value);
    else this.editing.replace(value);
    return true;
  }

  /** Where this file is now. Read by anything that draws its name. */
  path = $state("");

  moved(path: string) {
    this.path = path;
    this.editing.moved(path);
  }

  get source() {
    return this.editing.value();
  }

  #disposed = false;

  /**
   * Put away anything typed here that is not anywhere else yet.
   *
   * Closing a tab is not a decision to throw work away, and this is the one
   * moment where it was: what a person types lives in the editor's model
   * until a document holds it, and the model goes with the panel.
   *
   * WHEN A DOCUMENT HOLDS IT this is one ordinary store -- the text is
   * already in the shared document, so there is nothing to carry and no
   * question of clobbering anybody.
   *
   * WHEN NONE DOES YET, which is the fast case -- opened, typed and shut
   * inside the second or so a room takes to open -- the text is in the
   * model and nowhere at all. It cannot go by the ordinary write, because a
   * document is on its way and writing around one is refused. So it goes
   * the way the document itself would have sent it: this panel is, at this
   * instant, the only thing holding the file's text, which is exactly what
   * `shares` is for.
   *
   * Not awaited, because a closing panel has nothing to wait with. It does
   * not need to: the transaction is in the durable outbox before this
   * returns, and the outbox is what promises delivery.
   */
  keepWhatWasTyped() {
    if (!this.dirty) return;
    if (this.shared !== undefined) return void this.store();
    const typed = this.editing.value();
    if (typed === undefined || typed === this.initialContent) return;
    void this.workspace.shares(this.id, typed).settled.catch(() => undefined);
    /**
     * No longer holding anything nobody else has. The transaction is in the
     * outbox, which is a better place than this model -- and saying so
     * matters when the page does not actually go after all, as a page put
     * into the back/forward cache and then come back to has not.
     */
    typingDebouncer.clear(this.id);
    this.dirty = false;
  }

  /**
   * The same intent as `keepWhatWasTyped`, for the moment the page goes.
   *
   * `keepWhatWasTyped` is the right thing everywhere the page is still
   * alive -- a panel shutting, a tab being switched away from -- because it
   * goes through the outbox, which is what promises the text will arrive
   * eventually even if this attempt does not. It is the WRONG thing on the
   * way out of the document: the outbox hashes and writes to IndexedDB
   * before anything reaches the network, and a document being torn down
   * does not come back from those awaits. Which is how "created a file,
   * typed into it, reloaded" ended with an empty file and no version to
   * recover: the write never left, and the queue that was supposed to
   * remember it never got written down either.
   *
   * `dirty` is exactly the right question to ask. It is cleared the moment
   * text leaves this machine by any route, so a file that is still dirty is
   * one whose text is nowhere else yet -- whether or not a room holds it.
   *
   * `source` rather than the editor's model, because it prefers the shared
   * document when there is one and falls back to the model when there is
   * not, and this has to work in both.
   */
  rescueWhatWasTyped() {
    if (!this.dirty) return;
    const text = this.source;
    if (text === undefined || text === this.initialContent) return;
    this.workspace.rescue(this.id, text);
  }

  dispose() {
    if (this.#disposed) return;
    this.keepWhatWasTyped();
    this.#disposed = true;
    this.cleanup();
    this.editing.dispose();
    this.rooms.close(this.id);
  }
}

/**
 * One entry, as anything about to describe this workspace needs it.
 *
 * All four tokens, not just the content one, because together they are the
 * entry: what it is called, where it lives, whether it is gone, and what is
 * in it. A snapshot naming all four can be rebuilt into the filesystem as
 * it stood -- and it stays rebuildable even if the server later refuses one
 * of those transactions, because what it records is what the user was
 * looking at, which happened whether or not anybody agreed to it.
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
   * Never true in a snapshot taken with `resolveDirty`, which is the point
   * of that option.
   */
  dirty: boolean;
  /** How far opening this file's room has got. Diagnostic. */
  stage: string;
  /** Whether this file's editor is being watched for the user's own edits. */
  watching: boolean;
  /** Whether this file's room may write it back right now. Diagnostic. */
  speaks: boolean;
  /**
   * How many runs of this file go with it.
   *
   * On the snapshot rather than counted where it is shown, so the thing
   * that DECIDES what accompanies a question and the thing that displays it
   * read one number.
   */
  executions: number;
  /**
   * The transaction this snapshot submitted for it, if it submitted one.
   *
   * Its content version does not exist yet -- the token above is still the
   * old one -- so this is what names the version the user was actually
   * looking at.
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
   * Without it a caller has to check `dirty`, store, and check again --
   * and something typed in between leaves it looping, or worse, describing
   * a state that was never on screen. One pass says: this is what the user
   * had at the moment I asked. Anything typed after belongs to the next
   * snapshot.
   */
  resolveDirty?: boolean;
};
