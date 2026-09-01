import { MonacoEditorLanguageClientWrapper } from "monaco-editor-wrapper";
import { configureDefaultWorkerFactory } from "monaco-editor-wrapper/workers/workerLoaders";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-languageserver-protocol/browser.js";
import {
  CloseAction,
  ErrorAction,
  vsdiag,
  type ProvideDiagnosticSignature,
} from "vscode-languageclient";
import type { CancellationToken, TextDocument, Uri } from "vscode";
import type { Message } from "vscode-languageserver-protocol";
import * as monaco from "monaco-editor";
import { newServerWorker } from "../workers";
import { intercept, type MessageInterceptor } from "./transport";
import { LanguageSettings } from "./settings";
import { startPyright } from "./pyright";
import { DiagnosticFilters, type Diagnostic } from "./diagnostics";

const LANGUAGE_ID = "python";

type Filtering = {
  filters: DiagnosticFilters;
  toPath: (uri: monaco.Uri) => string;
};

const documentAt = ({ toPath }: Filtering, uri: monaco.Uri) => {
  const model = monaco.editor.getModel(uri);
  return model && { path: toPath(uri), lines: model.getLinesContent() };
};

/** The server pushes diagnostics when the client cannot pull them. */
const pushed =
  (filtering: Filtering) =>
  (
    uri: monaco.Uri,
    diagnostics: Diagnostic[],
    next: (uri: monaco.Uri, diagnostics: Diagnostic[]) => void,
  ) => {
    const document = documentAt(filtering, uri);
    if (!document) return next(uri, diagnostics);
    next(uri, filtering.filters.apply(diagnostics, document));
  };

const uriOf = (document: TextDocument | Uri) =>
  "uri" in document ? document.uri : document;

const isFullReport = (
  report: Awaited<ReturnType<ProvideDiagnosticSignature>>,
): report is vsdiag.RelatedFullDocumentDiagnosticReport =>
  report?.kind === vsdiag.DocumentDiagnosticReportKind.full;

/**
 * basedpyright answers `textDocument/diagnostic` rather than publishing, so
 * this is the path that actually runs — the pushed one is kept for servers
 * that do not.
 */
const pulled =
  (filtering: Filtering) =>
  async (
    document: TextDocument | Uri,
    previousResultId: string | undefined,
    token: CancellationToken,
    next: ProvideDiagnosticSignature,
  ) => {
    const report = await next(document, previousResultId, token);
    if (!isFullReport(report)) return report;
    const within = documentAt(filtering, uriOf(document));
    if (!within) return report;
    return { ...report, items: filtering.filters.apply(report.items, within) };
  };

const INITIALIZE = "initialize";

/**
 * The client only pulls diagnostics for documents VS Code reports as visible,
 * and visibility comes from its tab model — which a standalone Monaco
 * embedding has none of, so every pulled report is discarded. Not advertising
 * the capability makes the server publish instead, along a path that has no
 * such notion of visibility.
 */
const preferPublishedDiagnostics = (message: Message) => {
  const request = message as Message & { method?: string; params?: any };
  if (request.method !== INITIALIZE) return message;
  const { diagnostic: _pull, ...textDocument } =
    request.params?.capabilities?.textDocument ?? {};
  return {
    ...request,
    params: {
      ...request.params,
      capabilities: { ...request.params.capabilities, textDocument },
    },
  };
};

const published = (interceptor: MessageInterceptor): MessageInterceptor => ({
  incoming: interceptor.incoming,
  outgoing: (message) => interceptor.outgoing(preferPublishedDiagnostics(message)),
});

export type LanguageClientOptions = {
  workspaceUri: monaco.Uri;
  settings: LanguageSettings;
  interceptor: MessageInterceptor;
  diagnostics: DiagnosticFilters;
  toPath: (uri: monaco.Uri) => string;
};

export const createLanguageClient = async ({
  workspaceUri,
  settings,
  interceptor,
  diagnostics,
  toPath,
}: LanguageClientOptions) => {
  const worker = startPyright(newServerWorker);

  const messageTransports = intercept(
    {
      reader: new BrowserMessageReader(worker),
      writer: new BrowserMessageWriter(worker),
    },
    published(interceptor),
  );

  const host = new MonacoEditorLanguageClientWrapper();
  await host.init({
    $type: "extended",
    // The editor brought these up; a second attempt throws.
    vscodeApiConfig: { vscodeApiInitPerformExternally: true },
    editorAppConfig: { monacoWorkerFactory: configureDefaultWorkerFactory },
    languageClientConfigs: {
      automaticallyDispose: false,
      configs: {
        [LANGUAGE_ID]: {
          name: "Pyright Language Client",
          connection: {
            options: { $type: "WorkerDirect", worker },
            messageTransports,
          },
          clientOptions: {
            documentSelector: [LANGUAGE_ID],
            middleware: {
              handleDiagnostics: pushed({ filters: diagnostics, toPath }),
              provideDiagnostics: pulled({ filters: diagnostics, toPath }),
              workspace: {
                configuration: (params) => settings.answer(params.items),
              },
            },
            workspaceFolder: { index: 0, name: "workspace", uri: workspaceUri },
            // The server destructures this, and bundles typeshed itself.
            initializationOptions: { files: {} },
            errorHandler: {
              error: () => ({ action: ErrorAction.Continue }),
              closed: () => ({ action: CloseAction.DoNotRestart }),
            },
          },
        },
      },
    },
  });

  await host.startLanguageClients();
  const client = host.getLanguageClient(LANGUAGE_ID);
  if (!client) throw new Error("Language client not found");
  return client;
};
