/**
 * What the browser tests need and the app does not.
 *
 * Everything here is about WAITING. A workspace is a network round trip and a
 * stream event behind every gesture, so a browser test that asserts
 * immediately is asserting on the optimistic view -- which is exactly the
 * thing worth distinguishing from the confirmed one.
 */
import { connect, http, inMemory, type Workspace } from "$wsfs";

const BACKEND = "/wsfs";

const asUser = (email: string) => async () => ({ "X-User-Email": email });

/**
 * A workspace, plus the path list the tests wait on.
 *
 * The app has no use for this -- it reads what it needs when it needs it --
 * but a test that says "wait until the other client has this" needs the
 * question to be cheap and reactive, and that is all this adds.
 */
export class Client {
  readonly workspace: Workspace;
  paths = $state<string[]>([]);
  readonly #stop: () => void;

  constructor(id: string, user: string) {
    this.workspace = connect({
      workspace: id,
      transport: http(BACKEND, asUser(user)),
      bytes: inMemory(),
    });
    this.#stop = this.workspace.watch(() => {
      this.paths = [...this.workspace.index().paths()].sort();
    });
  }

  dispose() {
    this.#stop();
    this.workspace.stop();
  }
}

/** The host's own endpoint: provisioning is not wsfs's business. */
export const project = async (email: string): Promise<string> => {
  const response = await fetch("/projects", {
    method: "POST",
    headers: { "X-User-Email": email },
  });
  if (!response.ok) throw new Error(`could not open a project: ${response.status}`);
  return ((await response.json()) as { id: string }).id;
};

export const until = async (
  what: string,
  holds: () => boolean,
  /** What the world looked like instead. A timeout that only says which
   * condition failed sends you back to the browser to find out why. */
  instead?: () => string,
  within = 10_000,
): Promise<void> => {
  const deadline = Date.now() + within;
  while (!holds()) {
    if (Date.now() > deadline) {
      const saw = instead ? ` -- saw ${instead()}` : "";
      throw new Error(`timed out waiting for ${what}${saw}`);
    }
    await new Promise((wake) => setTimeout(wake, 25));
  }
};

/**
 * Every element under `root`, INCLUDING the ones inside open shadow roots.
 *
 * The tree is a custom element and draws its rows in a shadow root, so a
 * plain `querySelectorAll` from the page finds nothing at all -- which reads
 * exactly like a tree that never rendered.
 */
export const everythingIn = (root: ParentNode): Element[] => everything(root);

const everything = (root: ParentNode): Element[] => {
  const found: Element[] = [];
  for (const element of root.querySelectorAll("*")) {
    found.push(element);
    if (element.shadowRoot) found.push(...everything(element.shadowRoot));
  }
  return found;
};

/**
 * The rows the tree is drawing, by the identity the tree itself gives them.
 *
 * Not by their text: a row renders its name more than once -- visible, and
 * again for measuring the truncation -- so `textContent` reads "notes.notes.
 * md md" and matches nothing. `data-item-path` is the tree's own answer to
 * "which entry is this row", which is the question being asked.
 */
const rows = (within: HTMLElement): HTMLElement[] =>
  everything(within).filter(
    (element) => element.getAttribute("data-type") === "item",
  ) as HTMLElement[];

const pathOf = (row: HTMLElement) => row.getAttribute("data-item-path") ?? "";

/**
 * A folder's row carries a trailing separator and a file's does not, so a
 * caller that knows the name need not know which it is looking at.
 */
export const rowFor = (within: HTMLElement, path: string): HTMLElement | undefined =>
  rows(within).find((row) => pathOf(row) === path || pathOf(row) === `${path}/`);

/** Every path the tree is drawing -- for saying what it drew instead. */
export const drawn = (within: HTMLElement): string[] =>
  [...new Set(rows(within).map(pathOf))].filter(Boolean);

const live = new Set<Client>();

/**
 * Hands back every connection the tests before this one opened.
 *
 * `harness.onAbort` runs when a test is CANCELLED, not when it finishes, so
 * without this nothing ever closes a client -- and a browser lends one origin
 * six connections, each of which a workspace holds open to follow its stream.
 * The seventh then waits for a socket that never frees, and the test that
 * asked for it times out having seen nothing at all.
 *
 * Called where a test opens its FIRST client, so it sweeps the previous test
 * rather than its own.
 */
