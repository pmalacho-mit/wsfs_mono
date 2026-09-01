import type { PyodideAPI } from "pyodide";
import { code } from "./python";
import supported from "./supported-packages";

const Key = {
  MatplotLibEmit: "__python_web_kernel_emit_matplotlib",
} as const;

export type ImagePayload = {
  base64: string;
  format: "png" | "gif";
  width: number;
  height: number;
};

export const isImage = (query: any): query is ImagePayload =>
  typeof query === "object" &&
  query !== null &&
  typeof query.base64 === "string" &&
  typeof query.width === "number" &&
  typeof query.height === "number";

export const asImage = (payload: any) => {
  const image = payload.toJs({ dict_converter: Object.fromEntries });
  if (!isImage(image)) return;
  payload.destroy();
  return image;
};

export const patchMatplotlib = async (
  pyodide: PyodideAPI,
  onImage: (payload: ImagePayload) => void,
) => {
  pyodide.globals.set(Key.MatplotLibEmit, (payload: unknown) => {
    const image = asImage(payload);
    if (image) onImage(image);
  });
  await pyodide.loadPackage("matplotlib");
  await pyodide.runPythonAsync(code.patchMatplotlib);
};

export const unloadLocalModules = async (pyodide: PyodideAPI, root: string) => {
  const unloaded = await pyodide.runPythonAsync(code.unloadLocalModules(root));
  const report: string = unloaded.__str__();
  if (unloaded instanceof pyodide.ffi.PyProxy) unloaded.destroy();
  return report;
};

export const loadMsgFilter = (
  callback?: (msg: string) => void,
): ((message: string) => void) => {
  // We prevent some spam, otherwise every time you run a cell with an import it will show
  // "Loading bla", "Bla was already loaded from default channel", "Loaded bla"
  let wasAlreadyLoaded: boolean | undefined = undefined;
  const msgBuffer: string[] = [];

  return (msg) => {
    callback?.(msg);
    if (wasAlreadyLoaded === true) return;

    if (wasAlreadyLoaded === false) {
      if (msg.match(/already loaded from default channel$/)) return; // This is not the main package being loaded but another dependency that is already loaded - no need to list it.
      console.debug(msg);
    }

    if (wasAlreadyLoaded === undefined) {
      if (msg.match(/already loaded from default channel$/)) {
        wasAlreadyLoaded = true;
        return;
      }
      if (msg.match(/^Loading [a-z\-, ]*/)) {
        wasAlreadyLoaded = false;
        msgBuffer.forEach((m) => console.debug(m));
        console.debug(msg);
      }
    }
  };
};

export const loadMsgFilterAndCollectPackages = () => {
  const loadedPackages = new Set<string>();
  const loadedPrefix = "Loaded ";

  const messageCallback = loadMsgFilter((msg) =>
    msg
      .slice(loadedPrefix.length)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((p) => loadedPackages.add(p)),
  );

  return { messageCallback, loadedPackages };
};

export const tryResolveProblematicDependencies = async (
  pyodide: PyodideAPI,
  loadedPackages: Set<string>,
) => {
  if (loadedPackages.has("networkx"))
    await pyodide.loadPackage("scipy", {
      messageCallback: loadMsgFilter(),
    });
};

const autoInstallableExternalPackages = new Map<string, string>([
  ["pycountry_convert", "pycountry_convert"],
  ["pymannkendall", "pymannkendall"],
  ["sklearn", "scikit-learn"],
]);

/**
 * Installing packages needs an index to fetch them from. A kernel served
 * without one still runs code that only needs the standard library.
 */
const tryLoadPackage = async (pyodide: PyodideAPI, name: string) => {
  try {
    await pyodide.loadPackage(name, { messageCallback: loadMsgFilter() });
    return true;
  } catch (error) {
    console.warn(`Could not load the "${name}" package`, error);
    return false;
  }
};

export const tryLoadImportsOfLocallyImportedModules = async (
  pyodide: PyodideAPI,
  source: string,
  filename: string,
) => {
  await tryLoadPackage(pyodide, "micropip");
  const modules = await pyodide.runPythonAsync(
    code.recursivelyFindExternalImports(source, filename),
  );
  const result = modules.toJs() as [string[], string[]];
  const toInstall = new Set(result[0]);
  const discoveredDirs = result[1];

  if (modules instanceof pyodide.ffi.PyProxy) modules.destroy();
  for (const mod of toInstall)
    if (autoInstallableExternalPackages.has(mod))
      await pyodide.runPythonAsync(
        code.micropipInstall(autoInstallableExternalPackages.get(mod)!),
      );
    else if (supported.has(mod)) await tryLoadPackage(pyodide, mod);
  tryResolveProblematicDependencies(pyodide, toInstall);
  return { toInstall, discoveredDirs };
};

export const addToSysPath = async (pyodide: PyodideAPI, path: string) =>
  pyodide.runPythonAsync(code.addToSysPath(path));
