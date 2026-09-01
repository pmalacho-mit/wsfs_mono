import type { EditableFile } from "../models.svelte";
import { chainedDocument, originOf, preludeOffset, type Link } from "./lines";
import type { ChainedDocuments } from "./protocol";

/** What a chain needs to know about one of its files. */
export type ChainedFile = Pick<EditableFile, "path" | "source">;

/**
 * An ordered list of files analysed as one shared namespace, the way the cells
 * of a notebook are. It is read on every query rather than copied, so whatever
 * already holds the ordering can be handed over as-is.
 */
export type Chain = { readonly files: readonly ChainedFile[] };

type Placement = { chain: Chain; file: ChainedFile };

type Notifier = {
  sendNotification: (method: string, params: unknown) => Promise<void>;
};

const touch = (uri: string) => ({
  textDocument: { uri, version: 0 },
  contentChanges: [],
});

/**
 * Knows which document URIs belong to a chain, and answers the questions the
 * protocol rewriter asks about them.
 */
export class Chains {
  private chains = new Set<Chain>();

  constructor(
    private readonly toUri: (path: string) => { toString: () => string },
  ) {}

  add(chain: Chain) {
    this.chains.add(chain);
    return () => this.chains.delete(chain);
  }

  documents: ChainedDocuments = {
    offset: (uri) => this.withPreceding(uri, preludeOffset),
    document: (uri) =>
      this.withPlacement(uri, ({ chain, file }) =>
        chainedDocument(this.preceding(chain, file), file.source),
      ),
    origin: (uri, line) =>
      this.withPreceding(uri, (preceding) => originOf(preceding, line)),
  };

  /**
   * A file's analysed document contains every earlier file in its chain, so
   * editing one invalidates all of the files that follow it.
   */
  resyncAfter = (chain: Chain, file: ChainedFile, client: Notifier) =>
    Promise.all(
      this.following(chain, file).map((later) =>
        client.sendNotification(
          "textDocument/didChange",
          touch(this.uriOf(later)),
        ),
      ),
    );

  private uriOf = (file: ChainedFile) => this.toUri(file.path).toString();

  private locate(uri: string): Placement | undefined {
    for (const chain of this.chains) {
      const file = chain.files.find(
        (candidate) => this.uriOf(candidate) === uri,
      );
      if (file) return { chain, file };
    }
    return undefined;
  }

  private preceding = (chain: Chain, file: ChainedFile): Link[] =>
    chain.files.slice(0, chain.files.indexOf(file)).map((earlier) => ({
      uri: this.uriOf(earlier),
      text: earlier.source,
    }));

  private following = (chain: Chain, file: ChainedFile) =>
    chain.files.slice(chain.files.indexOf(file) + 1);

  private withPlacement = <T>(
    uri: string,
    read: (placement: Placement) => T,
  ) => {
    const placement = this.locate(uri);
    return placement === undefined ? undefined : read(placement);
  };

  private withPreceding = <T>(uri: string, read: (preceding: Link[]) => T) =>
    this.withPlacement(uri, ({ chain, file }) =>
      read(this.preceding(chain, file)),
    );
}
