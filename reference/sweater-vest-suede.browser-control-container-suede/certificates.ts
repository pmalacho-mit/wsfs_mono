import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { container } from "../browser-control-container-suede.programmatic-docker-suede";

/** Where a Debian-family system keeps roots added on top of the distribution's. */
const LOCAL_CERTIFICATES = "/usr/local/share/ca-certificates";

const isCertificate = (name: string) => /\.(crt|pem)$/i.test(name);

const nicknameOf = (path: string) =>
  basename(path, extname(path)).replace(/[^A-Za-z0-9._-]/g, "-");

export const certificates = {
  /**
   * Extra roots this machine trusts, such as the CA of an intercepting proxy.
   * Empty when there are none, or when the directory does not exist.
   */
  local: async () => {
    try {
      const names = await readdir(LOCAL_CERTIFICATES);
      return names.filter(isCertificate).map((name) => join(LOCAL_CERTIFICATES, name));
    } catch {
      return [];
    }
  },

  /**
   * Adds certificate files, by path on this machine, to every store the
   * browsers in the container read — see `docker/trust.mjs`, which knows which
   * those are. Adding the same certificate twice is harmless.
   */
  install: async (target: string, paths: string[]) => {
    for (const path of paths) {
      const base64 = await readFile(path, "base64");
      const { exit, err } = await container
        .exec(target, ["node", "/trust.mjs", nicknameOf(path), base64])
        .complete();
      if (exit !== 0)
        throw new Error(`Could not trust ${path} in ${target}: ${err}`);
    }
  },
};
