/**
 * The workspace's edge with the machine it is being read on.
 *
 * Everything here is about crossing that edge: what a file or a folder
 * becomes when somebody asks to keep a copy of it, and what a copy chosen
 * from a disk becomes on the way back in.
 *
 * NOTHING HERE MUTATES A WORKSPACE, and that is deliberate. `chosen` hands
 * back paths and bytes and stops; putting them somewhere is the tree's
 * business, because the tree already owns the one creation path -- draft,
 * name, create -- that keeps the mapping, the announcements and the outbox in
 * step. An upload that wrote entries itself would be a second such path, and
 * the second one is always the one that forgets something.
 */
import type { Path, Workspace } from "../";
import { holderOf, nameOf } from "./paths";

const encoder = new TextEncoder();

/** What the browser saves the whole workspace as, since it has no name. */
const WORKSPACE = "workspace";

/* -------------------------------------------------------------------------
 * Zip
 * ---------------------------------------------------------------------- */

/**
 * One member of an archive. No `bytes` means a directory, which is worth
 * writing down: an empty folder has no files to imply it, and a person who
 * made one meant to have it.
 */
export type Archived = { name: string; bytes?: Uint8Array };

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    let value = byte;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[byte] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Deflated, or nothing at all.
 *
 * Nothing when the browser has no `CompressionStream`, and nothing when the
 * result is no smaller than what went in -- which is the ordinary case for a
 * short file, where the deflate header costs more than it saves. Either way
 * the member is stored as it stands, which every unzipper reads.
 */
const deflated = async (bytes: Uint8Array): Promise<Uint8Array | undefined> => {
  if (typeof CompressionStream === "undefined") return undefined;
  const packed = new Uint8Array(
    await new Response(
      new Blob([bytes as BufferSource])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw")),
    ).arrayBuffer(),
  );
  return packed.byteLength < bytes.byteLength ? packed : undefined;
};

/** The clock as a zip records it: two packed 16-bit fields, since 1980. */
const stamped = (at: Date) => ({
  time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  date:
    ((Math.max(at.getFullYear(), 1980) - 1980) << 9) |
    ((at.getMonth() + 1) << 5) |
    at.getDate(),
});

type Member = {
  name: Uint8Array;
  directory: boolean;
  method: number;
  crc: number;
  packed: Uint8Array;
  size: number;
  time: number;
  date: number;
};

const prepared = async (entry: Archived, at: Date): Promise<Member> => {
  const directory = entry.bytes === undefined;
  const bytes = entry.bytes ?? new Uint8Array();
  const compressed = directory ? undefined : await deflated(bytes);
  return {
    name: encoder.encode(
      directory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name,
    ),
    directory,
    method: compressed === undefined ? 0 : 8,
    crc: crc32(bytes),
    packed: compressed ?? bytes,
    size: bytes.byteLength,
    ...stamped(at),
  };
};

/** Bit 11 of the flags: the name below is UTF-8 rather than the 1989 default. */
const UTF8 = 0x0800;

const localHeader = (member: Member): Uint8Array => {
  const head = new Uint8Array(30 + member.name.byteLength);
  const field = new DataView(head.buffer);
  field.setUint32(0, 0x04034b50, true);
  field.setUint16(4, 20, true); // the version that can read this
  field.setUint16(6, UTF8, true);
  field.setUint16(8, member.method, true);
  field.setUint16(10, member.time, true);
  field.setUint16(12, member.date, true);
  field.setUint32(14, member.crc, true);
  field.setUint32(18, member.packed.byteLength, true);
  field.setUint32(22, member.size, true);
  field.setUint16(26, member.name.byteLength, true);
  field.setUint16(28, 0, true); // no extra field
  head.set(member.name, 30);
  return head;
};

const centralHeader = (member: Member, offset: number): Uint8Array => {
  const head = new Uint8Array(46 + member.name.byteLength);
  const field = new DataView(head.buffer);
  field.setUint32(0, 0x02014b50, true);
  field.setUint16(4, 20, true); // the version that wrote this
  field.setUint16(6, 20, true); // the version that can read it
  field.setUint16(8, UTF8, true);
  field.setUint16(10, member.method, true);
  field.setUint16(12, member.time, true);
  field.setUint16(14, member.date, true);
  field.setUint32(16, member.crc, true);
  field.setUint32(20, member.packed.byteLength, true);
  field.setUint32(24, member.size, true);
  field.setUint16(28, member.name.byteLength, true);
  // Extra, comment, disk and attribute fields are all zero, except the one
  // MS-DOS bit that says "directory" -- which is what an empty folder is.
  field.setUint32(38, member.directory ? 0x10 : 0, true);
  field.setUint32(42, offset, true);
  head.set(member.name, 46);
  return head;
};

const endOfDirectory = (
  count: number,
  size: number,
  offset: number,
): Uint8Array => {
  const tail = new Uint8Array(22);
  const field = new DataView(tail.buffer);
  field.setUint32(0, 0x06054b50, true);
  field.setUint16(8, count, true); // on this disk, of which there is one
  field.setUint16(10, count, true);
  field.setUint32(12, size, true);
  field.setUint32(16, offset, true);
  return tail;
};

/**
 * These, as one zip.
 *
 * Written by hand rather than with a library because the whole format this
 * needs is three fixed headers and a checksum -- and a dependency that ships
 * to every student for that is a dependency that has to be kept.
 *
 * No zip64: an archive of a student's workspace is megabytes, and the shape
 * that would carry more is the shape nothing here will ever produce.
 */
