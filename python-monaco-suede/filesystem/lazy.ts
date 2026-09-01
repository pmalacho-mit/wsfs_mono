import { RegisteredFile } from "@codingame/monaco-vscode-files-service-override";
import type * as monaco from "monaco-editor";
import { FileProvider } from "./provider";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const asBytes = (content: string | Uint8Array) =>
  typeof content === "string" ? encoder.encode(content) : content;

const asText = (content: string | Uint8Array) =>
  typeof content === "string" ? content : decoder.decode(content);

/**
 * A file whose bytes never live in the editor's filesystem: every read is
 * delegated back to the {@link FileProvider} that owns the path. The most
 * recent read is memoised so that the stat-then-read pair the file service
 * performs when opening a document costs a single fetch.
 */
export class LazyFile extends RegisteredFile {
  private memo?: Promise<Uint8Array>;

  constructor(
    uri: monaco.Uri,
    private readonly path: string,
    private readonly provider: FileProvider,
  ) {
    super(uri, false);
  }

  read = () =>
    (this.memo ??= Promise.resolve(this.provider.read(this.path)).then(asBytes));

  /**
   * A provider that cannot be written to still has to be editable: the edit
   * lives here until the consumer decides what to do with it.
   */
  async write(content: string | Uint8Array) {
    this.memo = Promise.resolve(asBytes(content));
    await this.provider.write?.(this.path, asText(content));
  }

  async getSize() {
    return (await this.read()).byteLength;
  }

  invalidate() {
    this.memo = undefined;
    this._onDidChange.fire();
  }
}
