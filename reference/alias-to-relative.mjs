#!/usr/bin/env node
/**
 * alias-to-relative.mjs
 *
 * Rewrites aliased imports into relative paths, using an explicit
 * alias -> real-location mapping table.
 *
 *   node alias-to-relative.mjs src/routes/+page.svelte --dry-run
 *   node alias-to-relative.mjs .
 *
 * Extension handling:
 *   - An extension written in the ORIGINAL specifier is always preserved.
 *       "$lib/ui-utils.js"  ->  "../../ui-utils.js"   (even though it's .ts on disk)
 *   - An extension that only exists in the MAPPING target is dropped, since the
 *     author never wrote it. Use --keep-ext to emit it instead.
 *       "$lib/components/ui-utils"  ->  "../../ui-utils"
 *
 * Flags:
 *   -n, --dry-run     Show what would change without touching files
 *   -q, --quiet       Only print the summary and warnings
 *       --root <p>    Override ROOT (useful for testing on a fixture)
 *       --keep-ext    Emit the mapping target's extension when the original had none
 *       --no-verify   Skip the "does this path exist on disk?" check
 *       --ext .a,.b   Override the file extensions that get scanned
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Mapping table  --  THE ONLY THING YOU SHOULD NEED TO EDIT
// ---------------------------------------------------------------------------

const ROOT =
  "/workspaces/pmalacho-mit/wsfs_suede/.worktrees/collaboration/release/frontend/svelte/shadcn";

/**
 * [ alias prefix as written in imports , real location relative to ROOT ]
 *
 * "" means ROOT itself. Write prefixes WITHOUT a file extension -- specifiers
 * are matched with their extension stripped, so one entry covers
 * "$lib/ui-utils", "$lib/ui-utils.js" and "$lib/ui-utils.ts" alike.
 *
 * Order does not matter -- longest prefix wins, matched on a path boundary
 * (so "$lib/components/ui" never swallows "$lib/components/ui-utils").
 */
const MAPPINGS = [
  ["$lib/components/ui-utils", "ui-utils.ts"],
  ["$lib/ui-utils", "ui-utils.ts"],
  ["$lib/components/ui", "ui"],
  ["$lib/components", ""],
];

const DEFAULT_EXTS = [".svelte", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".output",
  "build",
  "dist",
  "coverage",
]);

/** Recognised as a trailing extension. Longest first -- .svelte.ts before .ts. */
const KNOWN_EXTS = [
  ".svelte.ts",
  ".svelte.js",
  ".svelte",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  ".json",
  ".css",
  ".svg",
];

/** Dropped when only the mapping target carried the extension. */
const STRIPPABLE = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];

/** Tried when checking whether a resolved target actually exists. */
const RESOLVE_EXTS = [
  "",
  ".ts",
  ".js",
  ".svelte",
  ".svelte.ts",
  ".svelte.js",
  ".mjs",
  ".json",
  ".css",
  ".svg",
];

/**
 * Matches the module specifier of:
 *   import x from "..."      export { x } from "..."
 *   import "..."             import("...")            require("...")
 * `\s` spans newlines, so multi-line import blocks are covered.
 */
const SPECIFIER_RE =
  /(\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    target: null,
    root: ROOT,
    dryRun: false,
    quiet: false,
    keepExt: false,
    verify: true,
    exts: DEFAULT_EXTS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-n":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-q":
      case "--quiet":
        opts.quiet = true;
        break;
      case "--keep-ext":
        opts.keepExt = true;
        break;
      case "--no-verify":
        opts.verify = false;
        break;
      case "--root":
        opts.root = argv[++i];
        break;
      case "--ext":
        opts.exts = argv[++i]
          .split(",")
          .map((e) => e.trim())
          .map((e) => (e.startsWith(".") ? e : `.${e}`));
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(1);
        }
        if (opts.target) {
          console.error("Only one path may be given.");
          process.exit(1);
        }
        opts.target = arg;
    }
  }

  opts.target = path.resolve(opts.target ?? process.cwd());
  opts.root = path.resolve(opts.root);
  return opts;
}

function printHelp() {
  console.log(`
Usage: node alias-to-relative.mjs [path] [options]

  path              File or directory to process (default: cwd)

  -n, --dry-run     Preview changes without writing
  -q, --quiet       Summary and warnings only
      --root <p>    Override the shadcn root
      --keep-ext    Emit the target's extension when the original had none
      --no-verify   Skip the on-disk existence check
      --ext .svelte,.ts
`);
}

// ---------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------

/** "foo/bar.js" -> { base: "foo/bar", ext: ".js" }; unknown exts stay in base. */
function splitExt(p) {
  for (const ext of KNOWN_EXTS) {
    if (p.endsWith(ext)) return { base: p.slice(0, -ext.length), ext };
  }
  return { base: p, ext: "" };
}

