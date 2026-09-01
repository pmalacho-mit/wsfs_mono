# Testing

Three suites, and they answer different questions. The browser one is the only
one that can tell you whether two people editing the same file end up with the
same file.

## Bringing the stack up

```bash
docker compose -f samples/compose.yml down
docker compose -f samples/compose.yml up -d --build
npm install                                 # the ROOT one: vite.config needs it
cd samples/frontend && npm install && npm run dev
```

Both installs are needed from a fresh checkout. `samples/frontend/vite.config.ts`
imports the editor's build helper, which resolves out of the **checkout root's**
`node_modules` — without it `vite dev` dies with
`Cannot find package '@codingame/esbuild-import-meta-url-plugin'`, which reads
like a missing dependency of the sample and is not.

**The sample database is `tmpfs`.** It wipes on every `sample-db` restart, which
is deliberate — but see *the migration gap* below, because it bit once.

**`/rendezvous` is not reset for you.** Nothing in the suite calls
`DELETE /rendezvous`, so a re-run against a backend that is still up meets the
previous run's agreed workspace and entry ids and quietly tests nothing. Restart
`sample-backend`, or:

```bash
curl -X DELETE http://localhost:8099/rendezvous
```

**`git diff` hangs in this checkout.** `diff.external = difftastic` is
configured and does not return here, so a full patch blocks forever while
`git diff --stat` works fine. Use `git diff --no-ext-diff`. This cost real time
to work out, because it looks exactly like the wedge below.


## The browser suite

### `--silence` is the flag you will actually need

**The default silence window is 120s, and it is too short for this suite.** The
window is time since *any* browser last said anything, and the report gives up
with `Report server timed out` — which reads exactly like a hang and is not one.
A single cascading failure can burn well over 120s of quiet, and that is how the
third session's first two full runs died having proved nothing.

```bash
npm run test:browser -- --component Shared --browser chromium --browser firefox --silence 180
```

### Run the scenarios one at a time

This is the single most useful change to how the suite is driven. The cascade
described under *Known problems* is real — one test dying desynchronises the
pair and the partner times out on a barrier a test later — and it makes a full
run's output nearly unreadable. `--test` takes a regex, and a paired single
scenario runs in **four to eight seconds**:

```bash
npm run test:browser -- --component Shared --test "holds a store" \
    --browser chromium --browser firefox --silence 180
```

`curl -X DELETE http://localhost:8099/rendezvous` between runs. Every result in
the table below was produced this way.


## The other suites

```bash
./tests/run.sh                                   # backend, against a real postgres
npx vitest run                                   # client logic, no network
WSFS_BACKEND=http://localhost:8099 npx vitest run tests/frontend/live.test.ts
cd samples/frontend && npm run check             # svelte + types
```

And the measurements, which assert nothing and are only worth taking against
a running stack:

```bash
WSFS_BACKEND=http://localhost:8099 npx vitest run performance
CLIENTS=200 WORKSPACES=20 WRITERS=20 python tests/load.py
```

### The docker wedge — found, and fixed

**It happened twice, and both times while the two browser-control containers
were being created at once.** That was not a coincidence and it was not bad
luck; it was the driver.

`generateReport` in `sweater-vest-suede/report/index.ts` prepared its browsers
with `await Promise.all(browsers.map(prepare))`, and `prepare` does not merely
start a container — **it builds the image**. So a two-browser run put two
`playwright install --with-deps` builds and then two `runc create`s in flight at
once, which is exactly the state the daemon died in. `prepare` is now a serial
loop, with the reasoning recorded beside it. **About twenty container creates
across the third session, no wedge.**

**The advice that used to be here — warm the containers one at a time so the
two-browser run can attach — was half wrong, and worth knowing why.** The
`finally` block removes both containers on every run, so `skipIfRunning` never
fires across invocations and a warmed container never survives. What warming
actually buys is the **image**, which is cached and is the expensive part. So
warming one browser at a time is still right for a first-ever run, and it is
the images you are protecting, not the containers.

**How to recognise it, if it ever comes back.** Every docker client hangs,
including `docker ps`, and `timeout` and `kill -9` do nothing to them — check
`ps` and you will see them in state **`D`**, uninterruptible sleep. `dockerd`
and `containerd` are both still alive; a raw `curl --unix-socket
/var/run/docker.sock http://localhost/_ping` hangs too, and that is the cheapest
endpoint there is. It is not resource exhaustion: disk and inodes were at 9% and
4%, and 34G of memory was free. Load average climbs anyway, because `D`-state
processes count towards it. **There is no recovery from inside the
devcontainer** — the daemon has to be restarted from outside.

**Still don't poll `docker ps` while a browser run is starting.** It tells you
nothing the run's own output does not, and each poll leaves another unkillable
process behind if the daemon is already gone.

**Don't pipe a run through `tail`.** `npm run test:browser ... | tail -80` shows
nothing at all until the run ends, so a run that hangs is indistinguishable from
a run that is working. Redirect to a file and read it.

