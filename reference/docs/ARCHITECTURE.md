# Workspace Filesystem & Sync Architecture

A browser-based, collaborative filesystem backing a Python-in-the-browser
platform. Design goals, in priority order: **a user never loses work** (and
when loss is possible, it is surfaced, never silent); robust to momentary
network lapses; live collaborative editing of text; efficient storage of both
text and binary content; boring, auditable failure recovery.

This document is the map: every system at play, the vocabulary, the state
machines, the flows, and the invariants that hold it together.

**The wire contract is `release/backend/contract.py`, and it is the only
place those shapes are declared.** The client's types are generated from it.
There used to be a second copy here, written as TypeScript, with diagrams
generated from that; by the time anybody checked, it disagreed with the real
one about what a draft was. A contract with two spellings does not stay one
contract, and the pictures drawn from the wrong spelling were worse than no
pictures.

What the system must DO is enumerated in `../SCENARIOS.md`, one row per state
two clients and a server can be in. What it demonstrably does is `../AUDIT.md`.

---

## 1. The two planes

The single largest architectural fact: there are **two sync planes**, and
they are deliberately kept apart.

**The collaboration plane (yjs / Liveblocks).** Character-level, multi-writer,
CRDT-merged live editing of open text files. One `Y.Doc` per open file, one
Liveblocks room per open file, persisted locally via y-indexeddb, attached
only while an editor holds the file open. CRDTs are used here and *only*
here, because this is the only place writes are genuinely concurrent and
peer-shaped.

**The room's document holds text and nothing else.** Which stored version
that text descends from is bookkeeping, and it lives on the host — putting it
in the document made advancing it a write, so one person saving cost a round
trip to Liveblocks for every client that heard.

**The authority plane (this protocol).** Server-authoritative,
single-ordered-stream sync of the tree (names, parents, deletions) and of
content commits. Postgres is the source of truth; clients submit transactions,
the server adjudicates them, and all state flows to clients through exactly
one ordered channel.

The planes meet at three seams, and the design's health depends on them
staying this thin:

1. The **read flow priority** (§6.1): a live yjs doc outranks everything.
2. The **write-failure policy**: a content-write failure is ignored when a
   live editor is open, because the doc is the truth there.
3. **The host fills rooms, and is the only thing that carries text into
   one.** A client that reads its file, diffs it and types the difference in
   creates NEW characters, so when the original author's edits arrive the
   file says everything twice. Content authored in a document therefore moves
   only as Yjs updates; only content that was never in a document — a
   kernel's output, an upload — is ever diffed in, and that is safe precisely
   because no second copy of it exists.


---


## 2. Vocabulary

**Entry** — a node in the tree: `{id, name, parent?, deleted?}` plus one
version token per property, type `file` or `folder`. Metadata is deliberately
*pure namespace*: it carries no content descriptor. **Client-minted ids**: the
client chooses an entry's id before it asks for the entry, which is what makes
creating one offline an ordinary queued transaction rather than a special case.

**Version** — an opaque token naming one state of *one property* of an entry:
its name, its parent, its deletion, or its content. Comparable by *equality
only*; it is a compare-and-swap (CAS) token, not a counter. There is no such
thing as a version of a whole entry — only four tokens that move independently.

A version token is the **id of the transaction that last set that property**.
The client minted that id, so it knows what token its own work will produce
before the response arrives — which is what lets it chain a whole session's
work offline with nothing remapped server-side. Splitting tokens by property
is what keeps that from over-firing: a collaborator's write moves the content
token and nothing else, so your pending rename still applies.

**Identity** — every id crossing the wire is client-minted with a platform
CSPRNG (UUIDv7 preferred). The server never remaps: an entry id already in use
is a typed refusal, because a remap would reintroduce the local-id → server-id
table that client-minted identity exists to delete.

**Content plane** — kind (`text` | `binary`), mime, size, hash. Revealed by
`Content` fetches, cached client-side per entry id, invalidated by stream
signals. Never present in entry metadata.

**Blob** — immutable bytes named by their sha256 hash. Content-addressing
gives dedup, integrity checking, free retry-idempotency, and "old versions
cost only distinct bytes."

**Transaction** — one client-initiated mutation, identified by
`${client}:${counter}`. Globally unique (client is a GUID), and
order-encoding (counter is strictly increasing per client).