export const zipped = async (entries: readonly Archived[]): Promise<Blob> => {
  const at = new Date();
  const members = await Promise.all(
    entries.map((entry) => prepared(entry, at)),
  );

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const member of members) {
    central.push(centralHeader(member, offset));
    const head = localHeader(member);
    parts.push(head, member.packed);
    offset += head.byteLength + member.packed.byteLength;
  }

  const directorySize = central.reduce((all, one) => all + one.byteLength, 0);
  return new Blob(
    [...parts, ...central, endOfDirectory(members.length, directorySize, offset)]
      .map((part) => part as BufferSource),
    { type: "application/zip" },
  );
};

/* -------------------------------------------------------------------------
 * Out
 * ---------------------------------------------------------------------- */

type Readable = Pick<Workspace, "index" | "read">;

const bytesOf = (held: { kind: string; text?: string; bytes?: Uint8Array }) =>
  held.kind === "text"
    ? encoder.encode(held.text ?? "")
    : (held.bytes ?? new Uint8Array());

/**
 * How much of a path is the folder HOLDING the one being downloaded -- which
 * is what an archive's names have cut off the front of them.
 */
const heading = (folder: Path) =>
  folder.includes("/") ? holderOf(folder).length + 1 : 0;

/**
 * Everything at or under `folder`, as an archive names it.
 *
 * Named relative to what HOLDS the folder rather than to the folder itself,
 * so extracting makes one directory rather than scattering its contents over
 * wherever the person happened to be. The root is the exception, because it
 * has no holder and no name -- see `download`, which gives it one.
 */
export const gathered = async (
  workspace: Readable,
  folder: Path,
): Promise<Archived[]> => {
  const index = workspace.index();
  const within = folder === "" ? "" : `${folder}/`;
  const from = heading(folder);
  const under = index
    .paths()
    .filter((path) => path.startsWith(within))
    .sort();

  const held = await Promise.all(
    under.map(async (path): Promise<Archived> => {
      const name = path.slice(from);
      if (index.at(path)?.type === "folder") return { name };
      const payload = await workspace.read(path);
      return { name, bytes: payload ? bytesOf(payload) : new Uint8Array() };
    }),
  );

  // The folder's own entry, so downloading an empty one still arrives as a
  // folder. The root has no entry to write, and needs none.
  return folder === "" ? held : [{ name: folder.slice(from) }, ...held];
};

/**
 * Hands the browser a file to keep.
 *
 * Through an anchor rather than through `showSaveFilePicker`, because the
 * anchor is what every browser has and what a sandboxed frame is still
 * allowed to do. The URL outlives the click on purpose: revoking it in the
 * same task cancels the download it just started.
 */
export const save = (name: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/**
 * Downloads what is at `path`: the file itself, or a zip of the folder.
 *
 * `""` is the workspace, which is a folder like any other except that it has
 * no name of its own -- so the archive is called `workspace.zip` and holds
 * the entries at the top level, exactly as the tree draws them.
 */
export const download = async (
  workspace: Readable,
  asked: Path,
): Promise<{ name: string; blob: Blob }> => {
  /** A folder's path carries a trailing separator here and nowhere below. */
  const path = asked.replace(/\/$/, "");
  const entry = path === "" ? undefined : workspace.index().at(path);
  if (entry !== undefined && entry.type === "file") {
    const payload = await workspace.read(path);
    const blob = new Blob(
      [(payload ? bytesOf(payload) : new Uint8Array()) as BufferSource],
      { type: payload?.kind === "binary" ? payload.mime : "text/plain" },
    );
    const named = { name: nameOf(path), blob };
    save(named.name, named.blob);
    return named;
  }

  const named = {
    name: `${path === "" ? WORKSPACE : nameOf(path)}.zip`,
    blob: await zipped(await gathered(workspace, path)),
  };
  save(named.name, named.blob);
  return named;
};

/* -------------------------------------------------------------------------
 * In
 * ---------------------------------------------------------------------- */

/** A file chosen from a disk, as the workspace would take it. */
export type Chosen = {
  /** Where it goes, relative to wherever the upload is landing. */
  path: Path;
  content: string | Uint8Array;
  mime: string;
};

const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * Text, if these bytes are text.
 *
 * A `.py` a person uploads has to arrive as a file they can then TYPE into,
 * and the difference between a text entry and a binary one is the difference
 * between the editor and the preview pane. The browser's own `file.type` does
 * not answer this -- it is empty for most source files and wrong for some --
 * so the bytes are asked instead: valid UTF-8 with no NUL in it is text, and
 * nothing else is.
 */
const asText = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
};

const TEXT = "text/plain";

/**
 * What a file picker handed back, ready to be created.
 *
 * `webkitRelativePath` is what a directory picker fills in, and it carries
 * the folder the person chose at its head -- which is the point, because it
 * is the folder they mean to end up with.
 */
export const chosen = async (files: readonly File[]): Promise<Chosen[]> =>
  Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = asText(bytes);
      return {
        path: (file.webkitRelativePath || file.name).replace(/^\/+/, ""),
        content: text ?? bytes,
        mime: text === undefined ? file.type || "application/octet-stream" : TEXT,
      };
    }),
  );

/**
 * Every folder these files need, shallowest first.
 *
 * A create names its parent by id, so the parent has to be there before the
 * child asks for it -- and the order below is the only thing that guarantees
 * it, since the tree is told about each of these one at a time.
 */
export const foldersFor = (paths: readonly Path[]): Path[] => {
  const needed = new Set<Path>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++)
      needed.add(`${parts.slice(0, depth).join("/")}/`);
  }
  return [...needed].sort((left, right) => left.length - right.length);
};