/** Drop .ts/.js, but never from *.svelte.ts (that would change what resolves). */
function stripExtension(p) {
  if (/\.svelte\.(ts|js)$/.test(p)) return p;
  for (const ext of STRIPPABLE) {
    if (p.endsWith(ext)) return p.slice(0, -ext.length);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

function buildRules(opts) {
  return MAPPINGS.map(([prefix, rel]) => ({
    prefix,
    absolute: rel ? path.join(opts.root, rel) : opts.root,
    isFile: path.extname(rel) !== "",
  })).sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Build the emitted specifier.
 * `originalExt` is whatever the author wrote, and always wins if present.
 */
function emitSpecifier(fromFile, absoluteTarget, originalExt, opts) {
  let rel = path.relative(path.dirname(fromFile), absoluteTarget);
  rel = rel.split(path.sep).join("/");

  if (originalExt) {
    rel = splitExt(rel).base + originalExt;
  } else if (!opts.keepExt) {
    rel = stripExtension(rel);
  }

  if (rel === "") return ".";
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Does this path resolve to something real, with or without an extension? */
function resolvesOnDisk(abs) {
  for (const ext of RESOLVE_EXTS) {
    const candidate = abs + ext;
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return true;
    if (stat.isDirectory() && ext === "") {
      const hasIndex = ["index.ts", "index.js", "index.svelte"].some((f) =>
        fs.existsSync(path.join(candidate, f))
      );
      if (hasIndex) return true;
    }
  }
  return false;
}

/** Returns { specifier, probe, note } or null if not an alias. */
function rewriteSpecifier(spec, fromFile, rules, opts) {
  const suffixMatch = spec.match(/[?#].*$/); // preserve ?raw, ?url, etc.
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const withoutSuffix = suffix ? spec.slice(0, -suffix.length) : spec;

  // Match on the extension-less form so "$lib/ui-utils.js" hits "$lib/ui-utils".
  const { base, ext: originalExt } = splitExt(withoutSuffix);

  for (const rule of rules) {
    if (base !== rule.prefix && !base.startsWith(`${rule.prefix}/`)) continue;

    const rest = base.slice(rule.prefix.length); // "" or "/foo/bar"
    const note =
      rule.isFile && rest
        ? `"${rule.prefix}" maps to a file, but this import reaches inside it`
        : null;

    const absolute = rest ? path.join(rule.absolute, rest) : rule.absolute;

    return {
      specifier: emitSpecifier(fromFile, absolute, originalExt, opts) + suffix,
      probe: splitExt(absolute).base, // check existence ignoring .ts vs .js
      note,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function processFile(file, rules, opts, warnings) {
  const original = fs.readFileSync(file, "utf8");
  const changes = [];

  const updated = original.replace(
    SPECIFIER_RE,
    (match, lead, quote, spec, offset) => {
      const result = rewriteSpecifier(spec, file, rules, opts);
      if (result === null || result.specifier === spec) return match;

      const line = lineNumberAt(original, offset);
      const where = `${path.relative(process.cwd(), file) || file}:${line}`;

      if (result.note) warnings.push(`${where}  ${spec}  --  ${result.note}`);
      if (opts.verify && !resolvesOnDisk(result.probe)) {
        warnings.push(
          `${where}  ${spec}  --  target not found on disk: ${result.probe}`
        );
      }

      changes.push({ line, from: spec, to: result.specifier });
      return `${lead}${quote}${result.specifier}${quote}`;
    }
  );

  if (changes.length && !opts.dryRun) {
    fs.writeFileSync(file, updated, "utf8");
  }

  return changes;
}

function* walk(dir, opts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(path.join(dir, entry.name), opts);
    } else if (entry.isFile()) {
      if (opts.exts.some((ext) => entry.name.endsWith(ext))) {
        yield path.join(dir, entry.name);
      }
    }
  }
}

function collectFiles(opts) {
  return fs.statSync(opts.target).isFile()
    ? [opts.target]
    : [...walk(opts.target, opts)];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.target)) {
    console.error(`Path not found: ${opts.target}`);
    process.exit(1);
  }
  if (opts.verify && !fs.existsSync(opts.root)) {
    console.warn(`Warning: --root does not exist: ${opts.root}\n`);
  }

  const rules = buildRules(opts);
  const files = collectFiles(opts);
  const warnings = [];

  let changedFiles = 0;
  let totalChanges = 0;

  for (const file of files) {
    const changes = processFile(file, rules, opts, warnings);
    if (!changes.length) continue;

    changedFiles++;
    totalChanges += changes.length;

    if (!opts.quiet) {
      console.log(path.relative(process.cwd(), file) || file);
      for (const c of changes) {
        console.log(`  ${String(c.line).padStart(4)}  ${c.from}  ->  ${c.to}`);
      }
      console.log("");
    }
  }

  if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log("");
  }

  const verb = opts.dryRun ? "would be rewritten" : "rewritten";
  console.log(
    `${totalChanges} import${totalChanges === 1 ? "" : "s"} ${verb} across ` +
      `${changedFiles} file${changedFiles === 1 ? "" : "s"} ` +
      `(${files.length} scanned).${opts.dryRun ? "  [dry run]" : ""}`
  );

  process.exitCode = warnings.length ? 2 : 0;
}

main();
