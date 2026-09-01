/// <reference types="emscripten" />

// see
// https://github.com/jvilk/BrowserFS/blob/master/src/generic/emscripten_fs.ts
// https://github.com/emscripten-core/emscripten/blob/main/src/library_nodefs.js
// https://github.com/emscripten-core/emscripten/blob/main/src/library_memfs.js
// https://github.com/emscripten-core/emscripten/blob/main/src/library_workerfs.js
// https://github.com/curiousdannii/emglken/blob/master/src/emglkenfs.js

import type { PyodideAPI } from "pyodide";
import type { SyncResult } from "../utils";
import { contents, resizeBytes, type Contents } from "../contents";

/** What is known about a path without reading its contents. */
export type Entry = {
  size: number;
  directory: boolean;
};

/**
 * What Python's filesystem calls turn into.
 *
 * An open file is held whole in the worker and written back with a single
 * `put` when it is closed, so `get` and `put` are called once per open file
 * rather than once per read or write. Python's `flush()` does not reach the
 * host, and a run that is terminated mid-write never gets to `put` at all.
 */
export interface SyncFileSystem {
  /**
   * Get a file or directory at a given path.
   * @returns The contents of the file. `null` corresponds to a directory
   */
  get(opts: { path: string }): SyncResult<Contents | null>;

  /**
   * Describe a file or directory without transferring its contents.
   */
  stat(opts: { path: string }): SyncResult<Entry>;

  /**
   * Creates or replaces a file or directory at a given path.
   * @param opts.value The contents of the file. `null` corresponds to a directory
   */
  put(opts: { path: string; value: Contents | null }): SyncResult<undefined>;

  /**
   * Deletes a file or directory at a given path
   */
  delete(opts: { path: string }): SyncResult<undefined>;

  /**
   * Move a file or directory to a new path. Can be used for renaming
   */
  move(opts: { path: string; newPath: string }): SyncResult<undefined>;

  /**
   * List the files in a directory
   */
  listDirectory(opts: { path: string }): SyncResult<string[]>;
}

export const fileSystemMethods = [
  "get",
  "stat",
  "put",
  "delete",
  "move",
  "listDirectory",
] as const satisfies readonly (keyof SyncFileSystem)[];

const failed = (thrown: unknown): SyncResult<never> => ({
  ok: false,
  status: 500,
  error: thrown instanceof Error ? thrown : new Error(String(thrown)),
});

/**
 * A filesystem whose calls may throw becomes one that always answers, so a
 * broken host reaches Python as a failed operation rather than as a crash.
 */
export const answering = (fs: SyncFileSystem): SyncFileSystem =>
  Object.fromEntries(
    fileSystemMethods.map((method) => [
      method,
      (opts: any) => {
        try {
          return (fs[method] as any)(opts);
        } catch (thrown) {
          return failed(thrown);
        }
      },
    ]),
  ) as unknown as SyncFileSystem;

const convertSyncResult = <T, E>(
  FS: PyodideAPI["FS"],
  ERRNO_CODES: PyodideAPI["ERRNO_CODES"],
  result: SyncResult<T, E>,
): T => {
  if (result.ok) return result.data;
  else {
    const error =
      result.status === 404
        ? new FS.ErrnoError(ERRNO_CODES["ENOENT"])
        : result.status === 400
          ? new FS.ErrnoError(ERRNO_CODES["EINVAL"])
          : new FS.ErrnoError(ERRNO_CODES["EPERM"]);

    error.cause = result.error;

    throw error;
  }
};

type Opts = {
  root?: string;
};

const realPath = (node: FS.FSNode, fileName?: string) => {
  const parts = [];
  while (node.parent !== node) {
    parts.push(node.name);
    node = node.parent;
  }
  parts.push((node.mount.opts as Opts).root);
  parts.reverse();
  if (fileName !== undefined && fileName !== null) {
    parts.push(fileName);
  }
  return parts.join("/");
};

type AdvancedEmscriptenFS = {
  createNode(
    parent: FS.FSNode | null,
    name: string,
    mode: number,
    dev?: number,
  ): FS.FSNode;
};

const DIR_MODE = 16895; // 040777
const FILE_MODE = 33206; // 100666
const SEEK_CUR = 1;
const SEEK_END = 2;
const O_TRUNC = 512;

