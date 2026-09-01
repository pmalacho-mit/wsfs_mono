/**
 * Making Python work inside a wsfs workspace.
 *
 * THE ONLY PACKAGE THAT KNOWS MONACO OR PYODIDE EXISTS. After the split,
 * `grep -rn "monaco\|pyodide"` across every other repo returns nothing, and
 * the import audit fails the build if that stops being true.
 *
 * SVELTE-BOUND FOR NOW, deliberately: `python-monaco-suede` ships Svelte
 * bindings and no others, and that is a constraint this package inherits
 * rather than one it chose. Everything here that is NOT Svelte-bound -- the
 * kernel's view of the filesystem, the editor's file provider, the edit
 * refinement -- is kept free of it, so it survives that changing.
 */

/** The kernel's view of the workspace, and the editor's. */
export { filesystem } from "./adapters/kernel";
export { provider } from "./adapters/files";
export type { FileProvider } from "./adapters/files";

/** Monaco, drawing one wsfs file. */
export { default as MonacoEditor } from "./MonacoEditor.svelte";
export { MonacoModel } from "./monaco.svelte";
export type { EditorProps } from "./monaco.svelte";

/**
 * Monaco's account of what caused an edit.
 *
 * The refinement, not the mechanism: the sufficient half of edit attribution
 * is `wsfs_svelte_suede`'s Yjs-origin rule, and this names the gesture on top
 * of it. See `edits.ts` for why the order matters.
 */
export { UserEdits, watchEdits } from "./edits";
export type { ModelChange } from "./edits";

/** Running a file, and the terminal that shows what came out. */
export { default as Runner } from "./Runner.svelte";
export type { Outcome } from "./Runner.svelte";
export { ROOT, kernels } from "./kernel";
export type { KernelPool } from "./kernel";
