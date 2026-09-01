import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Points Firefox at the system trust store.
 *
 * NSS keeps its root certificates in a loadable PKCS#11 module named
 * `libnssckbi.so`, alongside the binary. Playwright's Firefox ships without
 * one, and the mechanisms that would otherwise let a root in are unavailable
 * in that build: enterprise policies never start (`policies-startup` is not
 * fired, and the provider Playwright patched in reads only a preference that
 * nothing sets), and a profile's own database is discarded, because a fresh
 * profile is created for every launch.
 *
 * p11-kit ships a module with the same interface that answers from the
 * system store instead of a compiled-in list. Dropping it in where NSS looks
 * makes `update-ca-certificates` the one thing that decides what Firefox
 * trusts — the same store WebKit already reads.
 *
 * Run directly to apply it to every installed Firefox.
 */
const PLAYWRIGHT_BROWSERS = join(homedir(), ".cache", "ms-playwright");

/** The name NSS loads roots from, relative to the browser's own directory. */
const ROOTS_MODULE = "libnssckbi.so";

/** Multiarch puts it under a triplet directory that varies by platform. */
const findTrustModule = () => {
  for (const libraries of ["/usr/lib", "/usr/lib64"]) {
    if (!existsSync(libraries)) continue;
    for (const entry of readdirSync(libraries)) {
      const candidate = join(libraries, entry, "pkcs11", "p11-kit-trust.so");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

/** Every version of `browser` Playwright has downloaded, newest included. */
export const installationsOf = (browser) =>
  existsSync(PLAYWRIGHT_BROWSERS)
    ? readdirSync(PLAYWRIGHT_BROWSERS)
        .filter((name) => name.startsWith(`${browser}-`))
        .map((name) => join(PLAYWRIGHT_BROWSERS, name, browser))
        .filter(existsSync)
    : [];

/**
 * Idempotent, and safe to call when Firefox is not installed: a browser image
 * built for Chromium or WebKit simply has nothing to link.
 */
export const useSystemRoots = () => {
  const module = findTrustModule();
  if (!module) return [];

  const linked = [];
  for (const installation of installationsOf("firefox")) {
    const roots = join(installation, ROOTS_MODULE);
    if (lstatSync(roots, { throwIfNoEntry: false })) rmSync(roots);
    symlinkSync(module, roots);
    linked.push(roots);
  }
  return linked;
};

if (import.meta.filename === process.argv[1])
  for (const roots of useSystemRoots()) console.log(`system roots: ${roots}`);
