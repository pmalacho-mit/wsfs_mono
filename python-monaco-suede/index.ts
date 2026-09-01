import {
  default as EditorComponent,
  type Props as EditorProps,
} from "./Editor.svelte";
import { EditableFile } from "./models.svelte";
import type { Chain, ChainedFile } from "./chained/registry";
import type { PythonAnalysis } from "./language/settings";
import { FileProvider } from "./filesystem/provider";
import type { DiagnosticFilter as Filter } from "./language/diagnostics";
import {
  missingImports,
  missingStubs,
  trailingExpression,
  undefinedNames,
} from "./language/diagnostics";
import { asFilesystem, asProvider } from "./kernel/filesystem";
import { uri, workspace } from "./workspace";

export type { FileProvider } from "./filesystem/provider";
export type { PythonAnalysis } from "./language/settings";
export type { DiagnosticContext } from "./language/diagnostics";
export type { Chain, ChainedFile } from "./chained/registry";

/**
 * The filters worth having, by name. Declared alongside the type of the same
 * name so that one import carries both.
 */
export type DiagnosticFilter = Filter;
export const DiagnosticFilter = {
  trailingExpression,
  undefinedNames,
  missingImports,
  missingStubs,
};
export type { KernelFilesystem, SyncFileProvider } from "./kernel/filesystem";

type Registration = Pick<EditableFile, "path" | "source">;

type MountOptions = {
  /** Workspace-relative directory that bare module names may be found under. */
  searchRoot?: string;
};

const searchUnder = (root: string) => {
  workspace.settings.addSearchPath(uri(root).path);
  workspace.imports.addSearchRoot(root);
};

export const Editor = {
  Component: EditorComponent,
  Model: EditableFile,

  registerFile: ({ path, source }: Registration) =>
    workspace.files.memory.write(path, source),

  unregisterFile: (path: string) => workspace.files.memory.remove(path),

  renameFile: (file: Registration, oldPath: string) => {
    workspace.files.memory.write(file.path, file.source);
    workspace.files.memory.remove(oldPath);
  },

  /**
   * Hands the editor a filesystem it does not own. Paths are read up front so
   * that imports resolve; content is fetched only for files something opens or
   * imports, and never copied into the editor.
   */
  provideFiles: async (provider: FileProvider, options: MountOptions = {}) => {
    const unmount = await workspace.files.mount(provider);
    if (options.searchRoot) searchUnder(options.searchRoot);
    return unmount;
  },

  configure: (analysis: PythonAnalysis) => workspace.settings.update(analysis),

  /**
   * Stops matching diagnostics from being reported. Returns the undo, so a
   * filter that belongs to one view can be dropped when that view goes away.
   */
  registerDiagnosticFilter: (filter: Filter) =>
    workspace.diagnostics.register(filter),

  unregisterDiagnosticFilter: (filter: Filter) =>
    workspace.diagnostics.unregister(filter),

  diagnosticFilters: () => workspace.diagnostics.registered(),
};

export namespace Editor {
  export type Model = EditableFile;
  export type Component = EditorComponent;
  export type Props = EditorProps;
}

/**
 * Files analysed as one shared namespace: each is its own document, but the
 * language server sees it prefixed with every earlier file in its chain — the
 * same trick VSCode uses to make a name bound in one notebook cell visible in
 * the next. Positions are translated back on the way out, so hover, completion
 * and go-to-definition land where the reader is looking.
 */
export const Chained = {
  register: (chain: Chain) => workspace.chains.add(chain),

  /**
   * A file's document contains every earlier file in its chain, so editing one
   * leaves every file after it analysed against text the server no longer has.
   */
  resyncAfter: async (chain: Chain, file: ChainedFile) =>
    workspace.chains.resyncAfter(chain, file, await workspace.client),
};

/** One filesystem, read by both the editor and the kernel that runs the code. */
export const WebKernel = {
  provider: asProvider,
  filesystem: asFilesystem,
};
