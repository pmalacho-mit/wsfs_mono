import { contents, type Contents } from "./contents";
import type { Entry, SyncFileSystem } from "./worker/emscripten-fs";
import { awaited, type Awaitable, type SyncResult } from "./utils";

export namespace FileSystem {
  export type SanitizeOptions = {
    /**
     * Location to mount the shared file system at.
     * @default "/home/pyodide"
     */
    root: string;
    /**
     * Remove the configured root prefix from incoming paths.
     * @default true
     */
    removeRoot: boolean;
    /**
     * Strip a leading slash from incoming paths.
     * @default true
     */
    removeLeadingSlash: boolean;
  };

  export type CreationOptions = Partial<SanitizeOptions> & {
    /** Log filesystem calls for debugging. */
    log?: boolean;
    /**
     * Hand everything Python writes to `put` as raw bytes.
     *
     * By default contents that are valid UTF-8 arrive as a string and
     * everything else arrives as a `Uint8Array`.
     */
    binary?: boolean;
  };

  export type Get = (
    path: string,
  ) => Awaitable<Contents | undefined | null | { directory: true }>;

  export type Put = (path: string, value: Contents | null) => Awaitable<void>;

  export type ListDirectory = (
    path: string,
  ) => Awaitable<string[] | undefined | null>;

  export type Stat = (path: string) => Awaitable<Entry | undefined | null>;

  export type Move = (request: {
    /** Source path to move from. */
    from: string;
    /** Destination path to move to. */
    to: string;
  }) => Awaitable<void>;

  export type Delete = (path: string) => Awaitable<void>;

  export type Read = {
    /** Read file contents or directory marker for a path. */
    get: Get;
    /** List entries for a directory path. */
    listDirectory: ListDirectory;
    /**
     * Describe a path without producing its contents.
     *
     * Only worth providing when size is cheaper to answer than contents:
     * without it, sizes are measured by reading the file.
     */
    stat?: Stat;
  };

  export type Write = {
    /** Create or update file contents at a path. */
    put: Put;
    /** Move a path from source to destination. */
    move?: Move;
    /** Delete a path from the filesystem. */
    delete?: Delete;
  };

  export type CreateReadWrite = FileSystem.Read &
    FileSystem.Write &
    FileSystem.CreationOptions;
}

/**
 * The filesystem the kernel is given. It answers the same questions the worker
 * asks, except that every answer may arrive in a promise: Python stays blocked
 * until it does.
 */
export type HostFileSystem = {
  [K in keyof SyncFileSystem]: (
    ...args: Parameters<SyncFileSystem[K]>
  ) => Awaitable<ReturnType<SyncFileSystem[K]>>;
};

type RootedFileSystem = HostFileSystem & { root: string };

export const defaultRoot = "/home/pyodide";

const ok = <T>(data: T): SyncResult<T> => ({ ok: true, data });

const notFound = (path: string): SyncResult<never> => ({
  ok: false,
  status: 404,
  error: new Error(`Not found: ${path}`),
});

/**
 * In-memory filesystem adapter that returns not-found for reads and no-ops
 * for writes.
 */
export const empty = (root = defaultRoot, log = false): RootedFileSystem => {
  const trace = (name: string, opts: unknown) => {
    if (log) console.log(`fs.${name} invoked with:`, opts);
  };
  return {
    root,
    get: (opts) => (trace("get", opts), notFound(opts.path)),
    stat: (opts) => (trace("stat", opts), notFound(opts.path)),
    put: (opts) => (trace("put", opts), ok(undefined)),
    delete: (opts) => (trace("delete", opts), ok(undefined)),
    move: (opts) => (trace("move", opts), ok(undefined)),
    listDirectory: (opts) => (trace("listDirectory", opts), ok([])),
  };
};

/** Normalize file paths according to sanitize options. */
export const sanitizePath = (
  path: string,
  { removeRoot, removeLeadingSlash, root }: FileSystem.SanitizeOptions,
) => {
  if (removeRoot && path.startsWith(root)) path = path.replace(root, "");
  if (removeLeadingSlash && path.startsWith("/")) path = path.slice(1);
  return path === "" ? (removeLeadingSlash ? path : "/") : path;
};