**Client** — one browser tab's instance of the system, identified by a GUID
minted at page load. One client = one transaction counter = one outbox queue
= one sync loop.

**Session** — a GUID minted per page load, stamped on outbox entries to
distinguish "this session already rendered this optimistically" from
"survived a reload, definitely not reflected in the UI."

**Occurrence** — when one transaction happened, in *both* clocks that saw it:
`{minted?, offset?, accepted}`. `minted` is the client's, and it is when the
user acted; `accepted` is the server's, and it is when the change entered the
workspace. An offline week puts days between them, so neither is the other's
approximation, and the server's is the one to trust when a client's clock is
wrong.

`minted` is never sent. A transaction id is a UUIDv7 minted the moment the
user acts, so the millisecond is already in the primary key and the server
reads it back out — and since every version token *is* such an id, the
client-side time of any one property change is derivable client-side with
nothing on the wire. `offset` is the one part that cannot be derived: a v7's
timestamp is an *instant*, identical in Cupertino and in Berlin, so it says
nothing about the clock the user was reading. It travels on each **request**
rather than on the connection, because an outbox filled offline in one zone
may only be replayed after landing in another, and each item has to keep its
own. An entry's metadata carries the occurrence of its newest change as
`modified`; a stream event carries its transaction's as `at`.

**Position** — the server-internal, per-workspace, monotonic stream position.
Orders the event stream and anchors tokens. *Never client-visible.*

**Token** — a single-use, ~60s-TTL credential minted by `Initialize`, bound
to `{user, workspace, position}`. Connecting the stream claims it atomically;
the stream replays events after its position before going live.

**Draft** — a write the client asks not to be made the file's content,
because its text has reached nobody else. Recorded on the SERVER beside the
refusals, keyed by its transaction, readable at that transaction, and
retained. It carries no version and cannot conflict.

It is what a client does instead of storing while it is reaching nobody.
Storing then would either lose the text — the next store from somebody else
would not contain it — or have the host carry it into their documents, where
this client's own copy would arrive and say it twice. A draft asserts nothing
about what anybody is looking at, and it makes a snapshot naming it portable,
which is the whole reason it is on the server rather than on the machine that
could not reach anybody.


---


## 3. System inventory


### Client-side

**Confirmed map** (memory) — `Map<id, Entry.Metadata>`; the client's replica
of server truth. Mutated *only* by `Initialize` snapshots (replace-all) and
stream events. Never by request responses.

**Outbox** (IndexedDB, `kept.ts` + `indexed.ts`) — the queue of transactions
the server has not answered, written down as **a row per transaction, scoped
by workspace**. Two consequences, both deliberate: a queue survives the page
that made it, and it survives the user navigating to a DIFFERENT workspace —
which it must, because a queue is drained by the stream of the workspace it
belongs to and a client follows one at a time. A row per transaction rather
than a document per workspace is what lets two tabs append and remove
without either writing back a version that forgot the other's work.

Beside it, a content-addressed bytes store (hash → bytes, also per workspace)
holding write payloads so the queue itself stays rows-of-pointers. Bytes are
released only against what is WRITTEN DOWN, never against one tab's queue.

`connect` takes the two as `kept` and `restored`; say nothing and the queue
lives and dies with the page.

**Effective view** (derived, never stored) —
`effective(id) = outbox.replayOver(confirmed)`. What the UI and the Pyodide
filesystem actually read. Optimistic updates are *derived*, not applied;
failure rollback is recomputation, not an operation.

**Content cache** (memory) — per-entry-id cache of `Content` responses, keyed
by the version an entry is currently at and invalidated by `write`/`delete`
stream signals. In memory on purpose: everything in it can be fetched again,
which is exactly what is not true of the outbox beside it.

**Yjs doc registry** (memory + y-indexeddb) — refcounted `Y.Doc` +
Liveblocks room per *open* text file; "detach" means leave the room, never
forget unsynced work (teardown waits for flush).

**Sync loop** — one per client per workspace; the single driver of
Initialize → evict/replace → stream → backoff → repeat (§6.4).

**Pyodide bridge** — the sync-over-async seam: the worker's synchronous FS
calls are served by the main thread against the effective view + content
cache, with hard deadlines so a hung fetch can never wedge the
Atomics-blocked worker.


### Server-side

