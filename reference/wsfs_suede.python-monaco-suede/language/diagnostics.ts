import type { Diagnostic as VDiagnostic } from "vscode";

export type Diagnostic = VDiagnostic; /*{
  code?: string | number | { value: string | number };
  message: string;
  range: { start: { line: number } };
};*/

export type DiagnosticContext = {
  /** Workspace-relative path of the document the diagnostic was reported on. */
  path: string;
  /** The document's current lines, in the coordinates the diagnostic uses. */
  lines: string[];
  diagnostic: Diagnostic;
};

/**
 * A description of diagnostics to remove. Every field narrows: a filter with no
 * fields removes everything, and one with a `code` and a `path` removes only
 * diagnostics carrying that code in files matching that path.
 */
export type DiagnosticFilter = {
  /** The rule that raised it, e.g. `"reportUnusedExpression"`. */
  code?: string;
  /** Which files it applies to, matched against the workspace-relative path. */
  path?: RegExp | ((path: string) => boolean);
  /** A final say, for anything the shape of the file cannot express. */
  when?: (context: DiagnosticContext) => boolean;
};

const codeOf = ({ code }: Diagnostic) => {
  if (code === undefined) return undefined;
  return String(typeof code === "object" ? code.value : code);
};

const matchesCode = (filter: DiagnosticFilter, diagnostic: Diagnostic) =>
  filter.code === undefined || filter.code === codeOf(diagnostic);

const matchesPath = (filter: DiagnosticFilter, path: string) =>
  filter.path === undefined ||
  (typeof filter.path === "function"
    ? filter.path(path)
    : filter.path.test(path));

const holds = (filter: DiagnosticFilter, context: DiagnosticContext) =>
  filter.when === undefined || filter.when(context);

const removes = (filter: DiagnosticFilter, context: DiagnosticContext) =>
  matchesCode(filter, context.diagnostic) &&
  matchesPath(filter, context.path) &&
  holds(filter, context);

const lastMeaningfulLine = (lines: string[]) => {
  for (let index = lines.length - 1; index >= 0; index--)
    if (lines[index].trim() !== "") return index + 1;
  return 0;
};

/**
 * Filters worth having by name. The first two are registered by default,
 * because a python document that is really one cell of a notebook reports
 * things a whole-file checker would be right to complain about.
 */
/** A bare trailing expression is how a cell or a script names its result. */
export const trailingExpression: DiagnosticFilter = {
  code: "reportUnusedExpression",
  when: ({ diagnostic, lines }) =>
    diagnostic.range.start.line + 1 === lastMeaningfulLine(lines),
};

/** Names a cell inherits from a kernel session the checker cannot see. */
export const undefinedNames: DiagnosticFilter = {
  code: "reportUndefinedVariable",
};

/** Imports that only resolve once a package is installed at runtime. */
export const missingImports: DiagnosticFilter = {
  code: "reportMissingImports",
};

/** Imports whose package ships no type information. */
export const missingStubs: DiagnosticFilter = {
  code: "reportMissingModuleSource",
};

export const defaultFilters: DiagnosticFilter[] = [
  trailingExpression,
  undefinedNames,
];

export class DiagnosticFilters {
  private filters = new Set<DiagnosticFilter>(defaultFilters);

  register(filter: DiagnosticFilter) {
    this.filters.add(filter);
    return () => this.unregister(filter);
  }

  unregister(filter: DiagnosticFilter) {
    this.filters.delete(filter);
  }

  registered = () => [...this.filters];

  apply(
    diagnostics: Diagnostic[],
    document: Omit<DiagnosticContext, "diagnostic">,
  ) {
    const removed = (diagnostic: Diagnostic) =>
      this.registered().some((filter) =>
        removes(filter, { ...document, diagnostic }),
      );
    return diagnostics.filter((diagnostic) => !removed(diagnostic));
  }
}
