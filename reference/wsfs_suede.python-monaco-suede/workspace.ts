import * as monaco from "monaco-editor";
import { Filesystem } from "./filesystem";
import { createLanguageClient } from "./language/client";
import { DemandLoader } from "./language/demand";
import { DiagnosticFilters } from "./language/diagnostics";
import { OpenDocuments } from "./language/documents";
import { LanguageSettings } from "./language/settings";
import { ChainedTransform } from "./chained/protocol";
import { Chains } from "./chained/registry";
import { join, latch, relative, singletonify } from "./utils";

const ROOT = "/workspace";

/**
 * The workspace's services are brought up by the first editor, which is the
 * only party holding the container they are given. A language client can
 * neither start before them nor stand one up itself.
 */
const services = latch();

export const servicesStarted = services.release;

const OVERLAY_PRIORITY = 1;

export const uri = (path: string) => monaco.Uri.parse(join(ROOT, path));

export const pathOf = ({ path }: { path: string }) =>
  relative(path.startsWith(ROOT) ? path.slice(ROOT.length) : path);

export const workspace = singletonify({
  uri: () => monaco.Uri.parse(ROOT),
  files: () => new Filesystem(uri, OVERLAY_PRIORITY, services.opened),
  settings: () => new LanguageSettings(),
  diagnostics: () => new DiagnosticFilters(),
  chains: () => new Chains(uri),
  documents: () => new OpenDocuments(),
  chained: () =>
    new ChainedTransform(workspace.chains.documents, workspace.documents),
  client: () =>
    services.opened.then(() =>
      createLanguageClient({
        workspaceUri: workspace.uri,
        settings: workspace.settings,
        interceptor: workspace.chained,
        diagnostics: workspace.diagnostics,
        toPath: pathOf,
      }),
    ),
  imports: () =>
    new DemandLoader(
      workspace.files,
      () => workspace.client,
      workspace.documents,
      uri,
    ),
});

/** Makes a path openable. */
export const prepare = async (source: string, fallback: string) => {
  const { files } = workspace;
  const path = relative(source);
  if (!files.has(path)) files.memory.write(path, fallback);
  return { uri: uri(path).toString(), text: await files.read(path) };
};

/**
 * Gives the language server a path and everything that path imports — and
 * nothing else. Separate from {@link prepare} because it waits on a client
 * that cannot exist until an editor has opened.
 */
export const analyse = async (source: string) => {
  const { imports, client } = workspace;
  // A file that imports nothing gives the loader no reason to reach for the
  // language client, and an unopened document is analysed by nobody.
  await Promise.all([client, imports.reach(relative(source))]);
};
