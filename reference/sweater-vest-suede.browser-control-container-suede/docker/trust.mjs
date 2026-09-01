import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { useSystemRoots } from "./roots.mjs";

/**
 * Adds a certificate to the stores the browsers in this image read. There are
 * two, not three:
 *
 *   - Firefox and WebKit both end up at the system store — WebKit through
 *     glib-networking, Firefox through the roots module `roots.mjs` installs.
 *   - Chromium reads an NSS database at ~/.pki/nssdb, and nothing else.
 *
 * Usage: node /trust.mjs <nickname> <certificate, base64 encoded>
 */
const [nickname, base64] = process.argv.slice(2);

const SYSTEM_CERTIFICATES = "/usr/local/share/ca-certificates";
const NSS_DATABASE = join(homedir(), ".pki", "nssdb");

const run = (command, args) => execFileSync(command, args, { stdio: "pipe" });

const attempt = (command, args) => {
  try {
    run(command, args);
  } catch {
    // Creating a database that exists, or dropping an entry that does not.
  }
};

const write = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

/** What OpenSSL, glib-networking and p11-kit read, and so what all but Chromium trust. */
const system = () => run("update-ca-certificates", []);

/**
 * A single PEM file may carry a whole chain, which corporate roots commonly
 * do. `update-ca-certificates` takes the file as it stands, but `certutil -A`
 * reads only the first certificate in it — so without splitting, Chromium
 * silently ends up trusting the first and missing the rest, and the failures
 * that causes look nothing like a missing intermediate.
 */
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** What Chromium reads. One certificate per `certutil` call. */
const nss = (certificate, contents) => {
  mkdirSync(NSS_DATABASE, { recursive: true });
  const database = `sql:${NSS_DATABASE}`;
  attempt("certutil", ["-d", database, "-N", "--empty-password"]);

  const add = (named, path) => {
    attempt("certutil", ["-d", database, "-D", "-n", named]);
    run("certutil", [
      "-d", database, "-A", "-t", "C,,", "-n", named, "-i", path,
    ]);
  };

  /** Not PEM at all — DER, say — so hand the file over as it is. */
  const blocks = contents.toString("utf-8").match(PEM);
  if (!blocks) return add(nickname, certificate);

  blocks.forEach((block, index) => {
    const named = index === 0 ? nickname : `${nickname}-${index}`;
    const path = join(tmpdir(), `${named}.pem`);
    writeFileSync(path, `${block}\n`);
    try {
      add(named, path);
    } finally {
      rmSync(path, { force: true });
    }
  });
};

const contents = Buffer.from(base64, "base64");
const certificate = join(SYSTEM_CERTIFICATES, `${nickname}.crt`);
write(certificate, contents);

system();
nss(certificate, contents);

/**
 * Re-applied here as well as at build time, so a Firefox that Playwright
 * downloaded after the image was built still reads the system store.
 */
useSystemRoots();
