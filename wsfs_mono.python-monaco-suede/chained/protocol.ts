import type { Message } from "vscode-languageserver-protocol";
import {
  DID_CHANGE,
  DID_CLOSE,
  DID_OPEN,
  notification,
  OpenDocuments,
} from "../language/documents";
import type { Origin } from "./lines";

export type ChainedDocuments = {
  /** Lines of preceding cells prefixed onto this document, or undefined if not a cell. */
  offset: (uri: string) => number | undefined;
  /** The full text the server should see for this cell, prelude included. */
  document: (uri: string) => string | undefined;
  /** The cell a prelude line originally came from. */
  origin: (uri: string, line: number) => Origin | undefined;
};

type Node = Record<string, any>;
type Envelope = Message & Node;
type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };

const isObject = (value: unknown): value is Node =>
  typeof value === "object" && value !== null;

const isPosition = (node: Node): node is Position =>
  typeof node.line === "number" && typeof node.character === "number";

const isLocation = (node: Node): node is Location =>
  typeof node.uri === "string" &&
  isObject(node.range) &&
  isObject(node.range.start);

const uriOf = (node: Node): string | undefined => {
  const candidate = node.uri ?? node.targetUri ?? node.textDocument?.uri;
  return typeof candidate === "string" ? candidate : undefined;
};

const offsetOf = (uri: string | undefined, documents: ChainedDocuments) =>
  (uri === undefined ? undefined : documents.offset(uri)) ?? 0;

const shiftLines = (range: Range, delta: number): Range => ({
  start: { ...range.start, line: range.start.line + delta },
  end: { ...range.end, line: range.end.line + delta },
});

const relocate = (
  location: Location,
  documents: ChainedDocuments,
): Location => {
  const offset = documents.offset(location.uri);
  if (offset === undefined) return location;
  const { line } = location.range.start;
  const origin =
    line < offset
      ? documents.origin(location.uri, line)
      : { uri: location.uri, line: line - offset };
  if (!origin) return location;
  return {
    ...location,
    uri: origin.uri,
    range: shiftLines(location.range, origin.line - line),
  };
};

const walk = (
  node: unknown,
  uri: string | undefined,
  visit: (position: Position, uri: string | undefined) => void,
): void => {
  if (!isObject(node)) return;
  if (Array.isArray(node))
    return node.forEach((item) => walk(item, uri, visit));
  const context = uriOf(node) ?? uri;
  if (isPosition(node)) return visit(node, context);
  Object.values(node).forEach((child) => walk(child, context, visit));
};

const restore = (
  node: unknown,
  uri: string | undefined,
  documents: ChainedDocuments,
): unknown => {
  if (!isObject(node)) return node;
  if (Array.isArray(node))
    return node.map((item) => restore(item, uri, documents));
  const context = uriOf(node) ?? uri;
  if (isLocation(node)) return relocate(node, documents);
  if (isPosition(node)) return liftOutOfPrelude(node, context, documents);
  for (const [key, value] of Object.entries(node))
    node[key] = restore(value, context, documents);
  return node;
};

const liftOutOfPrelude = (
  position: Position,
  uri: string | undefined,
  documents: ChainedDocuments,
) => {
  const offset = offsetOf(uri, documents);
  return { ...position, line: Math.max(0, position.line - offset) };
};

const inPrelude = (diagnostic: Node, offset: number) =>
  diagnostic.range.start.line < offset;

const withoutPreludeDiagnostics = (params: Node, offset: number) => ({
  ...params,
  diagnostics: params.diagnostics.filter(
    (diagnostic: Node) => !inPrelude(diagnostic, offset),
  ),
});

const PULL_DIAGNOSTICS = "textDocument/diagnostic";

const SYNC_METHODS = new Set<unknown>([DID_OPEN, DID_CHANGE, DID_CLOSE]);

const isSynchronisation = (message: Node) => SYNC_METHODS.has(message.method);

