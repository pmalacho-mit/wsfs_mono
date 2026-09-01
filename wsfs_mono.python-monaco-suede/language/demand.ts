import { FileProvider } from "../filesystem/provider";
import { join } from "../utils";
import { DID_OPEN, OpenDocuments } from "./documents";
import { candidatePaths, scanImports, type ImportReference } from "./imports";
import { createFile, deleteFile } from "./pyright";

type Notifier = {
  sendNotification: (method: string, params: unknown) => Promise<void>;
};

/** The part of a filesystem that import resolution needs. */
export type FileIndex = {
  has: (path: string) => boolean;
  read: (path: string) => string | Promise<string>;
  onDidChange: (listen: FileProvider.Listener) => unknown;
};

/**
 * Feeds the language server the smallest set of files that can still answer a
 * question about an entry point: everything reachable from it through imports.
 * Nothing else is transferred, so a workspace of any size costs only the
 * modules its open files actually touch.
 *
 * The entry itself is left alone — whoever asked for it owns that document.
 */
export class DemandLoader {
  private delivered = new Map<string, string>();
  private edges = new Map<string, string[]>();
  private walks = new Map<string, Promise<void>>();
  private roots: string[] = [""];

  constructor(
    private readonly files: FileIndex,
    private readonly client: () => Promise<Notifier>,
    private readonly documents: OpenDocuments,
    private readonly toUri: (path: string) => { toString: () => string },
  ) {
    files.onDidChange((change) => this.refresh(change));
    documents.onClosed((uri) => this.restore(uri));
  }

  reach = (entry: string) => {
    const inFlight = this.walks.get(entry);
    if (inFlight) return inFlight;
    const walk = this.walk(entry).finally(() => this.walks.delete(entry));
    this.walks.set(entry, walk);
    return walk;
  };

  /**
   * Where a bare module name may live, in the order the language server would
   * itself search: the workspace first, then any mounted package root.
   */
  addSearchRoot(root: string) {
    this.roots = [...new Set([...this.roots, root])];
    this.reconsiderUnresolvedImports();
  }

  private async walk(entry: string) {
    const visited = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const path = queue.shift()!;
      if (visited.has(path) || !this.files.has(path)) continue;
      visited.add(path);
      queue.push(...(await this.importsOf(path, path !== entry)));
    }
  }

  private async importsOf(path: string, deliverable: boolean) {
    const cached = this.edges.get(path);
    if (cached) return cached;

    const text = await this.files.read(path);
    if (deliverable && !this.isDelivered(path)) await this.deliver(path, text);

    const resolved = this.resolveAll(path, text);
    this.edges.set(path, resolved);
    return resolved;
  }

  /**
   * The server's filesystem only learns that a path exists; the content that
   * makes it useful arrives as an open document. Versions and the open/change
   * distinction are settled downstream, where the editor's own traffic is seen
   * too — so this always asks to open and never numbers anything itself.
   */
  private isDelivered = (path: string) =>
    this.delivered.has(this.toUri(path).toString());

  private async deliver(path: string, text: string) {
    const uri = this.toUri(path).toString();
    const client = await this.client();
    this.delivered.set(uri, path);
    await createFile(client, uri);
    await client.sendNotification(DID_OPEN, {
      textDocument: { uri, languageId: "python", version: 0, text },
    });
  }

  private resolveAll(importer: string, text: string) {
    const exists = (candidate: string) => this.files.has(candidate);
    return scanImports(text)
      .map((reference) => this.underAnyRoot(reference, importer).find(exists))
      .filter((resolved): resolved is string => resolved !== undefined);
  }

  private underAnyRoot(reference: ImportReference, importer: string) {
    const candidates = candidatePaths(reference, importer);
    return this.roots.flatMap((root) =>
      candidates.map((candidate) => join(root, candidate)),
    );
  }

  private restore(uri: string) {
    const path = this.delivered.get(uri);
    if (!path) return;
    this.delivered.delete(uri);
    void this.redeliver(path);
  }

  private async redeliver(path: string) {
    if (!this.files.has(path)) return;
    await this.deliver(path, await this.files.read(path));
  }

  private refresh({ path, kind }: FileProvider.Change) {
    if (kind === "added") return this.reconsiderUnresolvedImports();
    this.edges.delete(path);
    const uri = this.toUri(path).toString();
    if (!this.delivered.delete(uri)) return;
    if (kind === "removed") void this.forget(uri);
    else void this.redeliver(path);
  }

  private async forget(uri: string) {
    await deleteFile(await this.client(), uri);
  }

  private reconsiderUnresolvedImports() {
    const reachable = [...this.edges.keys()];
    this.edges.clear();
    reachable.forEach((path) => this.reach(path));
  }
}