const handBack = () => {
  for (const client of live) client.dispose();
  live.clear();
};

const tracked = (client: Client) => (live.add(client), client);

/**
 * A second client in the same workspace -- another tab, or another person.
 * Assertions land here rather than on the client under test, because a client
 * showing its own optimistic work proves nothing about what was stored.
 */
export const alongside = (id: string, user = "grace@example.com") =>
  tracked(new Client(id, user));

export const opened = async (user = "ada@example.com") => {
  handBack();
  const id = await project(user);
  return { id, workspace: tracked(new Client(id, user)) };
};

/**
 * A region of the shell, by the name its component puts on itself. The grid
 * draws its panels into the light DOM, so this is a plain lookup -- unlike
 * the tree's rows above, which are not.
 */
export const region = (within: HTMLElement, name: string): HTMLElement | undefined =>
  (within.querySelector(`[data-region="${name}"]`) as HTMLElement | null) ?? undefined;

/** Every region the shell drew -- for saying what it laid out instead. */
export const regions = (within: HTMLElement): string[] =>
  [...within.querySelectorAll("[data-region]")].map(
    (element) => element.getAttribute("data-region") ?? "",
  );

/** The three panels the shell lays out, left to right. */
const PANELS = ["explorer", "documents", "assistant"] as const;

/** Whether the shell has drawn all three of them yet. */
export const laidOut = (root: HTMLElement) => () =>
  PANELS.every((name) => !!region(root, name));

/** Where a region sits, so an assertion can talk about left and right. */
export const box = (root: HTMLElement, name: string): DOMRect =>
  region(root, name)!.getBoundingClientRect();

/** The dock's tabs, which is where an open file announces itself. */
export const tabs = (within: HTMLElement): HTMLElement[] =>
  [...within.querySelectorAll(".dv-tab")] as HTMLElement[];

/**
 * A click on a tree row, as the tree's own handlers see one.
 *
 * Not `userEvent`: a row lives in a shadow root, where its pointer checks
 * cannot resolve what sits under the cursor and refuse the interaction.
 */
export const clickRow = async (row: HTMLElement): Promise<void> => {
  const { top, left } = row.getBoundingClientRect();
  const at = {
    bubbles: true,
    composed: true,
    button: 0,
    clientX: left + 8,
    clientY: top + 4,
  };
  row.dispatchEvent(new PointerEvent("pointerdown", at));
  row.dispatchEvent(new MouseEvent("mousedown", at));
  row.dispatchEvent(new PointerEvent("pointerup", at));
  row.dispatchEvent(new MouseEvent("mouseup", at));
  row.dispatchEvent(new MouseEvent("click", at));
  await new Promise(requestAnimationFrame);
};

/**
 * A right click at a point, as the tree's own handlers see one.
 *
 * `composed` matters: a row lives in a shadow root, and an event that cannot
 * leave it is one the tree's OWN menu opens for and the surrounding component
 * never hears about.
 */
export const menuAt = async (
  target: Element,
  x: number,
  y: number,
): Promise<void> => {
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      composed: true,
      clientX: x,
      clientY: y,
    }),
  );
  // Long enough for the menu's opening animation to finish. A capture taken
  // during it records the frame it caught, which is a menu at nearly zero
  // opacity -- and a screenshot of nothing looks exactly like a bug.
  await new Promise((wake) => setTimeout(wake, 200));
};

/** A right click on a row, near its top left corner. */
export const menuOn = async (row: HTMLElement): Promise<void> => {
  const { top, left } = row.getBoundingClientRect();
  await menuAt(row, left + 4, top + 4);
};

/** The context menu open within `within`, wherever on the page it ended up. */
export const openMenu = (within: ParentNode): HTMLElement | null =>
  within.querySelector('[data-file-tree-context-menu-root="true"]');

/**
 * An action in the menu a test opened, by what it reads.
 *
 * SCOPED TO THE TEST'S OWN SUBTREE, and that is not a nicety: every test on
 * the page keeps its panel, so a lookup across the document finds the menu of
 * whichever test ran first, and then acts on a workspace that is not this one.
 */
