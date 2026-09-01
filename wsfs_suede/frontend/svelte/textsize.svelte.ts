/**
 * How big the text in one panel is.
 *
 * A workspace is as often SHOWN as worked in -- somebody teaching from a
 * laptop, with a room reading the projection of it -- and the size that is
 * comfortable at arm's length is unreadable at the back of a lecture hall.
 * Nothing in the chrome could be made bigger without making everything
 * bigger, which is the browser's own zoom, and that takes the layout with it:
 * three panels that no longer fit beside each other is not a bigger
 * workspace, it is a broken one.
 *
 * PER PANEL, because what has to grow is whichever one is being talked
 * about. An instructor walking through a file wants the file large and can
 * spare the tree; one talking about what the assistant said wants the
 * opposite. Making all three grow together would cost width nobody has.
 *
 * What the number means: a multiple of the size that panel is drawn at
 * ordinarily. `1` is that size, and it is where every panel starts.
 *
 * REMEMBERED, per panel and per browser. Somebody who sets this has just
 * plugged into a projector; they will be on the same machine and the same
 * screen for the next hour, and asking them to set it again for every file
 * they open -- or every time the page reloads -- is asking them to do it in
 * front of an audience.
 */

/** The smallest a panel goes: still legible, and a real saving in width. */
export const SMALLEST = 0.8;

/**
 * The largest. Two and a half times is a 13px tree at 32px, which is about
 * what a room of forty reads comfortably; past it a sidebar holds one word.
 */
export const LARGEST = 2.5;

/** Fine enough to find a comfortable size, coarse enough to land on one. */
export const STEP = 0.05;

/** What every panel is drawn at until somebody says otherwise. */
export const USUAL = 1;

/**
 * How this reaches the text.
 *
 * A panel carries `data-text-scale` and sets `--wsfs-text-scale` to the number
 * below; everything inside it is drawn against that. A custom property rather
 * than a prop threaded through each component, because most of what has to
 * scale is drawn by something that has never heard of this -- a markdown
 * renderer, a shadcn button, a notice. Inheritance reaches all of them; a prop
 * reaches the component it was handed to. See `app.css`.
 *
 * Two things cannot be reached that way and are told instead: monaco, which
 * measures its own lines and takes a number (`px` below), and the tree, which
 * is virtualised and is scaled rather than restyled (see `FileTree.svelte`).
 */

const KEY = "wsfs:text-size:";

const clamp = (scale: number) =>
  Math.min(LARGEST, Math.max(SMALLEST, scale));

/**
 * Nothing at all when there is no storage to read, which is both a page being
 * rendered on a server and a browser that has been told to keep nothing.
 * Neither is a reason to fail to draw a panel.
 */
const stored = (panel: string): number | undefined => {
  try {
    const held = globalThis.localStorage?.getItem(`${KEY}${panel}`);
    if (held === null || held === undefined) return undefined;
    const scale = Number(held);
    return Number.isFinite(scale) ? clamp(scale) : undefined;
  } catch {
    return undefined;
  }
};

const keep = (panel: string, scale: number) => {
  try {
    globalThis.localStorage?.setItem(`${KEY}${panel}`, String(scale));
  } catch {
    /** A browser refusing to store this is not a reason to refuse to show it. */
  }
};

export class TextSize {
  /** Which panel this is the size of -- and what it is remembered under. */
  readonly panel: string;

  readonly #remember: boolean;
  #scale = $state(USUAL);

  constructor(panel: string, { remember = true }: { remember?: boolean } = {}) {
    this.panel = panel;
    this.#remember = remember;
    if (remember) this.#scale = stored(panel) ?? USUAL;
  }

  get scale(): number {
    return this.#scale;
  }

  /**
   * Clamped rather than refused: a slider cannot ask for anything outside its
   * own range, but a remembered value from an older range can, and a panel
   * drawn at eight times its size has no way back to one that is not.
   */
  set scale(to: number) {
    const held = clamp(Number.isFinite(to) ? to : USUAL);
    if (held === this.#scale) return;
    this.#scale = held;
    if (this.#remember) keep(this.panel, held);
  }

  /** How this reads to a person: `1.5` is 150%. */
  get percent(): number {
    return Math.round(this.#scale * 100);
  }

  /** Whether anybody has moved this, which is when it is worth saying so. */
  get changed(): boolean {
    return this.#scale !== USUAL;
  }

  /**
   * A pixel size that grows with this panel.
   *
   * For anything that is TOLD its font size rather than styled into it --
   * monaco, which owns its own layout and has to be handed a number.
   */
  px(base: number): number {
    return Math.round(base * this.#scale);
  }

  reset(): void {
    this.scale = USUAL;
  }
}

/**
 * The three panels a workspace draws, each with a size of its own.
 *
 * ONE PER PANEL RATHER THAN PER FILE for the documents: a person who has set
 * a comfortable size and then opens the next file wants that file at the size
 * they set, not back at the default with the slider to find again. Every open
 * file answers to the same one, so the sliders in each tab agree.
 */
export class TextSizes {
  readonly explorer: TextSize;
  readonly documents: TextSize;
  readonly assistant: TextSize;

  constructor(options?: { remember?: boolean }) {
    this.explorer = new TextSize("explorer", options);
    this.documents = new TextSize("documents", options);
    this.assistant = new TextSize("assistant", options);
  }
}
