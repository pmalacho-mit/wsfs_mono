/// <reference types="node" />

import { viteStaticCopy } from "vite-plugin-static-copy";
import { suederoot } from "./dirname";
import { resolve } from "node:path";

/** SharedArrayBuffer, and so the kernel, only exists on a cross-origin isolated page. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** @type {import('vite').Connect.NextHandleFunction} */
const setIsolationHeaders = (_, response, next) => {
  for (const [header, value] of Object.entries(ISOLATION_HEADERS))
    response.setHeader(header, value);
  next();
};

/**
 * `server.headers` reaches assets Vite serves itself, but not documents a
 * framework renders, so the headers are set again for every response.
 *
 * @return {import('vite').Plugin}
 */
const crossOriginIsolation = () => ({
  name: "python-web-kernel-suede:cross-origin-isolation",
  configureServer({ middlewares }) {
    middlewares.use(setIsolationHeaders);
  },
  configurePreviewServer({ middlewares }) {
    middlewares.use(setIsolationHeaders);
  },
});

/**
 * @typedef {object} ApplyOptions
 * @property {boolean} [patchCrossOriginIsolation] Whether to ship the service worker that isolates pages served without the headers
 */

/**
 *
 * @param {import('vite').UserConfig} current
 * @param {ApplyOptions} [options]
 * @return {import('vite').UserConfig}
 */
export const applyConfig = (
  current,
  { patchCrossOriginIsolation = true } = {},
) => {
  current.server ??= {};
  current.server.host ??= "0.0.0.0";
  current.server.fs ??= {};
  current.server.fs.allow ??= [];
  current.server.fs.allow.push(suederoot);
  current.server.headers ??= {};
  Object.assign(current.server.headers, ISOLATION_HEADERS);

  current.worker ??= {};

  current.worker.format ??= "es";

  current.plugins ??= [];
  current.plugins.push(crossOriginIsolation());

  if (patchCrossOriginIsolation) {
    const coi = resolve(suederoot, "config/static/coi-serviceworker.js");

    current.plugins.push(
      viteStaticCopy({
        targets: [{ src: coi, dest: "./" }],
      }),
    );
  }

  return current;
};
