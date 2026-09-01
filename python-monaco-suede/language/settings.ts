export type PythonAnalysis = {
  typeCheckingMode?: "off" | "basic" | "standard" | "strict" | "recommended";
  diagnosticMode?: "openFilesOnly" | "workspace";
  useLibraryCodeForTypes?: boolean;
  autoImportCompletions?: boolean;
  typeshedPaths?: string[];
  extraPaths?: string[];
  diagnosticSeverityOverrides?: Record<string, string>;
};

type ConfigurationItem = { section?: string };

/** The server bundles typeshed into its worker rather than reading it off disk. */
const BUNDLED_TYPESHED = "/typeshed";

const ANSWERED_SECTIONS = new Set(["python", "basedpyright"]);

const defaults: PythonAnalysis = {
  typeCheckingMode: "basic",
  diagnosticMode: "openFilesOnly",
  useLibraryCodeForTypes: true,
  autoImportCompletions: true,
  typeshedPaths: [BUNDLED_TYPESHED],
  extraPaths: [],
};

/**
 * The language server asks for these over `workspace/configuration`; answering
 * from here keeps the settings reachable without a configuration service.
 */
export class LanguageSettings {
  private analysis: PythonAnalysis = { ...defaults };

  update(values: PythonAnalysis) {
    this.analysis = { ...this.analysis, ...values };
  }

  addSearchPath(path: string) {
    const extraPaths = [...(this.analysis.extraPaths ?? []), path];
    this.update({ extraPaths: [...new Set(extraPaths)] });
  }

  answer = (items: ConfigurationItem[]) =>
    items.map((item) =>
      item.section !== undefined && ANSWERED_SECTIONS.has(item.section)
        ? { analysis: this.analysis }
        : {},
    );
}
