/**
 * What the browser tests need in order to watch a file leave, or arrive.
 *
 * Both halves are here rather than in the app, and both are deliberately
 * naive: the client writes its own zips and drives its own picker, so a test
 * that reached for a library to read one back would be checking the two
 * against a third thing rather than against each other.
 */

/** A copy the page offered to save: what it was called, and what was in it. */
export type Saved = { name: string; blob: Blob };

/**
 * Catches downloads instead of letting the browser take them.
 *
 * Both halves are stubbed on purpose. `createObjectURL` is where the bytes
 * are, and the anchor's `click` is what would otherwise hand a headless
 * browser a download it has nowhere to put -- and would leave the assertion
 * with a URL rather than with the file it names.
 */
export const saving = (): { saved: () => Saved[]; stop: () => void } => {
  const saved: Saved[] = [];
  const madeUrl = URL.createObjectURL;
  const clicked = HTMLAnchorElement.prototype.click;
  /** The blob the URL just handed out, for the click that is about to use it. */
  const held = new Map<string, Blob>();
  let issued = 0;

  URL.createObjectURL = ((source: Blob | MediaSource) => {
    if (!(source instanceof Blob)) return madeUrl.call(URL, source);
    const url = `blob:captured-${(issued += 1)}`;
    held.set(url, source);
    return url;
  }) as typeof URL.createObjectURL;

  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = held.get(this.getAttribute("href") ?? "");
    if (blob === undefined) return clicked.call(this);
    saved.push({ name: this.download, blob });
  };

  return {
    saved: () => [...saved],
    stop: () => {
      URL.createObjectURL = madeUrl;
      HTMLAnchorElement.prototype.click = clicked;
    },
  };
};

/** One member of an archive, as a test wants to talk about it. */
export type Member = { name: string; text: string; directory: boolean };

const inflated = async (packed: Uint8Array, method: number): Promise<string> =>
  method === 0
    ? new TextDecoder().decode(packed)
    : await new Response(
        new Blob([packed as BufferSource])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).text();

/**
 * A zip, read back through its local headers.
 *
 * Enough of the format to say what a download contains and nothing more:
 * every member in the order it was written, each carrying its own name,
 * method and size. Deliberately not the central directory -- reading the part
 * an unzipper reads FIRST would let a broken index pass unnoticed, and
 * reading the part it reads SECOND catches a member written wrong.
 */
export const unzipped = async (blob: Blob): Promise<Member[]> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const field = new DataView(bytes.buffer);
  const names = new TextDecoder();
  const members: Member[] = [];

  let at = 0;
  while (at + 30 <= bytes.byteLength && field.getUint32(at, true) === 0x04034b50) {
    const method = field.getUint16(at + 8, true);
    const packedSize = field.getUint32(at + 18, true);
    const nameLength = field.getUint16(at + 26, true);
    const extraLength = field.getUint16(at + 28, true);
    const name = names.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const from = at + 30 + nameLength + extraLength;
    const packed = bytes.subarray(from, from + packedSize);
    members.push({
      name,
      directory: name.endsWith("/"),
      text: name.endsWith("/") ? "" : await inflated(packed, method),
    });
    at = from + packedSize;
  }
  return members;
};

/**
 * A file as a picker would have handed it over.
 *
 * `webkitRelativePath` is read-only and only a directory picker fills it in,
 * so a test that wants to upload a FOLDER has to say so here -- which is the
 * one thing about an upload that cannot be arranged any other way.
 */
export const asPicked = (
  name: string,
  content: string | Uint8Array,
  within?: string,
): File => {
  const file = new File([content as BlobPart], name);
  if (within !== undefined)
    Object.defineProperty(file, "webkitRelativePath", {
      value: `${within}/${name}`,
    });
  return file;
};

/**
 * Chooses these, as a person choosing them in the picker would.
 *
 * The input is off screen and takes no pointer, which is right for the page
 * and wrong for `userEvent.upload` -- and a real click on it would open a
 * dialog nothing here can answer. So the choice is made directly, and it is
 * the `change` that follows which the component is actually listening for.
 */
export const choose = (input: HTMLInputElement, files: readonly File[]): void => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

/**
 * Answers the picker without opening one, and counts the times it was asked.
 *
 * An own property, so restoring is deleting it and the prototype's own
 * `click` is untouched for every other input on the page.
 */
export const picker = (
  input: HTMLInputElement,
): { asked: () => number; stop: () => void } => {
  let asked = 0;
  Object.defineProperty(input, "click", {
    configurable: true,
    value: () => {
      asked += 1;
    },
  });
  return {
    asked: () => asked,
    stop: () => {
      delete (input as unknown as { click?: unknown }).click;
    },
  };
};
