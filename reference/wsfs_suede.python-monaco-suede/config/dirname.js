/// <reference types="node" />

import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

export default dirname;

export const suederoot = path.resolve(dirname, "../");

/**
 *
 * @param  {string[]} segments
 * @returns {string}
 */
export const fromSuedeRoot = (...segments) =>
  path.resolve(suederoot, ...segments);
