import type {
  DockviewApi,
  DockviewOrigin,
  LayoutHistoryKind,
  SerializedDockview,
} from "dockview";

/**
 * An undo stack for a dockview, built on the four public signals upstream's
 * own (licensed) history service consumes.
 *
 * `DockviewApi` carries `undo` / `redo` / `canUndo` / `onDidChangeHistory` of
 * its own. Those belong to the enterprise LayoutHistory module and do nothing
 * on the free package, so this deliberately does not shadow them: a consumer
 * holds this object, not the api, to drive history. Keybindings stay the
 * app's business, as they are upstream.
 */
export type LayoutHistory = {
  /** Step back one recorded entry. Resolves once any popout has reopened. */
  undo(): Promise<void>;
  /** Re-apply the entry that `undo` stepped back over. */
  redo(): Promise<void>;
  /** Reactive, so a button can bind its `disabled` straight to it. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoCount: number;
  readonly redoCount: number;
  /** Drop both stacks, e.g. on a document switch. */
  clear(): void;
  dispose(): void;
};

export type LayoutHistoryOptions = {
  /**
   * Which mutations are recorded. Recording user gestures only is the usual
   * thing an undo stack wants; include `"api"` to also record the layout
   * changes the application itself makes.
   */
  origins?: readonly DockviewOrigin[];
  /**
   * How long a sash drag must rest before it becomes one entry. Resizes
   * surface only through `onDidLayoutChange`, so without this a single drag
   * would be dozens of entries. `0` leaves resizes unrecorded.
   */
  resizeSettleMs?: number;
  /** How many entries to keep before the oldest is dropped. */
  limit?: number;
};

const defaults = {
  origins: ["user"],
  resizeSettleMs: 250,
  limit: 50,
} as const satisfies Required<LayoutHistoryOptions>;

/** A layout mutation, held as the two images it moved the dock between. */
type Entry = {
  kind: LayoutHistoryKind;
  origin: DockviewOrigin;
  before: SerializedDockview;
  after: SerializedDockview;
};

const isSameLayout = (a: SerializedDockview, b: SerializedDockview) =>
  JSON.stringify(a) === JSON.stringify(b);

export const createLayoutHistory = (
  api: DockviewApi,
  options: LayoutHistoryOptions = {}
): LayoutHistory => {
  const { origins, resizeSettleMs, limit } = { ...defaults, ...options };

  const done = $state<Entry[]>([]);
  const undone = $state<Entry[]>([]);

  /** While an entry is being applied, the mutations it causes are not history. */
  let applying = false;

  /** The layout as of the last entry — what a sash drag is measured from. */
  let settled = api.toJSON();

  /** The pre-image of the mutation currently in flight, if we are recording it. */
  let pending: SerializedDockview | undefined;

  const records = (origin: DockviewOrigin) =>
    !applying && origins.includes(origin);

  const record = (entry: Entry) => {
    done.push(entry);
    if (done.length > limit) done.shift();
    undone.length = 0;
    settled = entry.after;
  };

  /**
   * `reuseExistingPanels` keeps the panel instances alive, and with them the
   * subscribers `reactive()` params attach to. Without it an undo would swap
   * in fresh panel objects whose reactive params silently stop updating.
   */
  const apply = async (snapshot: SerializedDockview) => {
    applying = true;
    try {
      api.fromJSON(snapshot, { reuseExistingPanels: true });
      await api.popoutRestorationPromise;
    } finally {
      applying = false;
      settled = api.toJSON();
    }
  };

  const step = async (
    from: Entry[],
    to: Entry[],
    image: (entry: Entry) => SerializedDockview
  ) => {
    const entry = from.pop();
    if (!entry) return;
    to.push(entry);
    await apply(image(entry));
  };

  const onWillMutate = api.onWillMutateLayout(({ origin }) => {
    pending = records(origin) ? api.toJSON() : undefined;
  });

  const onDidMutate = api.onDidMutateLayout(({ kind, origin }) => {
    const before = pending;
    pending = undefined;
    if (!before || !records(origin)) return;
    record({ kind, origin, before, after: api.toJSON() });
  });

  let settling: ReturnType<typeof setTimeout> | undefined;

  /**
   * A sash drag never crosses the mutation boundary, so it arrives only as a
   * flurry of layout changes; the entry is written once they stop.
   */
  const recordResize = () => {
    const after = api.toJSON();
    if (isSameLayout(settled, after)) return;
    record({ kind: "resize", origin: "user", before: settled, after });
  };

  const onDidLayoutChange = api.onDidLayoutChange(() => {
    if (applying || !resizeSettleMs) return;
    clearTimeout(settling);
    settling = setTimeout(recordResize, resizeSettleMs);
  });

  return {
    undo: () => step(done, undone, ({ before }) => before),
    redo: () => step(undone, done, ({ after }) => after),
    get canUndo() {
      return done.length > 0;
    },
    get canRedo() {
      return undone.length > 0;
    },
    get undoCount() {
      return done.length;
    },
    get redoCount() {
      return undone.length;
    },
    clear() {
      done.length = 0;
      undone.length = 0;
    },
    dispose() {
      clearTimeout(settling);
      onWillMutate.dispose();
      onDidMutate.dispose();
      onDidLayoutChange.dispose();
    },
  };
};
