# TODO — what the backend does not do yet

The backend runs on Postgres, adjudicates every request through one choke
point, streams events derived from the version log, and is covered by `tests/`
running against a real database (`./tests/run.sh`).

Identity is client-minted end to end: a transaction id is the primary key of
the row it applies AND the CAS token for the property it changed, so a client
predicts its own tokens and chains a whole session's work offline with nothing
remapped server-side.

What the earlier plans called for and this design removed rather than built:

- **Event buffer table** — deleted. One applied mutation appends exactly one
  `Version`, so the versions of a workspace in position order *are* its event
  stream. No second write to fail independently of the first, and no retention
  job, because the rows are the truth rather than a copy of it.
- **Transaction record table** — deleted. An applied transaction IS the row it
  appended; a refused one is recorded nowhere, because nothing happened.
  `service.refusal()` is pure, so re-presenting a refused transaction
  recomputes its reason against the workspace as it stands. The "transaction
  older than retention → cannot reconcile" branch is unreachable and unwritten.
- **The `Version` table** — deleted, along with `Version.event` before it.
  Each log row records the workspace position it landed at, so current state
  is the newest row per log and the event kind is *which log the row is in*.
  A materialised combination row held nothing the four newest rows do not.
- **`Supersession`** (server-side token rewriting during outbox replay) —
  deleted. A client knows what its own queued work produces.
- **The `Created` response, and offline-create drafts** — deleted with it.
- **REPEATABLE READ for Initialize** — replaced by the controller's exclusion.

- **The stored position counter** — gone. The controller that owns a
  workspace seeds its counter from `max(position)` in the logs and writes it
  back nowhere, so a process that dies leaves nothing stale for its successor
  to be wrong about. It also removes the workspace row lock that sat under the
  lease as split-brain insurance; what replaces it is that events are grouped
  by the transaction that wrote them, not by the position they took.
