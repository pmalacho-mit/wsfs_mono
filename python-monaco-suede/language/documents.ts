export const DID_OPEN = "textDocument/didOpen";
export const DID_CHANGE = "textDocument/didChange";
export const DID_CLOSE = "textDocument/didClose";

export type Delivery = {
  method: typeof DID_OPEN | typeof DID_CHANGE;
  version: number;
};

const asOpen = (uri: string, version: number, text: string) => ({
  textDocument: { uri, languageId: "python", version, text },
});

const asChange = (uri: string, version: number, text: string) => ({
  textDocument: { uri, version },
  contentChanges: [{ text }],
});

export const notification = (uri: string, text: string, delivery: Delivery) => ({
  method: delivery.method,
  params:
    delivery.method === DID_OPEN
      ? asOpen(uri, delivery.version, text)
      : asChange(uri, delivery.version, text),
});

/**
 * The server's view of which documents are open. An editor and the import
 * loader both deliver content this way, so whichever arrives second has to
 * change the document rather than open it again, and their versions have to
 * come from one counter rather than one each.
 */
export class OpenDocuments {
  private versions = new Map<string, number>();
  private listeners = new Set<(uri: string) => void>();

  isOpen = (uri: string) => this.versions.has(uri);

  delivery(uri: string): Delivery {
    const version = (this.versions.get(uri) ?? 0) + 1;
    const method = this.versions.has(uri) ? DID_CHANGE : DID_OPEN;
    this.versions.set(uri, version);
    return { method, version };
  }

  /**
   * Closing an editor retracts the content behind every file that imports it,
   * so anything still needed has to be delivered again.
   */
  closed(uri: string) {
    this.versions.delete(uri);
    this.listeners.forEach((listen) => listen(uri));
  }

  onClosed = (listen: (uri: string) => void) => {
    this.listeners.add(listen);
    return () => this.listeners.delete(listen);
  };
}
