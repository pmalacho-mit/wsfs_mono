/// <reference types="node" />

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * @param {string} searchDir
 * @returns {string | undefined}
 */
export const findNearestNodeModules = (searchDir) => {
  /** @type {string | undefined} */
  let nodeModulesPath = undefined;

  while (searchDir !== dirname(searchDir)) {
    const candidate = resolve(searchDir, "node_modules");
    if (existsSync(candidate)) {
      nodeModulesPath = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (!nodeModulesPath) {
    const cwdCandidate = resolve(process.cwd(), "node_modules");
    if (existsSync(cwdCandidate)) nodeModulesPath = cwdCandidate;
  }

  if (!nodeModulesPath) {
    console.warn("Could not find node_modules directory");
    return;
  }

  return nodeModulesPath;
};

/**
 * @param {string} src
 * @param {string} dest
 */
export const copyRecursive = (src, dest) => {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);

    if (entry.isDirectory()) copyRecursive(srcPath, destPath);
    else
      try {
        copyFileSync(srcPath, destPath);
      } catch (error) {
        console.warn(`Failed to copy ${entry.name}:`, error);
      }
  }
};
