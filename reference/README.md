# Wsfs Suede

A workspace filesystem for a browser-based, collaborative, Python-in-the-browser
platform. Versioned files on a server, live co-editing in the browser, and a
rule about which of those two is allowed to speak at any moment.

The goal it is built around, in priority order: **a user never loses work**,
and where loss is possible it is surfaced rather than silent. Everything else —
the CRDT, the outbox, the drafts, the version tokens — exists to serve that.

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede). The
installable source is on the
[release branch](https://github.com/pmalacho-mit/wsfs_suede/tree/release).

```bash
bash <(curl -fsSL https://suede.sh/install/release) --repo pmalacho-mit/wsfs_suede
```

<details>
<summary>
See alternative to using <a href="https://github.com/pmalacho-mit/suede#suedesh">suede.sh</a> script proxy
</summary>

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pmalacho-mit/suede/refs/heads/main/scripts/install/release.sh) --repo pmalacho-mit/wsfs_suede
```

</details>

---

## What to read

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | the design: the two planes, the vocabulary, the invariants, and the six findings that shaped it |
| [`SCENARIOS.md`](SCENARIOS.md) | what it must do — every state two clients and a server can be in, and the decisions taken against them |
| [`AUDIT.md`](AUDIT.md) | what it demonstrably does — coverage, measurements, and what is still weak |
| [`docs/TESTING.md`](docs/TESTING.md) | how to run any of it, and the traps |
| [`TODO.md`](TODO.md) | what is deliberately not built |

## Layout

    release/backend/     the package a host mounts: adjudication, the event
                         stream, refusals and drafts, reconstruction
    release/frontend/    the client: outbox, sync loop, effective view,
                         content cache. Types generated from the backend's
                         contract, so the two cannot drift
    samples/backend/     a worked example of mounting it, plus everything
                         Liveblocks-shaped: room keeping, seeding, relaying
    samples/frontend/    a SvelteKit app that uses it, and the browser suite
    tests/              backend tests against a real postgres, client tests
                         against a fake one, and measurements against neither

Everything about the collaboration server lives in `samples/`. `release/`
knows nothing about Liveblocks, or about rooms.

## The four rules

1. **Content that came out of an editor moves as a Yjs update, never as
   text.** Typing text into a document creates new characters, so the same
   work arriving twice survives twice. Only content that was never in an
   editor is diffed in, and that is safe because no second copy of it exists.
   `write` refuses an entry a document speaks for, so this is enforced rather
   than remembered.
2. **The server is the only writer of a room's `base`, and the only party
   that carries text into a room.** Clients type and store; they never
   reconcile.
3. **A client whose text has reached nobody does not store it as the file.**
   It keeps it as a draft — durable, addressable, and asserting nothing about
   what anybody else is looking at.
4. **Every transaction this client makes reaches the server**, once the user
   gets back to the workspace it belongs to. The queue is written down — a row
   per transaction, scoped by workspace — so it outlives the page that made it
   AND the user navigating somewhere else, which matters because a queue is
   drained by the stream of its own workspace. Drafts are members of it like
   anything else: one can be part of a snapshot somebody took at that moment,
   so nothing supersedes and nothing is dropped.

## Run it

```bash
docker compose -f samples/compose.yml up -d --build
npm install && cd samples/frontend && npm install && npm run dev
```

See [`docs/TESTING.md`](docs/TESTING.md) for the suites, and read the docker
section there before running the browser tests for the first time.
