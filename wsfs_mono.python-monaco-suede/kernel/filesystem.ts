import { FileProvider } from "../filesystem/provider";

/**
 * The filesystem a python web kernel mounts. Paths arrive relative to the
 * mount root with no leading slash, which is the shape a {@link FileProvider}
 * already speaks.
 *
 * A directory reads back as `null` or as `{ directory: true }`, depending on
 * whether the kernel hands over its own filesystem object or the callbacks it
 * was built from; a missing path reads back as `undefined`.
 */
export type KernelFilesystem = {
  get: (path: string) => string | undefined | null | { directory: true };
  listDirectory: (path: string) => string[];
  put?: (path: string, value: string | null) => void;
  move?: (request: { from: string; to: string }) => void;
  delete?: (path: string) => void;
};

/**
 * A provider the kernel can mount. The kernel reaches the main thread from
 * inside its worker and blocks until it answers, so it cannot await — and
 * neither can this.
 */
export type SyncFileProvider = Omit<FileProvider, "paths" | "read"> & {
  paths: () => Iterable<string>;
  read: (path: string) => string;
};

const DIRECTORY = { directory: true } as const;

const SELF_AND_PARENT = new Set([".", ".."]);

const isDirectory = (value: ReturnType<KernelFilesystem["get"]>) =>
  value === null || (typeof value === "object" && value !== null);

const under = (directory: string, name: string) =>
  directory === "" ? name : `${directory}/${name}`;

function* descend(
  filesystem: KernelFilesystem,
  directory: string,
): Generator<string> {
  for (const name of filesystem.listDirectory(directory)) {
    if (SELF_AND_PARENT.has(name)) continue;
    const path = under(directory, name);
    const value = filesystem.get(path);
    if (typeof value === "string") yield path;
    else if (isDirectory(value)) yield* descend(filesystem, path);
  }
}

const ancestorsOf = (path: string) => {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

/**
 * The set of paths a provider currently holds, rebuilt whenever the provider
 * says it changed. The kernel asks about existence far more often than it asks
 * about content, and it cannot wait for an answer.
 */
class PathIndex {
  private files = new Set<string>();
  private directories = new Set<string>();

  constructor(private readonly provider: SyncFileProvider) {
    this.rebuild();
    provider.watch?.(() => this.rebuild());
  }

  holds = (path: string) => this.files.has(path);

  contains = (path: string) => this.directories.has(path);

  childrenOf(directory: string) {
    const prefix = directory === "" ? "" : `${directory}/`;
    const names = new Set<string>();
    for (const path of this.files) {
      if (!path.startsWith(prefix)) continue;
      const [name] = path.slice(prefix.length).split("/");
      if (name) names.add(name);
    }
    return [...names];
  }

  private rebuild() {
    this.files = new Set(this.provider.paths());
    this.directories = new Set(
      [...this.files].flatMap((path) => ancestorsOf(path)),
    );
  }
}

/**
 * The editor reading the filesystem the kernel mounts, so a file is never held
 * in two places just to be understood in one.
 */
export const asProvider = (filesystem: KernelFilesystem): FileProvider => ({
  paths: () => [...descend(filesystem, "")],
  read: (path) => {
    const value = filesystem.get(path);
    if (typeof value !== "string") throw new Error(`No file to read at ${path}`);
    return value;
  },
  ...(filesystem.put && {
    write: (path: string, text: string) => filesystem.put?.(path, text),
  }),
});

/** The filesystem the kernel mounts, from a provider the editor reads. */
export const asFilesystem = (provider: SyncFileProvider): KernelFilesystem => {
  const index = new PathIndex(provider);
  return {
    get: (path) => {
      if (index.holds(path)) return provider.read(path);
      return index.contains(path) ? DIRECTORY : undefined;
    },
    listDirectory: (path) => index.childrenOf(path),
    ...(provider.write && {
      put: (path: string, value: string | null) =>
        value === null ? undefined : provider.write?.(path, value),
    }),
  };
};