**Postgres, tables of record** — an entry is pure identity, and each of its
four properties is an append-only log: names, parentage, deletions, content
(text as deltas, binary as hash pointers). Every row records the workspace
position it landed at, and current state is the newest row per log.

Four things that would ordinarily be separate tables are not:

- **No transaction record.** An applied transaction *is* the row it appended:
  its client-minted id is that row's primary key, so dedup is primary-key
  identity rather than a secondary index somebody has to remember to keep.
- **No refusal record.** Adjudication is a pure function of the workspace, so
  a refused transaction is recomputed rather than remembered — and the reason
  it produces is measured against the workspace as it stands, which is the one
  the client can act on. Nothing was applied, so there is nothing to store.
- **No event buffer.** One applied transaction takes exactly one position, so
  the rows of a workspace in position order *are* its event stream — and
  *which log* a row is in is which event it was. Nothing to retain, nothing to
  drift, and nothing to derive by comparing a row against its predecessor.
- **No version row.** A materialised "the entry looked like this" row would
  hold only what the four newest rows already say. Only a create writes more
  than one log at a position, which is what tells a birth from a change.

The one table beyond the domain schema is the **token table** —
`{token, user, workspace, position, expires}`, claimed by `DELETE ...
RETURNING` on stream connect.

**The choke point** — the one code path every mutation flows through, and by
now it is three lines: take the next position, stamp it onto the rows the
transaction appends, append them. One database transaction, serialized per
workspace by the controller. There is no event log to generate, because those
rows are it.

**Workspace controller + registry** — one controller per workspace per
process (the actor pattern). All writes — transactional requests AND
Initialize — flow through its serialized `submit()`, which fans committed
events out to subscribed streams after commit. Initialize's one-consistent-
view guarantee comes from this exclusion, not isolation levels. Reads
(Content, blobs) bypass it. Lifecycle: streams refcount it, mutations are
held for the duration of one (because they carry the position counter),
release is grace-delayed (~30s) so reconnect churn doesn't thrash it, and one
registry lock guards get-or-create AND release (re-checking the count inside
the lock) against the release/acquire race. Controller memory is
rebuildable-from-zero: Postgres remains the truth, and a controller taking a
workspace on reads its position out of the logs.

Nothing about a workspace is held open in the database — no lock, no
connection, no row. Live workspaces therefore cost the database nothing, and a
thousand of them cost exactly what one does.

**SSE handler** — claim token → subscribe → replay events after the token's
position → follow live, with comment heartbeats (~15s).

**Blob store** — object storage keyed by hash; `PUT /workspaces/{workspace}/blobs/{hash}` verifies
the hash and no-ops on duplicates.


### Third-party

**Liveblocks** — rooms, yjs sync protocol, presence — for open text files
only. Its footprint in the system is exactly the multi-writer surface.

---

## 4. State machines

### 4.1 Transaction lifecycle

| State | Meaning | Transitions out |
|---|---|---|
| **captured** | Persisted to outbox *before* the request is sent | → in-flight (sent) |
| **in-flight** | Sent, no response yet | → applied / rejected (response or stream echo or Initialize verdict); → captured (timeout: remains queued) |
| **applied** | Server committed it | → evicted (confirmed change and overlay removal cancel exactly; no flicker) |
| **rejected** | Typed failure | → evicted, routed to failure policy (§7); content-bearing rejections may also → draft |
| **evicted** | Removed from outbox | terminal |

Eviction triggers, any one suffices: response received; own transaction id
echoed on the stream; reported in `Initialize.applied`/`rejected`.


### 4.2 Entry lifecycle

