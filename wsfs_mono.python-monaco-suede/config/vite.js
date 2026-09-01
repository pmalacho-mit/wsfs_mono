/// <reference types="node" />

import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { findNearestNodeModules } from "./utils";
import { suederoot } from "./dirname";
import { dirname, isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const SERVER_WORKER = "browser-basedpyright/dist/pyright.worker.js";

/** Whose modules this rewrites: the editor's, and nobody else's. */
const EDITOR_PACKAGE = /node_modules[/\\].*(@codingame|monaco-)/;

/** The same, as the esbuild pre-bundler's `onLoad` filter wants it. */
const EDITOR_MODULE = /.*(@codingame|monaco-).*\.js$/;

/** Every `new URL(<specifier>, import.meta.url)`, whatever the specifier. */
const ASSET_URL =
  /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/g;

/**
 * Points those at the file they actually mean, by absolute path.
 *
 * Two things go wrong otherwise, and both are silent. A BARE specifier --
 * `new URL('vscode-oniguruma/release/onig.wasm', import.meta.url)` -- is
 * resolved by a browser against the importing MODULE's url rather than
 * against the package, so the request lands several directories from the
 * file and the editor loses its tokenizer. And a RELATIVE one stops being
 * right the moment vite moves the module into `.vite/deps`, which
 * pre-bundling does to all of them.
 *
 * An absolute path survives both: vite's own `new URL` handling takes it from
 * here, serving it in dev and emitting it for a build.
 *
 * @param {string} code
 * @param {string} file - absolute path of the module `code` came from
 * @returns {string | undefined} the rewritten code, or nothing if unchanged
 */
const pointingAtTheFile = (code, file) => {
  // A bundler's own virtual modules are not files, and neither is anything
  // outside the packages this is here for. `\0` is the convention for the
  // first, and the filter is the one the esbuild plugin used for the second.
  if (!isAbsolute(file) || !EDITOR_PACKAGE.test(file)) return undefined;
  if (!code.includes("import.meta.url")) return undefined;
  const from = createRequire(file);
  let moved = false;

  const next = code.replace(ASSET_URL, (whole, quoted) => {
    const specifier = quoted.slice(1, -1);
    let target;
    try {
      target = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : from.resolve(specifier);
    } catch {
      return whole; // not something this can point anywhere
    }
    if (!existsSync(target)) return whole;
    moved = true;
    return `new URL(${JSON.stringify(target)}, import.meta.url)`;
  });

  return moved ? next : undefined;
};

/**
 * The same rewrite, at the two points a module can reach the browser.
 *
 * Pre-bundling is the one that matters and the one that is easy to miss: a
 * vite `transform` never sees the inside of `.vite/deps`, so a plugin that
 * only runs there fixes the copy nobody loads.
 *
 * @returns {import('vite').Plugin}
 */
const resolvingAssetUrls = () => ({
  name: "python-monaco-suede:import-meta-url",
  // Ahead of vite's own `new URL` handling, so it sees a resolved path.
  enforce: "pre",
  transform(code, id) {
    return pointingAtTheFile(code, id.split("?")[0]);
  },
});

/**
 * Typed by hand rather than as `import('rolldown').Plugin`: rolldown is
 * vite's dependency, not this package's, and the vite THIS resolves may be
 * older than the one a consumer builds with.
 *
 * @returns {{
 *   name: string,
 *   transform: (code: string, id: string) => ({ code: string, map: null } | undefined),
 * }}
 */
const resolvingAssetUrlsWhilePreBundling = () => ({
  name: "python-monaco-suede:import-meta-url",
  transform(code, id) {
    const next = pointingAtTheFile(code, id.split("?")[0]);
    return next === undefined ? undefined : { code: next, map: null };
  },
});

/**
 * The major version of the vite that will RUN this config.
 *
 * Deliberately not the vite THIS package resolves. A monorepo can hold both,
 * and this one does: `wsfs_suede.python-monaco-suede` resolves 7 while the
 * sample it is written for runs 8, so asking for its own would answer
 * confidently and wrongly. The working directory is the project vite was
 * started in, and its vite is the one doing the work.
 *
 * @param {number} [told] - what the consumer said, if it said anything
 * @returns {number}
 */
const runningMajor = (told) => {
  if (told !== undefined) return told;
  try {
    const from = createRequire(resolve(process.cwd(), "-"));
    const { version } = JSON.parse(
      readFileSync(from.resolve("vite/package.json"), "utf8"),
    );
    return Number(version.split(".")[0]);
  } catch (cause) {
    // Loudly, and naming the fix. Guessing wrong lands as `Not implemented`
    // from inside vite's dependency scanner, which points nowhere near here.
    throw new Error(
      "python-monaco-suede: could not work out which vite is running, and " +
        "the editor's asset urls are rewritten differently before and after " +
        "vite 8. Say which with `applyConfig(config, { vite: 8 })`.",
      { cause },
    );
  }
};

/** The grammar engine and the regex engine it runs on, both UMD. */
const UMD_BUNDLES = /vscode-(textmate|oniguruma)[\\/]release[\\/]main\.js$/;

/**
 * The grammar engine and its regex engine ship UMD bundles, which look for
 * CommonJS first and fall back to hanging themselves off the file's top-level
 * `this`. Served straight to the tokenizer's worker as a module, that `this`
 * is `undefined` and each throws on load — inside a worker, where nothing
 * surfaces it, so documents render and simply never colour.
 *
 * Pre-bundling hands them the CommonJS they want; a worker's import does not,
 * so this does. Their consumer reads `module.default ?? module`, which is why
 * one default export is enough.
 *
 * @return {import('vite').Plugin}
 */
const umdAsCommonJs = () => ({
  name: "python-monaco-suede:umd-global",
  enforce: /** @type {const} */ ("pre"),
  /**
   * @param {string} code
   * @param {string} id
   */
  transform(code, id) {
    if (!UMD_BUNDLES.test(id.split("?")[0])) return;
    const asCommonJs = [
      "const module = { exports: {} };",
      "const exports = module.exports;",
      code,
      "export default module.exports;",
    ].join("\n");
    return { code: asCommonJs, map: null };
  },
});

/**
 * @typedef {object} ApplyOptions
 * @property {string} [base] Base URL to embed into PYTHON_MONACO_BASE
 * @property {number} [vite] Major version of the vite that will run this
 *   config. Worked out from the working directory when not given, which is
 *   right unless vite was started somewhere other than the project.
 */

/**
 *
 * @param {import('vite').UserConfig} current
 * @param {ApplyOptions} [options]
 * @return {import('vite').UserConfig}
 */
export const applyConfig = (current, options = {}) => {
  current.server ??= {};
  current.server.host ??= "0.0.0.0";
  current.server.fs ??= {};
  current.server.fs.allow ??= [];
  current.server.fs.allow.push(suederoot);
  current.worker ??= {};
  // Monaco's workers are loaded as modules, which rollup cannot code-split as iife.
  current.worker.format ??= "es";
  current.define ??= {};
  current.define["PYTHON_MONACO_BASE"] = options?.base ?? current.base ?? `"/"`;
  current.plugins ??= [];

  const node_modules = findNearestNodeModules(suederoot);
  if (!node_modules) throw new Error("Could not find node_modules directory");

  const server = resolve(node_modules, SERVER_WORKER);

  if (!existsSync(server))
    throw new Error(`Could not find ${SERVER_WORKER}`);

  current.plugins.push(
    resolvingAssetUrls(),
    umdAsCommonJs(),
    viteStaticCopy({ targets: [{ src: server, dest: "./" }] }),
  );

  /*
   * Pre-bundling is where this rewrite has to happen, and what does the
   * pre-bundling changed: esbuild until vite 8, rolldown after. The hook is
   * not merely renamed -- `esbuildOptions.plugins` on vite 8 throws before a
   * single dependency is scanned, so exactly one of these may be registered.
   *
   * Cast because `rolldownOptions` arrived in vite 8 and this package is
   * typed against whichever vite it resolves for itself, which may be older.
   */
  current.optimizeDeps ??= {};
  const optimizing = /** @type {Record<string, any>} */ (current.optimizeDeps);

  if (runningMajor(options?.vite) >= 8) {
    optimizing.rolldownOptions ??= {};
    optimizing.rolldownOptions.plugins ??= [];
    optimizing.rolldownOptions.plugins.push(
      resolvingAssetUrlsWhilePreBundling(),
    );
    return current;
  }

  optimizing.esbuildOptions ??= {};
  optimizing.esbuildOptions.plugins ??= [];
  optimizing.esbuildOptions.plugins.push({
    name: "import.meta.url for @codingame only (causes svelte issues otherwise)",
    /** @param {any} args */
    setup(args) {
      importMetaUrlPlugin.setup({
        ...args,
        /** @param {any} options @param {any} callback */
        onLoad: (options, callback) => {
          args.onLoad({ ...options, filter: EDITOR_MODULE }, callback);
        },
      });
    },
  });
  return current;
};