const wholeDocument = (change: Node) =>
  change.range === undefined ? change.text : undefined;

/** The text a sync notification carries, when it carries all of it. */
const fullTextOf = (message: Node): string | undefined => {
  if (message.method === DID_OPEN) return message.params.textDocument.text;
  const changes = message.params.contentChanges;
  return changes?.length === 1 ? wholeDocument(changes[0]) : undefined;
};

const renumbered = (params: Node, version: number) => ({
  ...params,
  textDocument: { ...params.textDocument, version },
});

const isDiagnosticsNotification = (message: Node) =>
  message.method === "textDocument/publishDiagnostics";

const isResponse = (message: Node) =>
  "result" in message && message.method === undefined;

/**
 * Rewrites the language-server conversation so that a cell's document is
 * analysed with every earlier cell in front of it, while the editor on either
 * end keeps talking about the cell alone. Responses carry no document of their
 * own, so the URI each request was made against is remembered until it is
 * answered.
 */
export class ChainedTransform {
  private asked = new Map<string | number, { uri: string; method: string }>();

  constructor(
    private readonly documents: ChainedDocuments,
    private readonly open: OpenDocuments,
  ) {}

  outgoing = (envelope: Message): Envelope => {
    const message = envelope as Envelope;
    const uri = message.params && uriOf(message.params);
    if (uri === undefined) return message;
    if (isSynchronisation(message)) return this.synchronise(message, uri);
    if (this.documents.offset(uri) === undefined) return message;
    if (message.id !== undefined)
      this.asked.set(message.id, { uri, method: message.method });
    return { ...message, params: this.shifted(message, uri) };
  };

  incoming = (envelope: Message): Envelope => {
    const message = envelope as Envelope;
    if (isDiagnosticsNotification(message)) return this.republish(message);
    if (!isResponse(message)) return message;
    return { ...message, result: this.restoreResult(message) };
  };

  /**
   * A cell is analysed with every earlier cell in front of it, and its text is
   * resent whenever one of those changes — so the editor is not the only author
   * of a cell's document and cannot be the one to number its versions.
   */
  private synchronise(message: Envelope, uri: string): Envelope {
    if (message.method === DID_CLOSE) {
      this.open.closed(uri);
      return message;
    }
    const text = this.documents.document(uri) ?? fullTextOf(message);
    const delivery = this.open.delivery(uri);
    if (text === undefined)
      return {
        ...message,
        params: renumbered(message.params, delivery.version),
      };
    return { ...message, ...notification(uri, text, delivery) };
  }

  private shifted(message: Envelope, uri: string) {
    const params = structuredClone(message.params);
    walk(params, uri, (position, context) => {
      position.line += offsetOf(context, this.documents);
    });
    return params;
  }

  private restoreResult(message: Envelope) {
    const asked = this.asked.get(message.id);
    this.asked.delete(message.id);
    const result = structuredClone(message.result);
    return restore(this.withoutPrelude(result, asked), asked?.uri, this.documents);
  }

  /**
   * A pulled diagnostic report answers for one cell's whole document, prelude
   * included — those belong to the cells they came from and are reported there.
   */
  private withoutPrelude(
    result: unknown,
    asked: { uri: string; method: string } | undefined,
  ) {
    if (asked?.method !== PULL_DIAGNOSTICS || !isObject(result)) return result;
    const offset = this.documents.offset(asked.uri);
    if (offset === undefined || !Array.isArray(result.items)) return result;
    return {
      ...result,
      items: result.items.filter((item: Node) => !inPrelude(item, offset)),
    };
  }

  private republish(message: Envelope) {
    const uri = message.params.uri;
    const offset = this.documents.offset(uri);
    if (offset === undefined) return message;
    const kept = withoutPreludeDiagnostics(
      structuredClone(message.params),
      offset,
    );
    return { ...message, params: restore(kept, uri, this.documents) };
  }
}