| State | Meaning | Transitions |
|---|---|---|
| **absent** | No such id | → live (Create; the client already holds the id, so the ack carries nothing — the entry enters the confirmed map only via the stream's `create` event) |
| **live** | In the tree | → live (rename / reparent / write, each advancing ONE property's token); → tombstoned (delete) |
| **tombstoned** | `deleted: true`; remains in snapshots | terminal (a "restore" is a fresh Create) |

Tombstones are load-bearing: reconciliation cannot distinguish "deleted"
from "unchanged" without them.

**Deleting a folder tombstones the folder, not its contents.** Its children
keep their `parent` pointers and are never touched, so there is a fourth state
the table above cannot show because it is not a state of the entry at all:
**unreachable** — live, present in every snapshot, and cut off from the root by
a tombstone somewhere above it. No event fires for those children, because
nothing about them changed.

**Computing reachability is the client's job, and it is not optional.** An
entry is reachable when every ancestor up to the root exists and none of them
is tombstoned; a client that renders `deleted !== true` alone draws entries
that are gone. It has to be recomputed after every `delete` and every
`parent`/`move` event, since either can sever or restore a whole subtree at
once. The server does exactly this walk — it is how a create into an
unreachable folder is refused — and it exposes no shortcut: a reachability
flag in a snapshot would go stale on the first event after it, which is worse
than not having one. See `Entry.Metadata.deleted` in the contract.


### 4.3 Draft lifecycle

| State | Meaning | Transitions |
|---|---|---|
| **kept** | Recorded on the server, not the file's content. Its transaction names it and can be read at it | → cleared (the work reached the others) |
| **cleared** | Marked as work that has since got out. The row stays — a snapshot may still name it | terminal |
| **uncleared and old** | Nobody ever said this got out, and the machine that made it may never come back | reported by `GET /workspaces/{id}/drafts` |

Created because this client's updates had not reached the room; cleared when
they have. The same predicate, flipped, and both decidable locally — but the
flag is the SERVER's, because the case worth reporting is the machine that
never came back, and a note kept only there goes with it.


### 4.4 Sync-loop connection states

| State | Meaning | Enters via | Leaves via |
|---|---|---|---|
| **cold** | No confirmed state | page load | cached (IDB tree loads) or live (Initialize succeeds) |
| **cached** | Serving last-known-good; possibly stale | stream failure, offline start | live (loop re-enters successfully) |
| **live** | Snapshot applied, stream established, heartbeats flowing | successful cycle | cached (error event or watchdog expiry) |
| **degraded** | Acks succeed but stream can't establish (proxy eats SSE) | watchdog + successful POSTs | live (stream recovers); loop degrades into polling meanwhile |

Cold start, reconnect, and recovery are the *same* path: every disruption
re-enters the loop at Initialize.


### 4.5 Yjs doc lifecycle (per text file, per client)

closed → **attaching** (y-indexeddb loads first — instant local state — then
the room connects; CRDT merge reconciles) → **open** (refcounted) →
**flushing** (last reference released while unsynced changes exist: stay in
the room until the server has everything) → **closed** (local state kept as
warm cache) or **evicted** (file deleted: local state wiped, so stale CRDT
state can never resurrect).


---

## 5. Content model

Content is per-version and typed at write time: a `Write` is `text`
(inline string) or `binary` (hash + size + mime, bytes previously `Store`d).
A write of the other type *is* the kind transition — there is no separate
transition machinery in this design; the next `Content` fetch reveals the
new kind and the client re-routes accordingly.

Reads route on the *cached* kind; the `write` stream signal invalidates both
content and kind, so a stale route self-corrects on the next fetch. Offline
with a cold cache, kind is honestly UNKNOWN and the UI says so.

Live-editability is a client-side determination (text kind + within size
budget + editor opened), not a server-side state.


---

## 6. Data flows


### 6.1 Read (`readFile`, called by the Pyodide bridge or a viewer)

1. Live yjs doc open for this file on this client → serve the doc.
2. Content open in an *active* non-yjs editor (visible/dirty this session,
   not merely mounted) → serve that buffer.
3. Content cache hit for this id → serve it.
4. Fetch `Content` (deadline-bounded), populate cache, serve.
5. Offline/failed → clean filesystem error through the bridge. Never a hang.


### 6.2 Write (`writeFile`)

Route on cached kind. Text + live doc → apply as a minimal yjs diff (one
delete + one insert around the common prefix/suffix) so concurrent human
edits merge instead of being clobbered. Otherwise → capture transaction to
outbox → (binary: `Store` bytes by hash first) → submit `Write` with the
entry's current version (CAS). Failure routes per §7.


### 6.3 Create

Mint an entry id and a transaction id → queue the request like any other →
dependent operations may proceed against that id immediately, online or off →
the stream's `create` event populates the confirmed map. A lost ack is retried
with the *same* transaction id and the *same* entry id; the server answers from
the row it already appended rather than minting a second entry.

A create carries the entry's content: a file is born with it, a folder is born
without, and neither is optional — an "empty file" is something a client says
rather than something it omits. So an entry never exists in a contentless
state, every Write has a real token to present, and a Pyodide computation
finishing offline is one queued transaction instead of two.

The typical gesture is "new file, then type its name", so the client sends a
placeholder name and opens the name field for editing straight away — blank,
VSCode-style. Filling it issues a rename; leaving it blank issues a delete.
Both name the entry by the id the client minted, whether or not the create has
been acknowledged yet.

A name collision on create is **renamed, not refused**: a create has no prior
version to compare against, so refusing it would be the only thing standing
between two offline clients and a lost `notes.md`. The create lands under the
name it asked for and the controller renames it — two events, a `create` then
a `name`, both arriving through the one door. A rename IS refused on
collision: there the user typed a specific name and deserves to be told.

**Names settle at the end of the unit of work, not at the create.** One
controller submission is one database transaction, so for a single online
create that is immediately afterwards — but for a replayed outbox it is after
every queued transaction has had its say. That matters for the ordinary
offline gesture: create `notes.md`, then type `report.md` over it. By the time
names settle the entry is called `report.md`, nothing collides, and the
controller issues no rename at all. The typed name simply wins.

Two consequences worth knowing. First claim wins: when two entries do arrive
holding one name, the one whose name row is older keeps it. And within a
replay two live siblings may briefly share a name — which is never observable
as a wrong answer, because a create only settles away from its name when
somebody claimed that name first, and that earlier claimant still holds it
afterwards.


### 6.4 The sync loop

```
loop:
  POST Initialize(workspace, outbox transaction ids)
    → server, in ONE repeatable-read transaction: adjudicate outbox in
      order (unseen ones applied now), snapshot entries, read position,
      mint token
  evict applied/rejected; replace confirmed map   // same server tx → no gap, no flicker
  connect EventSource with token                   // single-use; claims atomically
    → server replays events after token.position, then follows live
  consume events until error / watchdog expiry
  jittered exponential backoff (reset only on an established stream); re-enter
```

Never rely on EventSource auto-reconnect (it replays a spent token). Also
re-enter on `visibilitychange`-to-visible and `online` — Initialize with an
empty outbox is a cheap no-op.


### 6.5 Blob transfer

Upload: `PUT /workspaces/{workspace}/blobs/{hash}` with raw bytes; server verifies sha256; duplicate
hash → immediate ack (retry-safe by construction). Download: raw bytes with
`Content-Type` and `ETag: {version}` (or redirect to object storage).


---

## 7. Failure policy (client's decision, by design)

| Failure | Policy |
|---|---|
| Content write conflict, live editor open | Ignore — the yjs doc is the truth; all text mutations flow through it |
| Text write conflict, no live editor | Diff editor: fetch `Content` at the conflicting version for the other side |
| Write to a deleted entry | Evict transaction; keep the content as a draft |
| Create offline | Queue it — the id is the client's to mint. Nothing to park, nothing to disable |
| Move / rename / delete rejected | Evict; effective view snaps back automatically |
| Store hash mismatch / too large | Surface; do not retry blindly (the bytes are wrong or oversized, not the network) |
| Content fetch offline, cold cache | Clean filesystem error (deadline-bounded), never a wedge |

### 7.1 Saying so

`Room.trouble` is reactive `$state` and names, in one sentence, whatever stops
the room writing the file back: *this file is not text any more* (not passing —
what you were editing is gone), *still handing over what you typed*, *not
reaching anybody*, *catching up*. `undefined` means the room speaks.

The passing three are the same condition `send` refuses on, so the sentence a
user reads and the sentence recorded on the draft are one string from one
place. The rule itself is `rooms.speaking` in the release package — the
banner does not restate it.

Typing while out of touch is safe: it is kept, and it goes when the room comes
back. Being told is not a warning, it is the difference between that and
assuming your work is where everybody else's is.

---

## 8. Invariants — the rules that must never be broken

1. **One door for state.** The confirmed map changes only via Initialize
   snapshots and stream events. Responses only adjudicate the outbox. The
   There is no exception: a create's id came from the client, so an ack
   has nothing to add.
2. **Initialize is one database transaction.** Adjudication, snapshot, and
   token position together, or the no-flicker/no-gap guarantees silently die.
   Do not let anyone "optimize" it apart.
3. **Event log generated from the truth.** Position bump, mutation,
   transaction record, and event row commit atomically at the choke point.
   There is no publish step that can fail independently.
4. **Capture before send; park before raise.** A transaction is persisted to
   the outbox before its request is sent, and a room that cannot reach
   anybody keeps its text as a draft rather than storing it. Ordering is what
   saves the bytes.
5. **Order is sacred in the outbox.** Counter order in, counter order out;
   coalescing is per-entry, writes-only, boring, and unit-tested.
6. **Versions are equality-only, per-property CAS tokens.** No client-side
   "newer than" reasoning exists; staleness is resolved by re-entering the
   loop. A token that was never issued at all is a *different class* of
   failure from a stale one — it means the client's state is unsound, and the
   only sound response is to discard it and re-Initialize.
7. **Detach never discards.** A yjs doc with unsynced changes stays attached
   in the background until flushed; eviction (deletion) is the only path
   that wipes, and it always wipes.
8. **Deadlines everywhere the worker blocks.** A hung network call surfaces
   as a filesystem error; the Atomics-blocked kernel never wedges.
9. **Conflicts are never silent.** Rejected work is surfaced (diff, snap-back,
   draft); concurrent blob commits fail CAS rather than last-write-wins.
10. **Blobs are immutable; hashes are forever.** A cached blob by hash can
    never be wrong — only pointers go stale.
11. **One process serves a deployment.** "One controller per workspace" is
    only true within a process, and positions are counted in that process's
    memory — so a second process serving the same workspace hands out numbers
    the first has already used. This is the first invariant a deployment
    engineer can violate without touching code (`--workers 4`, an
    autoscaler's max-instances > 1).

    **Nothing in the code enforces it.** There is one guard, and it is
    partial: the startup check reads `WEB_CONCURRENCY`, which is where the
    mistake usually lives but not always — `WEB_CONCURRENCY` is only uvicorn's
    default for `--workers`, so an explicit `--workers 4` sets nothing there
    and starts four processes anyway. Running one instance is the operator's
    promise, deliberately, and this is what it buys: the database holds no
    lock, no lease and no connection on any workspace's behalf, so a live
    workspace costs nothing to keep and their number is bounded by memory
    rather than by `max_connections`.

    What breaking it costs: two processes each counting positions from their
    own reading of the logs, handing out the same numbers. Because events are
    grouped by the transaction that wrote them rather than by position, the
    result is a stream that is out of order rather than one that means the
    wrong thing — but it is still wrong, and nothing will say so.

    Making it the database's promise means a lease table with a heartbeat, not
    a held lock: a held advisory lock costs one postgres backend per live
    workspace, which is the ceiling this design exists to avoid. That, and a
    cross-process bus behind the controllers, is the upgrade path when scale
    demands it.

---

## 9. The honest accounting

| Concern | Count |
|---|---|
| Request types | 7 (Create, Delete, Rename, Reparent, Store, Write, Content) + Initialize |
| Stream event types | 5 (create, write, delete, name, parent) |
| Client loops | 1 per client per workspace |
| Server tables beyond the domain schema | 1 (stream tokens) |
| Client persistent stores | 2 (outbox + bytes-by-hash, y-indexeddb per open doc) |
| Server tables beyond the domain schema and drafts | 1 (rooms: created, and where each stands) |
| Derived client state | 2 (confirmed map, effective view) |
| Third-party dependencies in the sync core | 0 (Liveblocks serves only the collaboration plane) |
| Seams between the two planes | 2 (read-flow priority; live-editor write policy) |

Everything in the sync core survives the subtraction test: remove any piece
and a named goal breaks (outbox → lost work; CAS → silently destroyed
collaborators' work; one-door → response/stream races; Initialize → stranded
outboxes; token position → silent stream gaps; drafts → a client that can
reach nobody either loses its typing or has it delivered twice).

## 10. Deliberately not built (yet)

- **Multi-tab leader election.** Multiple tabs are *correct* today — one
  client each, converging via the stream, server dedup by transaction id —
  and now demonstrated rather than assumed. Election is a contained
  optimization; it saves work, not correctness.

  The outbox IS persisted now, so the thing this was waiting to become true
  is true: browser storage is shared per origin, and **nothing may assume an
  entry in the outbox was written by the tab that finds it.** `indexed.ts`
  is built for that — a row per transaction rather than a document per
  workspace, so two tabs append and remove without either writing back a
  version that forgot the other's work, and bytes are released only against
  what is written down rather than against one tab's queue.
- **A precise definition of "active" for non-yjs editor buffers** — a
  product decision (visible? dirty? this session?) pending real UX.
- **Draft supersession.** Deliberately not built, and now deliberately not
  wanted: a draft can be part of a snapshot somebody took at that moment, so
  a later draft does not stand in for an earlier one. Every draft is a member
  of the outbox like any other transaction and has to reach the server.
  Chaining against `predecessor` is what keeps that affordable — a long
  offline session stores what was typed since, not a document per save.
- **Migrations that are not additive.** `widen` adds columns the code
  declares and refuses everything else — a column the code no longer declares
  is left alone, and one that is NOT NULL with no plain default stops the
  server starting rather than inventing what the old rows held. Both refusals
  are deliberate; neither is a migration tool.
- **Stream resume via cursor.** The single-use-token design makes every
  reconnect a fresh snapshot. If resnapshot-per-blip ever gets expensive
  (mobile), a resume cursor can be added server-side without breaking this
  contract.
- **Kind-transition automation** (size-based demotion of huge text files
  from live editability) — the content model (§5) already accommodates it;
  the trigger machinery can come later.
- **Restore.** A tombstone is terminal, and a "restore" is a fresh Create.
  Nobody should add it as "just a CAS write to `deleted`": the parent may have
  been deleted since, and the name may have been taken while the entry was
  gone, so a restore would have to re-run every create-time check. Until it
  does, it does not exist.
- **Case-insensitive names.** Sibling uniqueness is case-SENSITIVE, matching
  the Linux-shaped runtime that reads the tree, where `Foo.py` and `foo.py`
  are two importable modules. Names are NFC-normalised at the controller, so
  a macOS client's `café` and a Linux client's `café` are one name. Reversing
  the case decision later means reconciling workspaces that already hold
  colliding pairs.

The design is at the stage where the threat is no longer a flaw in it, but
feature pressure gradually un-simplifying it. Each addition should be asked
the same question this document answers: which goal breaks without you?

---

## 11. Six findings, and what each one cost to learn

**Read these as history with one live rule in them.** Findings 1, 2, 3 and 6
are about machinery that no longer exists: the client-side verdicts, the
bookkeeping about whose write was whose, and the repair-by-diff they drove. All
of it went when the server took over carrying text into rooms. They are kept
because each one is a way of getting this wrong that looked reasonable at the
time, and because finding 6 is the reason to expect them to come back in new
clothes.

**Findings 4 and 5 are still rules.** A client that cannot reach the others
must not store as the file, coming or going. What changed is the consequence:
the work is kept as a draft and handed to the host, so being unable to reach
the room costs the direct route and nothing else.

None of the first three would have shown up in one browser. The fourth would
not have shown up in one *session*. The fifth would not have shown up without
running the fourth's test.

**1. `Standing` has to be held in structures that merge.** `produced` started as
a list in one `Y.Map` slot, which is last-writer-wins. Two clients storing at the
same moment each wrote their own one-element list; one survived; the client whose
entry was lost then treated the other's write as a stranger's and asked for a
repair. Now it is a key per transaction. Recorded in `rooms.ts`.

**2. Concurrent seeding doubles the file.** "The document is empty" is true for
*both* clients opening together, and a CRDT merges two inserts rather than
noticing they say the same thing. Now claimed first and acted on second: one
last-writer-wins slot, a wait for the room to converge, and only the winner
writes. **The wait is a 600ms guess** (`CONVERGING` in `room.svelte.ts`) — it
wants to hang off an acknowledgement instead, and that is still the single
piece of this most worth replacing.

**3. A verdict is a hypothesis, not a fact.** The bookkeeping travels between
clients through the *shared document*; the write it is about travels through the
*server*; nothing orders those two. A member can be told a write landed before
being told its own room made it, and will call its own text a stranger's — and
repairing against text you already hold does not conflict, it duplicates. So
every non-`current` verdict is confirmed by reading the file at that token, and
nothing is done if the document already says it. Bookkeeping makes the common
case free; the comparison is what makes it correct. Recorded in `rooms.ts`.

Reading the file is also how a room finds out it is **over**: nothing in a token
says whether it names text or bytes, so that read is the first moment anybody
can know the file stopped being text. That is where `replaced` comes from.

**4. A room nobody can hear must not write around itself.** The second
session's finding, and the one hardest to reason your way to. A member that
loses the room keeps its document — that is what a CRDT is for — and it keeps
its connection to the *server* as well, so storing still works. It must not.
The text it would store is text the others have not been given, so they repair
towards it; then the lapse ends, the documents merge, and the same text arrives
a second time as edits nothing can deduplicate. Nobody did anything wrong and
the file says everything twice.

The rule is that the two channels are used together or not at all, and it has
two halves, because the trap has two directions:

- **A detached room does not act on the stream.** It records that it missed
  something and nothing else — not even advancing `base`, which is one
  last-writer-wins slot in a document that has not merged for a while, so a
  detached client's guess at it would win over what the room agreed while it
  was away.
- **A detached room does not write to the server.** `store` answers
  `{ held: true, why }` instead. Nothing is lost: the work stays in the
  document and goes when the room comes back.

On reattach the room asks `rooms.opening` once, which covers a lapse of any
length. Recorded in `rooms.ts`, expressed as `rooms.speaking`, and covered by
the scenario *holds a store while the room is not reaching anybody* — which
**has never been run**, so finding 4 is reasoned rather than observed. It is the
first thing to check when docker is back.

**5. Coming back is not the same as having been heard.** The third session's
finding, and the half of finding 4 that was missing.

Finding 4 says a room that cannot reach anybody must not write to the server.
True, and **not sufficient**. The symmetric case is the moment it comes *back*:
`provider.synced` is the provider saying **this client has received the room**,
and it says nothing whatever about whether the room has received this client.
A room that stored in that window sent, through the SERVER, text whose only
other copy was still in flight through the DOCUMENT. The others met a token
they had no bookkeeping for, carrying text they did not hold, and did the one
thing that is correct on the evidence available: they repaired towards it. Then
the merge landed and said the same thing again.

It is finding 4's own doubling, reached from the other direction, and by
exactly the members who did nothing wrong.

**Observed, not reasoned.** `holds a store while the room is not reaching
anybody` failed **four times out of four** on the member who stayed — three
times as a repair that should not have happened, and once, decisively, as

```
said=2  verdicts=["seed","repair"]  text="kept\nada while away\nada while away\n"
```

Note what the three non-doubling failures mean: `#act` records the verdict from
one comparison and `#mend` re-reads before acting, so when the merge lands
between the two the repair is contemplated and then declined. The file is
right; the verdict log records a repair that never happened. That is the same
race, caught by the guard rather than by luck — which is why asserting on the
verdict log, and not only on the text, is what made this visible at all.

The fix is `#settling` in `room.svelte.ts`: a room that has just reattached
does not speak until what it holds has had a chance to go out, and `send`
answers `{ held: true, why: "the room has not finished handing over what it
holds" }` until then. Scenario 6 went from **0 of 4** to **6 of 7**, and the
doubling is gone. The one remaining failure is a different shape — the member
who stayed never received the line at all — which belongs to *The stream
sometimes does not carry a write* rather than to this.

**It is a timer, and it should not be.** `#settling` waits `CONVERGING` — the
same 600ms guess seeding uses. Both callers are asking the same question from
opposite ends: *has this document been round the room yet?* Neither can ask it,
so both guess. This is now the second place where correctness rests on a
duration, which makes replacing it with a real acknowledgement the most
valuable change left in the protocol rather than merely the tidiest.

**6. Moving a rule's execution does not move the rule.** The fourth session's,
and the shortest to state.

Finding 3 says a verdict is a hypothesis and the content is the authority. When
the server took over carrying text into rooms, that lesson did not travel with
the work: the keeper read the room to DECIDE what it owed, and read it again to
BUILD the update it sent. A room that caught up in between was handed what it
already held, and a CRDT cannot notice two inserts say the same thing.

The first full browser run after the change doubled whole changes for whichever
member arrived second -- `"written before grace ever looked\n"` twice, and a
lapse scenario reading `"shared start\nada was alone\ngrace was alone\nada was
alone\ngrace was alone\n"`.

The fix is finding 3's own: ask again, against the read being acted on, where
the answer cannot go stale. Reproduced deterministically by letting a fake
answer a read and only then change the room, so the deciding read and the
building read see different states.

Worth remembering when the remaining steps move more work to the server: every
guard that exists on the client is a candidate to be needed again on the other
side, and the reasons are written down where the old code was, not where the
new code is going.

