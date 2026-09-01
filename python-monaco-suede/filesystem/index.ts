import {
  RegisteredFileSystemProvider,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import type * as monaco from "monaco-editor";
import { relative } from "../utils";
import { FileProvider } from "./provider";
import { LazyFile } from "./lazy";

export { FileProvider } from "./provider";
export { LazyFile } from "./lazy";

type Mounted = { file: LazyFile; origin: string; unregister: () => void };

class Mount {
  private files = new Map<string, Mounted>();
  private unwatch?: FileProvider.Unsubscribe;

  constructor(
    readonly provider: FileProvider,
    private readonly attach: (path: string, provider: FileProvider) => Mounted,
    private readonly announce: FileProvider.Listener,
  ) {}

  async open() {
    this.unwatch = this.provider.watch?.((change) => this.apply(change));
    for (const path of await this.provider.paths()) this.add(path);
  }

  close() {
    this.unwatch?.();
    for (const path of [...this.files.keys()]) this.remove(path);
  }

  has = (path: string) => this.files.has(relative(path));
  paths = () => this.files.keys();
  read = (path: string) => this.provider.read(this.originOf(path));

  private apply(change: FileProvider.Change) {
    if (change.kind === "removed") this.remove(change.path);
    else if (change.kind === "added") this.add(change.path);
    else this.files.get(relative(change.path))?.file.invalidate();
    this.announce(change);
  }

  private add(path: string) {
    if (this.files.has(relative(path))) return;
    this.files.set(relative(path), this.attach(path, this.provider));
  }

  private originOf = (path: string) =>
    this.files.get(relative(path))?.origin ?? path;

  private remove(path: string) {
    this.files.get(relative(path))?.unregister();
    this.files.delete(relative(path));
  }
}

/**
 * The editor-facing filesystem. Paths are announced up front so that imports
 * resolve, but content is only ever pulled from the owning {@link FileProvider}
 * when something actually opens the file.
 */
export class Filesystem {
  private overlay = new RegisteredFileSystemProvider(false);
  private mounts: Mount[] = [];
  private listeners = new Set<FileProvider.Listener>();

  readonly memory = new FileProvider.Memory();

  /**
   * Registering the overlay reaches for the workspace's services, and asking
   * for them is what counts as bringing them up — before whoever is meant to
   * configure them has. Files can be held meanwhile; only the editor's view of
   * them waits.
   */
  constructor(
    private readonly toUri: (path: string) => monaco.Uri,
    priority: number,
    servicesReady: Promise<void>,
  ) {
    void servicesReady.then(() => registerFileSystemOverlay(priority, this.overlay));
    void this.mount(this.memory);
  }

  async mount(provider: FileProvider) {
    const mount = new Mount(provider, this.register, this.announce);
    this.mounts.push(mount);
    await mount.open();
    return () => this.unmount(mount);
  }

  owner = (path: string) => this.mounts.find((mount) => mount.has(path));

  has = (path: string) => this.owner(path) !== undefined;

  paths = () => this.mounts.flatMap((mount) => [...mount.paths()]);

  read = async (path: string) => {
    const mount = this.owner(path);
    if (!mount) throw new Error(`No provider owns ${path}`);
    return mount.read(path);
  };

  onDidChange = (listen: FileProvider.Listener) => {
    this.listeners.add(listen);
    return () => this.listeners.delete(listen);
  };

  private register = (path: string, provider: FileProvider): Mounted => {
    const file = new LazyFile(this.toUri(path), path, provider);
    const registration = this.overlay.registerFile(file);
    return { file, origin: path, unregister: () => registration.dispose() };
  };

  private announce = (change: FileProvider.Change) =>
    this.listeners.forEach((listen) => listen(change));

  private unmount(mount: Mount) {
    mount.close();
    this.mounts = this.mounts.filter((candidate) => candidate !== mount);
  }
}