export const action = (
  within: ParentNode,
  label: string,
): HTMLButtonElement => {
  const button = [...within.querySelectorAll('[data-file-tree-context-menu-root="true"]')]
    .flatMap((menu) => [...menu.querySelectorAll("button")])
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`no "${label}" in the menu`);
  return button;
};

/**
 * A right click on the tree that lands on no entry -- below the handful of
 * rows a test workspace has, which is the rest of the region.
 *
 * Dispatched on the tree's own element rather than on whatever
 * `elementFromPoint` reports: a report card clips the tree it is showing, so
 * the topmost element at these coordinates can belong to another test
 * entirely, and the menu then opens over the wrong workspace.
 */
export const menuOnEmptySpace = async (surface: HTMLElement): Promise<void> => {
  const box = surface.getBoundingClientRect();
  const target = surface.querySelector("file-tree-container") ?? surface;
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      composed: true,
      clientX: box.left + 24,
      clientY: box.top + Math.min(box.height - 8, 160),
    }),
  );
  // Long enough for the menu's opening animation to finish. A capture taken
  // during it records the frame it caught, which is a menu at nearly zero
  // opacity -- and a screenshot of nothing looks exactly like a bug.
  await new Promise((wake) => setTimeout(wake, 200));
};

/**
 * Everything the page logged as an error or an uncaught failure, from now on.
 *
 * A test that only asserts on the DOM passes happily while the console fills
 * with `No such entry` -- which is exactly how a broken creation flow reached
 * a human. Assert on this and the noise becomes a failure.
 */
const NOT_OURS = [
  // The editor's language client narrating its own conversation with pyright.
  /^Received message which is neither/,
  /^File or directory/,
];

export const quiet = (): {
  complaints: () => string[];
  ours: () => string[];
  stop: () => void;
} => {
  const complaints: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
    original(...args);
  };
  const onError = (event: ErrorEvent) => complaints.push(String(event.message));
  const onRejection = (event: PromiseRejectionEvent) =>
    complaints.push(String(event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return {
    complaints: () => [...complaints],
    /**
     * The same, less what a vendored editor says to itself. Anything NEW is
     * still a failure -- the list is what has been looked at and dismissed,
     * not a licence to be noisy.
     */
    ours: () => complaints.filter((line) => !NOT_OURS.some((noise) => noise.test(line))),
    stop: () => {
      console.error = original;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
};

/** The rename input the tree draws over the row being named, wherever it is. */
export const renaming = (within: HTMLElement): HTMLInputElement | undefined =>
  everythingIn(within).find(
    (element) => element.hasAttribute("data-item-rename-input"),
  ) as HTMLInputElement | undefined;

/**
 * The path of the row the tree is focused on, if any.
 *
 * Focus is one of the things a whole-tree reset throws away, so it stands in
 * for "the tree kept what it knew" -- alongside selection, expansion, and a
 * half-typed rename.
 */
export const focused = (within: HTMLElement): string | undefined =>
  everythingIn(within)
    .find((element) => element.hasAttribute("data-item-focused"))
    ?.closest("[data-item-path]")
    ?.getAttribute("data-item-path") ??
  everythingIn(within)
    .find(
      (element) =>
        element.hasAttribute("data-item-focused") && element.hasAttribute("data-item-path"),
    )
    ?.getAttribute("data-item-path") ??
  undefined;

/** The path of the row the tree is showing as selected, if any. */
export const selected = (within: HTMLElement): string | undefined =>
  everythingIn(within)
    .find(
      (element) =>
        element.getAttribute("data-item-selected") === "true" &&
        element.hasAttribute("data-item-path"),
    )
    ?.getAttribute("data-item-path") ?? undefined;

/**
 * Closes an open panel by its tab's close control.
 *
 * Dispatched rather than driven through `userEvent`: the control cancels
 * `pointerdown` to stop the tab being dragged, and user-event's pointer
 * bookkeeping does not survive that.
 */
export const closeTab = (tab: HTMLElement): void => {
  const shut = tab.querySelector(".dv-default-tab-action");
  shut?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
