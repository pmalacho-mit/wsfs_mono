export type ImportReference = {
  ascend: number;
  parts: string[];
  names: string[];
};

const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(.+)$/;
const PLAIN_IMPORT = /^[ \t]*import[ \t]+(.+)$/;

const withoutComment = (line: string) => line.split("#")[0];

const withoutAlias = (clause: string) =>
  clause.split(/[ \t]+as[ \t]+/)[0].trim();

const clauses = (list: string) =>
  list
    .replace(/[()]/g, "")
    .split(",")
    .map(withoutAlias)
    .filter((name) => name.length > 0 && name !== "*");

const segments = (dotted: string) => dotted.split(".").filter(Boolean);

const fromImport = (line: string): ImportReference | undefined => {
  const match = FROM_IMPORT.exec(line);
  if (!match) return undefined;
  const [, dots, dotted, imported] = match;
  return {
    ascend: dots.length,
    parts: segments(dotted),
    names: clauses(imported),
  };
};

const plainImports = (line: string): ImportReference[] => {
  const match = PLAIN_IMPORT.exec(line);
  return match
    ? clauses(match[1]).map((dotted) => ({
        ascend: 0,
        parts: segments(dotted),
        names: [],
      }))
    : [];
};

const referencesIn = (line: string): ImportReference[] => {
  const single = fromImport(line);
  return single ? [single] : plainImports(line);
};

const directory = (path: string) => path.split("/").slice(0, -1);

const ascendFrom = (path: string, ascend: number) =>
  ascend === 0
    ? []
    : directory(path).slice(0, directory(path).length - (ascend - 1));

const extensions = (base: string[]) =>
  base.length === 0
    ? []
    : [
        `${base.join("/")}.pyi`,
        `${base.join("/")}.py`,
        `${base.join("/")}/__init__.py`,
      ];

export const scanImports = (text: string): ImportReference[] =>
  text.split("\n").map(withoutComment).flatMap(referencesIn);

/**
 * Every path a reference could denote, most specific first. Submodule forms
 * are included because `from pkg import mod` is indistinguishable from
 * `from pkg import name` without reading `pkg` itself.
 */
export const candidatePaths = (
  reference: ImportReference,
  importer: string,
): string[] => {
  const root =
    reference.ascend === 0
      ? reference.parts
      : [...ascendFrom(importer, reference.ascend), ...reference.parts];
  const submodules = reference.names.flatMap((name) =>
    extensions([...root, name]),
  );
  return [...extensions(root), ...submodules];
};