/** Apply default values for filesystem sanitize options. */
export const setDefaults: (
  options: Partial<FileSystem.SanitizeOptions>,
) => asserts options is FileSystem.SanitizeOptions = (options) => {
  options.root ??= defaultRoot;
  options.removeRoot ??= true;
  options.removeLeadingSlash ??= true;
};

const isDirectoryMarker = (value: unknown): value is { directory: true } =>
  typeof value === "object" && value !== null && "directory" in value;

const isContents = (value: unknown): value is Contents =>
  typeof value === "string" || value instanceof Uint8Array;

/** Reads only count as answered when they produced contents or a directory. */
const answered = (
  value: Awaited<ReturnType<FileSystem.Get>>,
): SyncResult<Contents | null> | undefined => {
  if (isContents(value)) return ok(value);
  if (isDirectoryMarker(value)) return ok(null);
  return undefined;
};

const entryOf = (value: Contents | null): Entry =>
  value === null
    ? { size: 0, directory: true }
    : { size: contents.byteLength(value), directory: false };

const measuredByReading =
  (get: HostFileSystem["get"]): HostFileSystem["stat"] =>
  (opts) =>
    awaited.map(get(opts), (result) =>
      result.ok ? ok(entryOf(result.data)) : result,
    );

const sanitizer =
  (options: FileSystem.SanitizeOptions) => (opts: { path: string }) =>
    sanitizePath(opts.path, options);

/**
 * Create a read-only filesystem facade layered on top of an optional base
 * filesystem implementation.
 */
export const readOnly = (
  options: FileSystem.Read & FileSystem.CreationOptions,
  base?: RootedFileSystem,
): RootedFileSystem => {
  setDefaults(options);
  const { get, listDirectory, stat } = options;
  const fallback = base ?? empty(options.root, options.log);
  const at = sanitizer(options);

  const reader: RootedFileSystem = {
    ...fallback,
    get: (opts) =>
      awaited.map(
        get(at(opts)),
        (value) => answered(value) ?? fallback.get(opts),
      ),
    listDirectory: (opts) =>
      awaited.map(listDirectory(at(opts)), (names) =>
        Array.isArray(names) ? ok(names) : fallback.listDirectory(opts),
      ),
  };

  const measured = measuredByReading(reader.get);
  return {
    ...reader,
    stat: stat
      ? (opts) =>
          awaited.map(stat(at(opts)), (entry) =>
            entry ? ok(entry) : measured(opts),
          )
      : measured,
  };
};

/**
 * Create a write-only filesystem facade layered on top of an optional base
 * filesystem implementation.
 */
export const writeOnly = (
  options: FileSystem.Write & FileSystem.CreationOptions,
  base?: RootedFileSystem,
): RootedFileSystem => {
  setDefaults(options);
  const { put, move, delete: remove, binary = false } = options;
  const fallback = base ?? empty(options.root, options.log);
  const at = sanitizer(options);
  const done = (value: Awaitable<void>) =>
    awaited.map(value, () => ok(undefined));

  /** Text written by Python stays text unless raw bytes were asked for. */
  const written = (value: Contents | null) =>
    value === null || binary || contents.isText(value)
      ? value
      : contents.fromBytes(value);

  return {
    ...fallback,
    move: move
      ? (opts) =>
          done(
            move({ from: at(opts), to: sanitizePath(opts.newPath, options) }),
          )
      : fallback.move,
    delete: remove ? (opts) => done(remove(at(opts))) : fallback.delete,
    put: (opts) => done(put(at(opts), written(opts.value))),
  };
};

/** Create a read-write filesystem facade by composing read-only and write-only adapters. */
export const readWrite = (
  options: FileSystem.CreateReadWrite,
  base?: RootedFileSystem,
): RootedFileSystem => {
  setDefaults(options);
  return readOnly(options, writeOnly(options, base));
};

const MIME_TYPES: [suffix: string, type: string][] = [
  [".gif", "image/gif"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".txt", "text/plain"],
  [".html", "text/html"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".zip", "application/zip"],
];

export const inferMimeType = (path: string) => {
  const lowerPath = path.toLowerCase();
  const match = MIME_TYPES.find(([suffix]) => lowerPath.endsWith(suffix));
  return match?.[1] ?? "application/octet-stream";
};

export default {
  defaultRoot,
  empty,
  readOnly,
  writeOnly,
  readWrite,
  inferMimeType,
};
