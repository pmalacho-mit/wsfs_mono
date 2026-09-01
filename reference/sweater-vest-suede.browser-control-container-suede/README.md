# Browser Control

This package ships a Docker image with Playwright installed and `playwright-cli`
available on `PATH` inside the container.

The preferred integration is the TypeScript API in `index.ts`, which builds and
runs the container for a selected browser.

## Preferred Usage

```ts
import { buildAndRun } from "./release/index.js"; // or use .ts extension if not using a bundler

await buildAndRun("chromium");
```

Supported browsers:

- `chromium`
- `firefox`
- `webkit`

The container idles after startup, so you can execute commands into it.

## Reaching a server the browser will trust

A browser only treats an origin as trustworthy when it is `https` or
`localhost`, and only a trustworthy origin is given the secure-context APIs:
`SharedArrayBuffer`, service workers, `crypto.subtle`, `getUserMedia`,
WebAuthn, persistent storage. A server reached at the devcontainer's address is
none of those, and a page that needs one of those APIs simply finds it missing.

`forward` makes a port reachable on the browser's own loopback address, which
is:

```ts
await buildAndRun("chromium", { forward: [5173] });
// the browser can now open http://localhost:5173, served by the devcontainer
```

A forward defaults to the devcontainer on the container's network. Name a
`host` to send it somewhere else, and a `target` to change ports on the way:

```ts
await buildAndRun("chromium", {
  forward: [{ port: 8080, host: "api.internal", target: 80 }],
});
```

Changing what is forwarded is a reason to replace the container, so
`skipIfRunning` only reuses one that already forwards the same thing.

Bind the server being forwarded to `0.0.0.0`. A forward dials the devcontainer
at whichever address a container on that network reaches it by, and under
docker-in-docker that is the network's gateway rather than the address the
devcontainer sees on its own interfaces — so a server bound to just the latter
has nothing listening where the forward arrives.

### Forwarding an `https` server

A forward is a TCP pipe rather than a proxy: it rewrites nothing, so the
browser performs the TLS handshake against the upstream while using `localhost`
as the name.

**The server's certificate has to cover `localhost`.** Trusting its root is
necessary but not sufficient — a certificate issued only for the devcontainer's
address fails on the forwarded route even when the root is fully trusted, and
the browser reports it as a trust failure rather than the name mismatch it
actually is. With mkcert, or Vite's HTTPS options, include `localhost` among
the names when generating the certificate.

For the same reason, a `host` pointing anywhere other than the devcontainer is
for plain `http`. No publicly issued certificate carries `localhost`, so an
`https` endpoint on another host cannot be made to validate through a forward.
Terminating TLS inside the container would be the way to support that, and is
not something this package does today.

## Certificates

A certificate this machine trusts — an intercepting proxy's CA, say — means
nothing to a browser in the container, which carries its own roots. Without it,
every cross-origin `https` request fails as a bare `TypeError: Failed to fetch`.

```ts
import { buildAndRun, certificates } from "./index.js";

await buildAndRun("chromium", {
  trustCertificates: await certificates.local(),
});
```

`certificates.local()` returns the extra roots this machine trusts
(`/usr/local/share/ca-certificates`), and is empty when there are none. Explicit
paths work too. Installing is idempotent, and also runs when a container is
reused, so a newly added certificate takes effect without replacing it.

Open the browser *after* installing, though. Chromium reads its certificate
database once, when it starts: a browser that was already running when the
certificate arrived goes on rejecting the origin, and only one launched
afterwards trusts it. Firefox and WebKit consult the system store per
connection and pick it up straight away. Since `buildAndRun` installs before
anything is launched, this only comes up when installing into a container whose
browser is already open.

Prefer `trustCertificates` to calling `certificates.install` yourself. Changing
`forward` is a reason to replace the container, and a certificate installed
out-of-band goes with the container it was installed into; one passed to
`buildAndRun` is reinstalled on every call, so it survives both replacement and
reuse.

`docker/trust.mjs` does the work. There are two stores to write to, not three:

| Browser  | Reads                                       |
| -------- | ------------------------------------------- |
| Chromium | an NSS database at `~/.pki/nssdb`           |
| WebKit   | the system store, via glib-networking       |
| Firefox  | the system store, via the module below      |

`certificates.test.ts` measures this against a certificate authority it
generates for the run, so nothing trusts it until it is installed and the
negative control means what it says. Every browser rejects the origin before,
and loads it after.

### Firefox reads the system store, once it is given somewhere to read it from

Firefox does not consult the system store on Linux; NSS answers from a loadable
PKCS#11 module named `libnssckbi.so`, sitting next to the binary. Playwright's
Firefox ships without one, and the mechanisms that would otherwise let a root in
are all unavailable in that build:

- **A profile's own `cert9.db`** is discarded — Playwright creates a fresh
  profile for every launch.
- **[Enterprise policies](https://mozilla.github.io/policy-templates/#certificates)**
  never run. Firefox deliberately ignores local policies on a Nightly build
  under automation, which is exactly what this is, and the provider Playwright
  patched in to replace them reads a single preference,
  `browser.policies.alternatePath`. Setting it changes nothing, because
  `policies-startup` is never fired and so nothing reads it.
- **AutoConfig** (`general.config.filename`) does not run either, whether the
  preference is set as a default in the installation or as a user preference in
  the profile.

`docker/roots.mjs` supplies the missing module: p11-kit ships one with the same
interface that answers from the system store rather than a compiled-in list.
Linking it in where NSS looks makes `update-ca-certificates` the single thing
deciding what Firefox trusts — the same store WebKit already reads. This is what
Debian's own Firefox packaging does.

It is applied at build time, so a container resolves roots the same way whether
or not a certificate is ever added, and again on install, so a Firefox that
Playwright downloaded after the image was built is covered too.

## CLI Usage

Build the image directly:

```bash
docker build --build-arg BROWSER=chromium -t browser-control-chromium:latest .
docker run -d --rm --name browser-control-chromium browser-control-chromium:latest
docker exec browser-control-chromium playwright-cli --help
```

Because `/app/node_modules/.bin` is on `PATH`, `playwright-cli` is available
without a full path.
