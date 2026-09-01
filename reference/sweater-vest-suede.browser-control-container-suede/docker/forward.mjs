import net from "node:net";

/**
 * The container's idle process, which also forwards ports onto the container's
 * own loopback address.
 *
 * A browser only treats an origin as trustworthy when it is https or localhost,
 * and only a trustworthy origin is given SharedArrayBuffer, service workers,
 * crypto.subtle, and the rest of the secure-context APIs. A dev server reached
 * at the devcontainer's address is none of those; the same server reached
 * through a forward is.
 *
 * `FORWARD` is a comma separated list of `<port>:<host>:<port>` entries.
 */
const parse = (entry) => {
  const [port, host, target] = entry.split(":");
  return { port: Number(port), host, target: Number(target) };
};

const forward = ({ port, host, target }) =>
  net
    .createServer((browser) => {
      const server = net.connect(target, host);
      browser.pipe(server);
      server.pipe(browser);
      browser.on("error", () => {});
      server.on("error", () => {});
    })
    /**
     * Without this, a port that cannot be bound — a duplicate entry, or
     * something already listening — raises an unhandled `error` out of PID 1
     * and takes the container with it. The container is then removed on stop,
     * so the next thing to touch it fails with "no such container", pointing
     * nowhere near the cause. Reporting it and leaving the container up keeps
     * the other forwards working and the reason visible in `docker logs`.
     */
    .on("error", (error) => {
      console.error(
        `forwarding localhost:${port} to ${host}:${target} failed: ${error.message}`,
      );
      process.exitCode = 1;
    })
    .listen(port, "127.0.0.1", () =>
      console.log(`forwarding localhost:${port} to ${host}:${target}`),
    );

(process.env.FORWARD ?? "")
  .split(",")
  .filter(Boolean)
  .map(parse)
  .forEach(forward);

/**
 * As PID 1 there is no default signal disposition, so without these `docker
 * stop` waits out its full timeout before resorting to SIGKILL.
 */
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => process.exit(0));

setInterval(() => {}, 1 << 30);