const methods = (
  {
    FS,
    ERRNO_CODES,
  }: Pick<PyodideAPI, "FS" | "ERRNO_CODES"> & { FS: AdvancedEmscriptenFS },
  custom: SyncFileSystem,
  log: boolean = false,
) => {
  let createNode: AdvancedEmscriptenFS["createNode"];

  const dev = 1; // dummy device number
  const rdev = 1; // dummy device number

  const syncResult = convertSyncResult.bind(null, FS, ERRNO_CODES) as <T, E>(
    result: SyncResult<T, E>,
  ) => T;

  const logCall = (name: string, ...args: any[]) => {
    if (log) console.log(`[emscripten-fs] ${name}`, args);
  };

  const readBytes = (path: string) => {
    const value = syncResult(custom.get({ path }));
    return value === null ? new Uint8Array() : contents.toBytes(value);
  };

  const writeBytes = (path: string, bytes: Uint8Array) =>
    syncResult(custom.put({ path, value: bytes }));

  type CustomNode = FS.FSNode & {
    timestamp?: number;
    /** Set while a stream holds contents the host has not been told about. */
    pendingSize?: number;
  };

  const isCustomNode = (node: FS.FSNode): node is CustomNode =>
    (node as CustomNode).timestamp !== undefined;

  const modeOf = (entry: Entry) => (entry.directory ? DIR_MODE : FILE_MODE);

  /**
   * An open file is only written back when it is closed, so what a stream holds
   * is more current than what the host would report.
   */
  const sizeOf = (node: FS.FSNode) =>
    (node as CustomNode).pendingSize ??
    syncResult(custom.stat({ path: realPath(node) })).size;

  const truncate = (node: FS.FSNode, size: number) => {
    if (!FS.isFile(node.mode)) throw new FS.ErrnoError(ERRNO_CODES["EINVAL"]);
    const path = realPath(node);
    writeBytes(path, resizeBytes(readBytes(path), size));
    (node as CustomNode).pendingSize = undefined;
  };

  const nodeOps: FS.NodeOps = {
    getattr: (node) => {
      logCall("nodeOps.getattr", { node: node.name, id: node.id });
      const { id: ino, mode, rdev } = node;
      const size = FS.isFile(mode) ? sizeOf(node) : 0;
      const time = new Date(isCustomNode(node) ? node.timestamp! : Date.now());
      return {
        dev,
        rdev,
        ino,
        mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        size,
        atime: time,
        mtime: time,
        ctime: time,
        blksize: 4096,
        blocks: 0,
      };
    },

    setattr: (node, attr) => {
      logCall("nodeOps.setattr", { node: node.name, attr });
      if (!attr) return;
      if (attr.mode !== undefined) node.mode = attr.mode;
      if (attr.size !== undefined) truncate(node, attr.size);
      if (attr.timestamp !== undefined)
        (node as CustomNode).timestamp = attr.timestamp;
    },

    lookup: (parent, name) => {
      logCall("nodeOps.lookup", { parent: parent.name, name });
      const path = realPath(parent, name);
      const result = custom.stat({ path });
      if (!result.ok) throw new FS.ErrnoError(ERRNO_CODES["ENOENT"]);
      return createNode!(parent, name, modeOf(result.data), rdev);
    },

    mknod: (parent, name, mode, dev) => {
      logCall("nodeOps.mknod", { parent: parent.name, name, mode, dev });
      const node = createNode!(parent, name, mode, dev as number);
      const path = realPath(node);
      syncResult(
        custom.put({
          path,
          value: FS.isDir(node.mode) ? null : new Uint8Array(),
        }),
      );
      return node;
    },

    rename: (oldNode, newDir, newName) => {
      logCall("nodeOps.rename", {
        oldNode: oldNode.name,
        newDir: newDir.name,
        newName,
      });
      const path = realPath(oldNode);
      const newPath = realPath(newDir, newName);
      syncResult(custom.move({ path, newPath }));
      oldNode.name = newName;
    },

    unlink: (parent, name) => {
      logCall("nodeOps.unlink", { parent: parent.name, name });
      const path = realPath(parent, name);
      syncResult(custom.delete({ path }));
    },

    rmdir: (parent, name) => {
      logCall("nodeOps.rmdir", { parent: parent.name, name });
      const path = realPath(parent, name);
      syncResult(custom.delete({ path }));
    },

    readdir: (node) => {
      logCall("nodeOps.readdir", { node: node.name });
      const path = realPath(node);
      let result = syncResult(custom.listDirectory({ path }));
      if (!result.includes(".")) result.push(".");
      if (!result.includes("..")) result.push("..");
      return result;
    },

    symlink: (parent, newName, oldPath) => {
      logCall("nodeOps.symlink", { parent: parent.name, newName, oldPath });
      throw new FS.ErrnoError(ERRNO_CODES["EPERM"]);
    },

    readlink: (node) => {
      logCall("nodeOps.readlink", { node: node.name });
      throw new FS.ErrnoError(ERRNO_CODES["EPERM"]);
    },
  };

  /**
   * Open files hold their whole contents as bytes: reads and writes never touch
   * the host, only `open` and `close` do.
   */
  type CustomStream = FS.FSStream & {
    fileData?: Uint8Array;
    dirty?: boolean;
  };

  const bytesOf = (stream: FS.FSStream) => {
    const { fileData } = stream as CustomStream;
    if (fileData === undefined) throw new FS.ErrnoError(ERRNO_CODES["EPERM"]);
    return fileData;
  };

  const isTruncating = (stream: FS.FSStream) =>
    (stream.flags & O_TRUNC) === O_TRUNC;

  const grow = (stream: CustomStream, size: number) => {
    if (size > bytesOf(stream).length)
      stream.fileData = resizeBytes(stream.fileData!, size);
    return stream.fileData!;
  };

  const streamOps: FS.StreamOps = {
    open: (stream) => {
      const path = realPath(stream.object);
      logCall("streamOps.open", { path, flags: stream.flags });
      if (!FS.isFile(stream.object.mode)) return;
      const truncating = isTruncating(stream);
      Object.assign(stream as CustomStream, {
        fileData: truncating ? new Uint8Array() : readBytes(path),
        dirty: truncating,
      });
      if (truncating) (stream.object as CustomNode).pendingSize = 0;
    },

    close: (stream) => {
      const path = realPath(stream.object);
      logCall("streamOps.close", { path });
      const { fileData, dirty } = stream as CustomStream;
      Object.assign(stream as CustomStream, {
        fileData: undefined,
        dirty: false,
      });
      (stream.object as CustomNode).pendingSize = undefined;
      if (dirty && fileData !== undefined) writeBytes(path, fileData);
    },

    read: (stream, buffer, offset, length, position) => {
      logCall("streamOps.read", { offset, length, position });
      if (length <= 0) return 0;
      const fileData = bytesOf(stream);
      const size = Math.min(fileData.length - position, length);
      if (size <= 0) return 0;
      buffer.set(fileData.subarray(position, position + size), offset);
      return size;
    },

    write: (stream, buffer, offset, length, position) => {
      logCall("streamOps.write", { offset, length, position });
      if (length <= 0) return 0;
      const fileData = grow(stream as CustomStream, position + length);
      fileData.set(buffer.subarray(offset, offset + length), position);
      Object.assign(stream.object as CustomNode, {
        timestamp: Date.now(),
        pendingSize: fileData.length,
      });
      (stream as CustomStream).dirty = true;
      return length;
    },

    llseek: (stream, offset, whence) => {
      logCall("streamOps.llseek", { offset, whence });
      const position = offset + seekOrigin(stream, whence);
      if (position < 0) throw new FS.ErrnoError(ERRNO_CODES["EINVAL"]);
      return position;
    },
  };

  const seekOrigin = (stream: FS.FSStream, whence: number) => {
    if (whence === SEEK_CUR) return stream.position;
    if (whence === SEEK_END && FS.isFile(stream.object.mode))
      return bytesOf(stream).length;
    return 0;
  };

  type CreatedNode = FS.FSNode & {
    node_ops: FS.NodeOps;
    stream_ops: FS.StreamOps;
  };

  createNode = (
    parent: FS.FSNode | null,
    name: string,
    mode: number,
    dev?: any,
  ) => {
    if (!FS.isDir(mode) && !FS.isFile(mode)) {
      console.error("createNode: Invalid mode", mode);
      throw new FS.ErrnoError(ERRNO_CODES["EINVAL"]);
    }
    const node = FS.createNode(parent, name, mode, dev) as CreatedNode;
    node.node_ops = nodeOps;
    node.stream_ops = streamOps;
    return node;
  };

  return {
    nodeOps,
    streamOps,
    createNode,
  };
};

export class EMFS implements Emscripten.FileSystemType {
  readonly methods: ReturnType<typeof methods>;
  readonly FS: PyodideAPI["FS"];

  constructor(
    pyodide: PyodideAPI,
    custom: SyncFileSystem,
    log: boolean = false,
  ) {
    this.FS = pyodide.FS;
    this.methods = methods(
      pyodide as PyodideAPI & { FS: AdvancedEmscriptenFS },
      custom,
      log,
    );
  }

  mount(_: FS.Mount) {
    return this.methods.createNode(null, "/", DIR_MODE);
  }

  syncfs(
    mount: FS.Mount,
    populate: () => unknown,
    done: (err?: number | null) => unknown,
  ): void {
    console.warn("EMFS syncfs called, but not implemented.");
    return;
  }
}