- **The contentless entry** — gone. A create carries its content (a file's is
  required, a folder's is null), so every write presents a token that is
  really there and an offline create is one transaction, not two.

Server tables beyond the domain schema: **1** (stream tokens).

---

## 1. Shape of the shipped code

Done: `build_models` binds the schema to a host's user and workspace TABLES
(never their classes -- this package stores their ids and scopes by them, and
reads neither), `create_router` returns something a host mounts, and identity,
authorisation and workspace provisioning all belong to the host. `tests/host.py`
is a worked example. What remains:

```
[ ] blobs stream rather than buffer. The protocol is async now, but still
    passes bytes, so max_blob_bytes is a Content-Length check and a big upload
    is held in memory. Hashing while streaming fixes both
[ ] an object-store implementation of the protocol beside FilesystemBlobs
[ ] split main.py: the units of work (initialize_within / apply_within /
    content_response / follow / claim_token) are already host-callable and
    take no request object, so a host that wants its own routes should be
    able to import them without importing a router
```

## 2. Migrations

Done for the case that kept biting: `migrate.widen` adds columns the code
declares and the database lacks -- nullable, then filled, then constrained,
because adding a NOT NULL column to a table with rows fails outright and
adding one with a DEFAULT silently rewrites every existing row. It runs at
startup and says what it added. `create_all` alone made a schema change
silent until the first write, which happened twice.

```
[ ] alembic, or something like it, for the changes `widen` refuses: a column
    the code no longer declares (it may hold the only copy of something), a
    type that changed, a constraint that moved. Those refusals are correct
    and they are not a migration tool
[ ] For whoever writes it: `utc_offset` is declared on the abstract
    TransactionRow, so it lands on all FIVE logs -- wsfs_names,
    wsfs_parentage, wsfs_deletions, wsfs_text_content, wsfs_blob_content.
    Nullable, no default: "the client did not say" is a real answer and not
    the same as UTC
```

## 2b. An orphaned payload, deliberately left

```
[ ] `materialised` stores the whole text BEFORE it re-points the row at it,
    because promoting first and then failing to store destroys both readings
    of a queued write -- see the comment there. Dying between the two leaves
    one copy of one file's text in IndexedDB that nothing references: a leak,
    not a loss.
    COLLECTED NOW, and the two things that had to be true first are: `BYTES`
    rows carry a durable `at`, so "older than this pass" is a fact both tabs
    can read rather than a tab-local guess, and the pass takes a Web Lock so
    only one tab is ever deciding. See `reclaim.ts`.
```

## 2c. What a sweep still will not reclaim

```
[ ] Yjs documents. Compacting one -- rewriting it as `encodeStateAsUpdate` to
    drop tombstones -- costs nothing and can be most of a long-edited file.
    It needs enumerating databases this client did not create, and
    `indexedDB.databases()` does not exist in every browser the suite runs in,
    so there is no way to find them all. Needs a register of open documents
    before it can be done at all, let alone safely beside another tab
[ ] Queued rows the server has already answered but no stream event has
    carried. Freeing them means asking the authority "which of these have you
    written down", per workspace, which is a new endpoint. The yield is small
    -- for a workspace nobody is looking at, the rows were queued offline and
    the server has never seen them -- so it buys a `blocked` verdict more than
    it buys space. Worth doing when the space is shown to be there
[ ] Rows in `answers`. Three ids each, and NOT pruned -- pruning them against
    the confirmed map was a bug, because a transaction the map covers now is
    one it stops covering the moment something supersedes it. They accumulate
    for the life of a workspace. Bounding them needs a rule that does not
    depend on what is current, and there is not an obvious one
```

## 3. Blobs to object storage

```
[ ] S3-compatible store behind the same `Blobs` seam (holds / read / store)
[ ] hash while streaming rather than buffering; the size budget then stops
    being a Content-Length check
[ ] Content for binary -> presigned redirect instead of proxied bytes
[ ] garbage collection: a blob is unreferenced when no BlobContent names it.
    Parked -- blobs are cheap and deletion is the one irreversible operation
```

## 4. Scale, when measured and not before

```
[ ] workspace leases in the database, for when more than one process serves
    writes. A heartbeat table -- {workspace, owner, epoch, expires}, claimed
    by CAS and renewed for every owned workspace in ONE batched statement per
    tick -- not a held advisory lock, which costs a postgres backend per live
    workspace and caps them at roughly max_connections. The cost is that
    ownership becomes time-based, so a process frozen past the TTL can think
    it still owns a workspace; check the expiry locally before each
    submission, and lean on events being grouped by transaction rather than
    by position, which makes a collision ugly rather than wrong
[ ] cross-process bus: pg_notify at the choke point, one listener per process
    feeding controller fan-out for workspaces whose streams live elsewhere.
    The client contract, the splice and the frontend do not change at all
[ ] backpressure: a stream queue is unbounded, so a client that stops reading
    grows one. Bound it and drop the connection instead -- the sync loop
    re-enters through Initialize, which is what it does after any failure
[ ] Content responses carry an ETag but honour no If-None-Match
[ ] tree.lineage() walks one indexed query per level. Depth is capped at 64,
    so the cost is bounded, and a submission now memoises what it looked up,
    so the thousandth create into one folder walks nothing. A recursive CTE
    would trade the remaining per-level query for a scan of the workspace's
    current rows, which is worse until trees get deep
[ ] stream replay filters five logs by `position > P` and joins fs_entries to
    scope the workspace, so it reads rows belonging to other workspaces above
    that position. It was one log before and is five now. A workspace column
    on each log would make it a pure index range scan, at the cost of storing
    something derivable -- worth it only once measured.
    NOT a correctness question any more: `stream.since` takes the five reads
    at one snapshot (REPEATABLE READ), because read committed let a
    transaction committing mid-replay be seen in some logs and not others
[ ] `_spent_on` reads all five logs on every submitted transaction to answer
    "is this id spent". One round trip, and unavoidable while the answer must
    span logs the request would not write -- but it is on the hot path, and a
    single index over (id) across the logs would be the thing to measure
```

## 5. Deployment

```
[ ] Dockerfile whose CMD runs ONE worker, with the reason on the line above
    it -- and NOT via --workers, which the startup check cannot see
[ ] platform streaming timeouts will kill healthy SSE connections periodically;
    set them as high as allowed and budget for reconnect churn
[ ] ONE INSTANCE, and nothing in the code checks it beyond WEB_CONCURRENCY --
    which `uvicorn --workers 4` bypasses, since that variable is only the
    flag's default. Deliberate: it is what keeps postgres holding nothing on
    a workspace's behalf. Pin max-instances to one and mean it; when that
    stops being possible, the lease table in section 4 is the answer
[ ] tombstone retention: `tree.nodes` returns them because reconciliation
    cannot tell "deleted" from "unchanged" without them, so they must outlive
    the longest offline session. Write it down as a rule before anything
    prunes them
```

## 6. The client

```
[ ] everything in ARCHITECTURE.md §3 "Client-side" -- outbox, effective view,
    content cache, drafts, the sync loop, the Pyodide bridge
[ ] the torture harness the README describes: seeded fault injection
    converging on field-level equality with an empty outbox. The failure mode
    it can now reach that it could not before is "response dropped after the
    server applied a create"
[ ] the client renders unreachable entries at the ROOT rather than hiding
    them. `paths.walked` drops an entry whose ancestry is interrupted, so the
    index is right -- but nothing has been tested for the case where a folder
    is tombstoned while its children are open
[ ] blobs are never exercised by a browser test, because every one of them is
    text. A binary round trip through `crypto.subtle` and the workspace-scoped
    blob routes is the gap
```

## 7. Reading your own write

```
[ ] A CLIENT CAN READ A FILE AND BE TOLD WHAT IT SAID BEFORE THE WRITE IT JUST
    MADE. `workspace.write`/`shares` mints the transaction and returns
    synchronously, but the view that `read` answers from is derived from the
    OUTBOX -- `effective.of(map, queue.entries())` -- and the row does not
    join the queue until the payload has been hashed and stored. Between
    those two moments the file still says the old thing to its own author.

    Reproduce: type into a file, close the tab, and click it open again in
    the same frame. The panel opens on the text from before, and anything
    typed on top of that is written over the newer version. The UI soak in
    `Sample.test.svelte` does exactly this, which is why it now waits a beat
    before reopening -- see the comment there.

    Not fixed because the fix is in the write pump, where the ordering is the
    most safety-critical in the codebase: the row is captured before the
    bytes on purpose (bytes with no row are work gone unnoticed), the row
    carries the content digest, and the delta chain reads the tail. The two
    candidates:

      - capture the queue row synchronously and fill in its digest after, so
        the view has something to overlay from the first instant
      - keep a small "issued, not yet queued" overlay in `workspace.ts` that
        `recomputed` folds in and `flight.write` clears

    Both are real changes to how the outbox is written and want a second
    pair of eyes rather than an overnight commit.
```

## 8. Coming back to a file you closed

```
[ ] OPEN A FILE, TYPE, CLOSE IT -- AND LATER OPEN IT AGAIN, and its last line
    can appear twice while the line typed after reopening goes missing. At any
    distance, not only straight away: it reproduces with the file untouched
    for ten rounds in between. This is ordinary use, and it is why the UI soak
    in `Sample.test.svelte` never opens a file twice. Take `everFresh` out of
    that test and seeds 2, 3, 7, 13, 19 and 23 all show it.

    WHAT IS ESTABLISHED. A panel closed -- or a page left -- before its room
    is ready hands its text over as a WRITE, because no document holds it yet
    (`keepWhatWasTyped`). That is right, and it is what stopped the work being
    thrown away, but it puts the FILE ahead of the ROOM. The host repairs that
    on the next settle by CARRYING the difference in (`plan()` -> `Carry` in
    `release/backend/rooms.py`), which inserts the text as new items. When the
    room gains that line by any other route as well, both survive -- Yjs is
    right to keep them, they are two different insertions that happen to say
    the same thing -- and a line typed while the repair is in flight is lost
    with the reconciliation.

    WHAT IS RULED OUT, both by experiment rather than argument:

      - the client's persisted document. Disabling `recall` entirely does not
        change it, so this is not the browser's copy merging with the room's.
      - telling the host where the file stands only after the hand-over. That
        leaves `base` behind, and a room whose base is behind while its text
        is ahead is exactly what `Carry` is for -- so it makes the doubling
        reliable rather than rare. The comment in `Room.send` records it.

    WHERE TO LOOK. The question is what a room should do when the file is
    ahead of it and somebody is typing into it. `plan()` already declines to
    carry into a room whose text equals the file's; what it does not have is a
    way to carry a change in with the identity it would have had, or a reason
    to wait until the room is not being written to. Both are design decisions.
```
