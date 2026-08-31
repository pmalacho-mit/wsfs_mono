# wsfs — Protocol and Behaviour Specification

**Version:** 1.0-draft, derived from `release/` at commit `576b33e`.
**Status:** Descriptive-normative. Every rule here was read out of the
implementation in `release/backend` and `release/frontend`, not out of
`docs/ARCHITECTURE.md`. Where the two disagree, §16 says so.

---

## 0. What this document is for

`docs/ARCHITECTURE.md` is a *map*: it explains why the system is shaped the way
it is. This is a *specification*: it says what a conforming implementation must
do, in enough detail that

- a second implementation in another language can be written from it alone,
- a change to `release/` can be checked against it before it is made, and
- a disagreement between two implementations can be settled by pointing at a
  numbered clause.

It deliberately does not explain rationale except where the rationale is load
bearing for correctness. For rationale, read the source comments — they are
unusually good and they are the thing this document was written from.

### 0.1 How to use it when changing the system

1. A change that alters anything in §5 (wire), §6 (adjudication), §8 (stream),
   §9 (content) or §15 (invariants) is a **protocol change**. It needs a
   version bump here and a note in §16.4.
2. A change that alters only §13 (client) is a **client change**. Servers must
   keep working with older clients; §15.C states what that requires.
3. Everything in §15 is a rule that no change may break without an explicit
   decision recorded in §16.4.

### 0.2 Conformance language

MUST / MUST NOT / SHOULD / MAY are used in the RFC 2119 sense. "The server"
means an implementation of §4–§12. "The client" means an implementation of
§13. "A conforming implementation" means both halves unless qualified.

Three kinds of statement appear:

- **[N]** normative — required for interoperability.
- **[H]** host-supplied — the value or policy is chosen by the embedding
  application; the spec fixes only its shape and meaning.
- **[I]** informative — explanation, no requirement.

---

## 1. System summary

wsfs is a server-authoritative synchronising filesystem for a workspace. It has
exactly one ordered channel of truth per workspace, client-minted identity
throughout, per-property compare-and-swap, and a durable client-side outbox
that makes offline work an ordinary queued case rather than a special one.

It is one of **two sync planes** in the wider product. The other — character
level live editing over a CRDT — is out of scope here except at the seam
described in §14. Nothing in §2–§13 depends on the collaboration plane
existing.

**[N]** The two planes MUST remain separable: a conforming server MUST function
with §14 unimplemented, and a conforming client MUST function with
`shared()` always answering false.

---

## 2. Model and vocabulary

### 2.1 Entry

An **entry** is a node in the workspace tree. It has:

| Part | Mutable | Notes |
|---|---|---|
| `id` | no | client-minted UUID, unique across the deployment |
| `workspace_id` | no | |
| `type` | no | `file` \| `folder` |
| name | yes | one string |
| parent | yes | entry id, or null meaning workspace root |
| deleted | yes | boolean flag, not a tombstone row |
| content | files only | see §9 |

**[N]** An entry's metadata is *pure namespace*. It MUST NOT carry any content
descriptor — no size, no mime, no hash, no kind. `content_version` names the
write to fetch; it says nothing about what that write holds.

**[N]** `type` is immutable. A folder never becomes a file.

**[N]** A file is born with content and a folder is born without. There is no
contentless file at any point in its life. An "empty file" is
`{"type":"text","content":""}` — something a client says, never something it
omits.

### 2.2 Version token

A **version token** names one state of **one property** of one entry. There are
four per entry (`name_version`, `parent_version`, `deleted_version`,
`content_version`), and they move independently.

**[N]** A version token IS the id of the transaction that last set that
property.

**[N]** Version tokens are comparable by **equality only**. No implementation —
server or client — may derive "newer than" from a token. Staleness is resolved
by re-entering the sync loop, never by comparison.

**[N]** There is no version of a whole entry. Any API that appears to offer one
is a bug.

**[I]** Splitting tokens per property is what stops a collaborator's write from
invalidating your pending rename.

### 2.3 Transaction

A **transaction** is one client-initiated mutation, identified by a
client-minted UUID.

**[N]** A transaction id MUST be spent at most once, on one operation, against
one entry (§6.2).

**[N]** After application, the transaction id is the CAS token of every property
that transaction set. A create sets four properties at one id; they diverge on
first mutation.

**[N]** Transaction ids SHOULD be UUIDv7 and MUST be minted with a platform
CSPRNG. `Math.random()` and equivalents MUST NOT be used.

### 2.4 Position

A **position** is a monotonically increasing integer per workspace, stamped on
each applied transaction's rows.

**[N]** Positions MUST increase. They need not be dense; gaps are expected and
harmless (§6.9).

**[N]** Positions MUST NOT reach a client. They exist so a stream can splice
replay onto live without duplication.

**[N]** Rows sharing a position are one transaction. Only a create and a move
write more than one row.

### 2.5 Client and session

A **client** is one instance of the system — in the reference implementation,
one browser tab. One client = one outbox = one sync loop.

A **session** is a GUID minted per page load, stamped on outbox entries.

**[N]** The session id distinguishes "this run already showed this
optimistically" from "this survived a reload and was certainly never on
screen". It is client-local and MUST NOT be sent.

### 2.6 Occurrence — two clocks

```
Occurrence = { minted: datetime|null, offset: int|null, accepted: datetime|null }
```

- `minted` — UTC instant read out of the transaction's UUIDv7 (§3.2). Null when
  the id is not a v7. Client-reported; only as good as their clock.
- `offset` — the client's minutes **east** of UTC when it minted, as
  `-new Date().getTimezoneOffset()` reports them. Berlin summer `+120`, Los
  Angeles `-420`. Null when the client said nothing.
- `accepted` — the server's own UTC clock at application.

**[N]** `offset` rides on the **transaction**, never on the connection. An
outbox composed over a week in one zone may be replayed by a client in another;
a per-connection offset would stamp the replaying client's zone onto every
queued item.

**[N]** `accepted` is nullable in the wire type and MUST NOT have a default. It
is null in exactly one place and never from the server: a client's own
optimistic overlay for work nobody has accepted yet.

**[N]** `minted` MUST NOT be sent as a separate field. It is derived from the
transaction id (§3.2).

**[N]** Where the two clocks disagree, `accepted` is authoritative for ordering
and for reconciliation. `minted` is authoritative for "what did the user
experience".

**[N]** Valid `offset` range is `[-1439, 1439]` minutes. Values outside it MUST
be rejected as malformed. (Real zones span −720…+840; the wider bound refuses
only values that cannot be a clock at all.)

### 2.7 Content, blob, kind

- **Kind** — `text` or `binary`. Not a stored field: it is which content log
  the newest write landed in (§4.2). There is therefore no kind field anywhere
  that could fall out of step.
- **Blob** — immutable bytes named by their SHA-256 hash, stored once per
  deployment.
- **Body** — what a create or write carries:
  - `{"type":"text","content": string}`
  - `{"type":"binary","hash": string, "size": int, "mime": string}`

### 2.8 Draft

A **draft** is a write a client asked the server to *keep and not apply*. It is
not a refusal (nothing was declined) and not an ordinary acknowledgement
(no stream event will ever follow it). See §10.

---

## 3. Identity and time

### 3.1 Minting

**[N]** Every id crossing the wire is client-minted: transaction ids, entry ids,
chat message ids, study episode ids.

**[N]** The server MUST NOT remap an id. An entry id already in use is the typed
refusal `ID_TAKEN` (§5.4). A remap would reintroduce the local-id → server-id
table that client-minted identity exists to delete.

**[N]** A client MUST mint an id once and reuse it on every retry. That is what
makes a retry free.

**[N]** The client's minter MUST be monotonic *within* a millisecond — two ids
minted in the same tick must sort in mint order. A hand-rolled v7 that
re-randomises the whole tail on each call does not satisfy this. (The reference
client uses the `uuid` package's `v7`, which carries a sequence counter, and
depends only on `crypto.getRandomValues`.)

**[N]** The server mints exactly one kind of id itself: the rename that settles
a colliding create (§6.8). It MUST be a v7 and MUST carry no `utc_offset`.

### 3.2 Reading a client's clock out of an id

**[N]** For a UUIDv7, `minted = epoch + milliseconds(id >> 80)`.

**[N]** For any other version, or when the resulting instant is not
representable, `minted` is null. This MUST NOT be an error: the contract
*prefers* v7 and does not require it, so a non-v7 id is a client saying nothing
about when it acted.

**[N]** The server MUST NOT store the minted instant in a column. It is already
in the primary key; a second copy can drift from the first.

---

## 4. Logical storage model

This section describes the **logical** model. Any storage engine satisfying it
conforms; the reference implementation uses Postgres via SQLModel, with all
table names supplied by the host **[H]**.

### 4.1 The five append-only logs

An entry is pure identity. Everything mutable about it lives in one of five
logs, all keyed by transaction id:

| Log | Payload | Written by |
|---|---|---|
| name | `name` | create, rename, move, settle |
| parent | `parent_entry_id` (nullable) | create, reparent, move |
| deletion | `deleted` (bool) | create (false), delete (true) |
| text content | `delta`, `size`, `mime` | create, write (text) |
| blob content | `hash`, `size`, `mime` | create, write (binary) |

Every log row carries: `id` (= transaction id, primary key), `entry_id`,
`user_id`, `utc_offset` (nullable), `timestamp` (server clock), `position`.

**[N]** Only transactions that were **applied** appear in these logs. A refused
transaction changed nothing, so nothing is stored here for it.

**[N]** `position` MUST default to a sentinel (`0`) that is not a valid
position, so that a row bypassing the choke point cannot reach storage.

**[N]** These five logs ARE the event stream. There MUST NOT be a separate
publish step, event table, or outbox on the server side: a second write is a
second thing that can fail independently, and two records of one fact can
disagree.

### 4.2 Deriving current state

**[N]** An entry's current state is, for each of the four properties, the row
with the **highest position** in that property's log for that entry.

**[N]** An entry's `kind` is which content log holds its newest content row.

**[N]** An entry's `modified` occurrence is the occurrence of whichever of the
four current rows has the **highest position** — ordered by position, not by
either clock. (Two transactions can tie on a microsecond clock; they cannot tie
on a position, and rows sharing a position share a transaction and therefore an
occurrence.)

**[N]** `deleted` on the wire is `true` or absent. A live entry MUST NOT be
spelled `"deleted": false` in `Metadata` — the reference server emits
`deleted or None`, and clients that compare raw fields would otherwise announce
a spurious change.

### 4.3 The refusal store

**[N]** Every declined transaction MUST be recorded, with **exactly what
applying it would have written**: a refused move leaves a name and a parent, a
refused create leaves name, parent, deletion and content, a refused write leaves
its text.

The pairing from log → refusal table MUST be driven off the same function that
says which logs an operation writes (§6.2), so the two cannot drift.

Refusal rows carry: surrogate `id`, `transaction` (indexed, **not** the primary
key), `user_id`, `workspace_id`, `entry_id` (no foreign key), `op`, `reason`,
`presented` (the token this request claimed for *this* property), `utc_offset`,
`timestamp`, `cleared` (§10).

**[N]** Refusal rows MUST NOT carry a position. They MUST be invisible to: the
event stream, the delta chain a read folds, and the dedup scan of §6.2. This
MUST be achieved by their being in different tables, not by remembering to
filter.

**[N]** The transaction id is an **indexed column, not a key**. A request
refused twice was genuinely sent twice and produces two rows.

**[N]** `entry_id` MUST NOT have a foreign key: the refusal most worth recording
is a create, which names an entry that was never created.

**[N]** Two reasons live in their own tables so they can be counted apart:
`ENTRY_UNKNOWN` (no entry to attribute anything to) and `ID_TAKEN` (a client
minting badly, not a user losing a race). A transaction refused for one of these
is recorded **both** in its own table and, if it carried content, in the content
refusal tables — because that text may be the only copy anybody has.

**[N]** A `text` column cannot hold `U+0000`. It MUST be stripped from a
recorded name, and only there. Nothing recoverable is lost: the name was already
declined and the reason says why.

### 4.4 Derived caches

Two tables are **derived and never authoritative**. Deleting either MUST cost
only time.

- **text cache** — one row per entry: the entry's text as of its newest write.
  Anchors the delta fold (§9.2).
- **refused-text cache** — one row per (entry, user): that client's newest
  refused text. Anchors the `basis` chain (§9.5).

### 4.5 Ancillary records

None of these is a transaction against an entry. **[N]** None takes a position,
writes a log, or produces a stream event.

| Record | Keyed by | Purpose |
|---|---|---|
| snapshot rows | (`snapshot` txn, `entry_id`) — many rows per snapshot | four tokens per entry at a moment |
| execution rows | transaction id | one run of one file against a snapshot |
| room rows | entry | whether a room exists; where its text stands |
| cloned rows | one per copied entry | provenance of a clone |
| stream tokens | token string | single-use, position-bound (§8.2) |
| chat rows | message id | tutor transcript |
| study rows | episode / offer id | see §12.4 |

**[N]** Snapshot rows MUST store all four tokens, not just content: together
they *are* the entry at that moment.

**[N]** Execution rows MUST NOT be positioned. Taking a position would put a
number into the stream sequence that the stream never emits and the controller
never sees — a gap at best, a collision once the counter is reseeded from logs
this row is not in.

### 4.6 Retention

**[N]** Tombstones MUST outlive the longest offline session a client can have.
Reconciliation depends on them: an entry absent from an Initialize snapshot is
an entry that never existed, which is a different fact from "deleted".

**[N]** A snapshot returned by Initialize MUST include tombstones.

---

## 5. Wire contract

**[N]** The wire shapes MUST be declared in exactly one place, and the other
side's types MUST be generated from it. Two hand-maintained copies of a contract
do not stay one contract. In the reference implementation the source is
`release/backend/contract.py` and the generator is
`release/frontend/generate.py`, producing `schema.generated.d.ts` from
`openapi.generated.json`.

### 5.1 Common request envelope

Every submitted transaction carries:

```
transaction : UUID     -- client-minted; becomes the CAS token
id          : UUID     -- the entry
offset      : int|null -- minutes east of UTC at mint
op          : string   -- explicit discriminator
```

**[N]** `op` MUST be present and explicit. The union is not structurally
discriminable and a reader MUST NOT guess.

**[N]** Entry names MUST be normalised to Unicode **NFC** at the door — at the
single point where requests are parsed, and nowhere else. A macOS client's NFD
`café` and a Linux client's NFC `café` must not become two siblings a user
cannot tell apart.

### 5.2 The eight operations

```
create    { op, transaction, id, offset?, type, name, parent?, content }
rename    { op, transaction, id, offset?, name, name_version }
reparent  { op, transaction, id, offset?, parent?, parent_version }
move      { op, transaction, id, offset?, name, name_version, parent?, parent_version }
delete    { op, transaction, id, offset?, seen }
write     { op, transaction, id, offset?, content_version, content, draft?, predecessor? }
snapshot  { op, transaction, id, offset?, entries }
execute   { op, transaction, id, offset?, snapshot, outputs, ok }
```

Notes, all **[N]**:

- **create.content** — required for `type=file`, MUST be null for
  `type=folder`. Violating either is a malformed request, not a refusal.
- **create.name** — the entry is created under this name even if a sibling
  holds it. The controller then renames it (§6.8), so the settled name arrives
  as an ordinary `name` event rather than as a surprise inside the create
  response.
- **move** — a rename and a reparent as one transaction, taking both positions
  or neither. Doing it as two transactions can half-succeed and leave the entry
  somewhere nobody asked for.
- **delete.seen** — all four tokens of the entry the delete was looking at:
  `{name_version, parent_version, deleted_version, content_version}`.
  `content_version` is required and is null for a folder. The question a delete
  asks is not "has the deleted flag moved" (it almost never has) but "is this
  still the thing I was told to destroy".
- **write.content_version** — never null. A file is born with content, so there
  is always a token to present.
- **write.draft** — see §10.
- **write.predecessor** — a **hint about storage only** (§9.5). It MUST NOT be
  consulted before the answer is given, MUST NOT make a write land that would
  otherwise be refused, and a value naming nothing the server holds MUST be
  ignored rather than refused.
- **snapshot** — not a mutation. Presents no token, cannot conflict, takes no
  position, produces no event. `id` is inherited from the envelope and unused —
  a snapshot is about the workspace. It can only be refused for naming a
  version that was never issued.
- **execute** — refused only when the snapshot is unknown. `outputs` is an
  opaque JSON array: the shape belongs to whatever ran the code, and a server
  that parsed it would need changing every time a kernel learned a new output.

### 5.3 Responses

```
Acknowledged { rejected: false, draft?: false }
Rejected     { rejected: true, reason: string, version?: UUID|null }
```

**[N]** `Rejected.version` is the property's **current** token, supplied when the
refusal was a lost race so the client can rebase. It MUST be null for a delete
(which presented four tokens and needs a fresh look, not one value) and for a
create (which presented none).

**[N]** HTTP status: `200` for acknowledged, `409` for rejected.

### 5.4 Refusal reasons — the closed set

**[N]** These are the exact strings. A client routes on them.

| Constant | String |
|---|---|
| `PARENT_DELETED` | `parent was deleted` |
| `ENTRY_DELETED` | `entry was deleted` |
| `DESTINATION_DELETED` | `the destination was deleted` |
| `NAME_TAKEN` | `entry with name already exists within destination` |
| `ALREADY_RENAMED` | `entry was already renamed` |
| `ALREADY_MOVED` | `entry had already been moved` |
| `ALREADY_WRITTEN` | `content was already updated` |
| `NOT_SHARED` | `the client had not shared this` |
| `PARENT_UNKNOWN` | `no such parent` |
| `DESTINATION_UNKNOWN` | `no such destination` |
| `PARENT_NOT_A_FOLDER` | `that parent is not a folder` |
| `DESTINATION_NOT_A_FOLDER` | `that destination is not a folder` |
| `DESTINATION_INSIDE_ENTRY` | `the destination is inside the entry` |
| `BYTES_NEVER_STORED` | `content bytes were never stored` |
| `ENTRY_UNKNOWN` | `no such entry` |
| `ID_TAKEN` | `that id is already in use` |
| `NOT_A_FILE` | `content cannot be written to a folder` |
| `NAME_INVALID` | `that name is not permitted` |
| `TOO_DEEP` | `that destination is nested too deeply` |
| `FOLDER_FULL` | `that folder already holds too many entries` |
| `CREATE_REFUSED` | `the create this depends on was refused` |
| `UNKNOWN_VERSION` | `the version presented was never issued` |
| *(delete only)* | `later versions modified the {name\|content\|content and name} of the entry` |

Three of these are load-bearing distinctions:

**[N]** `PARENT_UNKNOWN` / `DESTINATION_UNKNOWN` are **not** the same as
`…_DELETED`. Under server-minted ids the first was impossible; a client that
mints its own can name a folder nobody ever created — which is exactly what
happens to every create queued behind a refused create. Answering that with
"was deleted" is the server describing a deletion that never happened.

**[N]** `UNKNOWN_VERSION` is a **different class of failure** from every other
refusal. A token is current (accept), superseded (ordinary conflict — rebase and
retry), or was never issued at all — which means the client's state is unsound
and its only sound move is to discard it and re-Initialize. Answering the third
as an ordinary conflict sends a client into a retry loop it cannot win.

**[N]** `NOT_SHARED` is the client saying *not yet*, not the system saying no.
It shares a table with the refusals so one query answers "what did this client
have", and it MUST be reported to users as a draft rather than as a failure.

### 5.5 Stream events

```
StreamEvent { type, id, transaction, value?, user?, at }
```

`type` is one of `create | name | parent | move | delete | write`.

**[N]** `transaction` is the id of the transaction this event announces, which
**is** the new token for the property it changed. On an event for property P, a
client sets the value and sets P's token to `transaction`.

**[N]** `value` by event type:

| type | value |
|---|---|
| `create` | full `Metadata` of the newborn entry |
| `name` | the new name (string) |
| `parent` | the new parent id, or **explicit null** at the root |
| `move` | `{name, parent?}` |
| `delete` | the new `deleted` flag (bool) |
| `write` | absent |

**[N]** A create's metadata rides **in `value`**, not spread over the event. Spread
out, its `type` (`file`/`folder`) is shadowed by the event's own `type`
(`create`) and the client can no longer tell a file from a folder.

**[N]** A `write` event carries **no payload**. It is a pure invalidation
signal: cached content and its kind are stale, and the next content fetch
reveals the rest.

**[N]** `parent`'s null MUST be serialised explicitly, not elided, even where
other nulls are omitted.

**[N]** Which logs a transaction wrote IS which event it was:

| logs written | event |
|---|---|
| {name, parent, deletion} | create (folder) |
| {name, parent, deletion, content} | create (file) |
| {name, parent} | move |
| {name} | name |
| {parent} | parent |
| {deletion} | delete |
| {content} | write |

Any other combination is unreachable and MUST raise rather than be silently
mapped.

### 5.6 Initialize

```
POST  → { outbox: Submitted[] }        -- in counter order
      ← { token, entries: Metadata[], applied: UUID[], rejected: Rejection[] }
Rejection { transaction, reason, version? }
```

**[N]** `applied` is transaction **ids**, not echoed requests: the client already
holds the requests and evicts by id.

**[N]** `outbox` is capped at 10 000 transactions. An outbox composed offline
can be long; it cannot be unbounded. (See §16.3 for what a client must do about
this.)

### 5.7 Endpoints

All under a host-chosen prefix (default `/wsfs`) **[H]**. `authorize` is a host
dependency that answers "which user may reach this workspace" and raises to
refuse **[H]**; this package never asks who anybody is.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/workspaces/{w}/initialize` | `InitializeRequest` | `InitializeResponse` |
| POST | `/workspaces/{w}/transactions` | `Submitted` | `Response`, 200/409 |
| GET | `/workspaces/{w}/stream` | `?token=` | `text/event-stream` |
| PUT | `/workspaces/{w}/blobs/{digest}` | raw bytes | 200 / 409 hash mismatch / 413 |
| GET | `/workspaces/{w}/blobs/{digest}` | | bytes / 404 |
| GET | `/workspaces/{w}/entries/{e}/content` | `?content=` | text JSON or bytes; `ETag` |
| GET | `/workspaces/{w}/entries/{e}/history` | `?before=&limit=` | `History` |
| GET | `/workspaces/{w}/entries/{e}/executions` | `?limit=` | `Executions` |
| GET | `/workspaces/{w}/snapshots/{s}` | | `SnapshotTaken` |
| GET | `/workspaces/{w}/drafts` | | `StrandedDrafts` |
| POST | `/workspaces/{w}/drafts/cleared` | `Clearing` | 204 |
| POST | `/workspaces/{w}/reconstruction` | `ReconstructionRequest` | `ReconstructionResponse` |
| POST | `/workspaces/{w}/rooms/{e}` | | `RoomStanding` |
| POST | `/workspaces/{w}/rooms/{e}/warm` | | 202 |
| POST | `/workspaces/{w}/rooms/{e}/stored` | `RoomStored` | 204 |
| POST | `/workspaces/{w}/rooms/{e}/updates` | raw bytes | 204 / 413 |
| POST | `/workspaces/{w}/chat` | `Asking` | `Asked` |
| GET | `/workspaces/{w}/chat/stream` | `?token=` | `text/event-stream` of `Answering` |
| GET | `/workspaces/{w}/chat` | `?before=&limit=` | `Transcript` |
| POST | `/workspaces/{w}/progress` | `Judging` | `Judged` |
| POST | `/workspaces/{w}/study/episodes` | `Detected` | 204 |
| POST | `/workspaces/{w}/study/offers` | `Accepted` | 204 |
| POST | `/workspaces/{w}/study/activity` | `Recorded` | 204 |

**[N]** `/reconstruction` is a POST because the question is a long list. It
mutates nothing.

**[N]** Clone and bulk-place are deliberately **not routes**. `authorize`
answers exactly one question — may this caller reach *this* workspace — and a
clone needs two answers about two workspaces. A route taking the other
workspace in its body would ask the caller to name a workspace nobody checked
they may read. The permission question stays with the in-process consumer that
already knows why it is cloning.

**[N]** Every route handler MUST also be callable in-process, with the user id
as an explicit argument rather than read from a request. A host that is also the
consumer must not have to make an HTTP request to itself — and making the user
an argument is what stops that decision being made by default.

**[N]** Entry-scoped room routes MUST separately verify that the named entry
belongs to the named workspace. Being let into one workspace does not make an
entry in another one yours. This matters most for `/updates`, which puts bytes a
caller supplies into a document other people are reading.

---

## 6. Server algorithm: adjudicating one request

### 6.1 Order of operations

**[N]** For each submitted request, in exactly this order:

```
1.  snapshot or execute?          → §6.10, and stop
2.  write with draft=true?        → §10, and stop (no judgement runs)
3.  already applied?              → §6.2: replay-acknowledge, or ID_TAKEN
4.  create whose entry id exists? → ID_TAKEN
5.  refusal()                     → §6.6; if any, decline (§6.11)
6.  apply                         → §6.7
```

**[N]** Judgement (`refusal`) MUST be **pure**: it reads the workspace and
answers why a request cannot be applied, or nothing. Nothing about a refusal is
stored *by judgement*, because nothing about a refusal happened. Presenting the
same transaction again re-runs the same function and produces the same reason,
computed against the workspace as it stands rather than as it once stood.

### 6.2 Dedup

**[N]** A transaction id is spent once, on one operation, against one entry.

**[N]** The dedup query MUST span **all five logs**, always — not only the logs
this request would write. An id spent on a rename and presented again as a
write finds nothing in the content log, looks unspent, and applies — leaving one
entry with two properties whose tokens are the same UUID.

**[N]** The check is:

```
spent = { log → entry_id | log holds a row with this transaction id }
if spent is empty:                       not a replay, continue
reused = set(spent) ≠ set(logs this request would write)
      or any spent entry_id ≠ request.id
answer = ID_TAKEN if reused else Acknowledged
```

**[N]** Set equality in **both directions**. A create writes three logs and a
rename one, so reuse across them is caught by the sets differing — but a rename
and a write share no log at all, and comparing only the logs *this* request
writes would find nothing and call the id fresh.

**[N]** "Which logs a transaction of this shape writes" MUST be a single
function, shared by dedup, refusal recording (§4.3) and event announcement
(§5.5).

**[N]** For snapshots and executions, dedup is by primary key in their own
tables.

### 6.3 Name validity

**[N]** A name is refused with `NAME_INVALID` when any of:

- it is empty, `.`, or `..`
- it contains any of `/`, `\`, `U+0000`–`U+001F`, `U+007F`
- it differs from itself stripped of leading/trailing whitespace
- its UTF-8 encoding exceeds 255 bytes

**[N]** This function MUST be public and MUST be the *only* definition. A path
segment and an entry name are the same thing, and the path-splitting helper uses
it. Two definitions of what a name may be are two definitions that eventually
disagree.

### 6.4 Placement

A destination is walked once and answers three questions.

**[N]** A destination is unwelcoming when, in order:

```
parent is null            → fine, the root takes everything
holder not found          → PARENT_UNKNOWN / DESTINATION_UNKNOWN
holder is not a folder    → PARENT_NOT_A_FOLDER / DESTINATION_NOT_A_FOLDER
holder deleted, or any
  ancestor deleted/absent → PARENT_DELETED / DESTINATION_DELETED
```

**[N]** The same fault MUST be reported in the words of the site asking: a create
is going to a `parent`, a move to a `destination`.

**[N]** Deleting a folder tombstones the folder, **not its contents**. What the
subtree loses is *reachability*, and that is what nothing may be added to —
hence "any ancestor deleted or absent" above.

**[N]** Shape bounds, checked after reachability:

- depth of the placed child ≥ **64** → `TOO_DEEP`
- live children of the destination ≥ **10 000** → `FOLDER_FULL`

**[I]** These bound the tree rather than bounding how much a client sends,
because a client that mints its own ids can mint unbounded ones offline.

### 6.5 Compare-and-swap

**[N]** For one property:

```
presented == current                      → accept
presented was never issued for THIS entry → UNKNOWN_VERSION
otherwise                                 → the operation's stale reason
```

**[N]** "Was issued" means: a row with that id exists in one of the property's
logs **and** that row's `entry_id` is this entry. A token belonging to another
entry MUST NOT be accepted — one entry's history may not vouch for another's.

**[N]** `null` is a real token: it is what an entry with no content has always
presented.

### 6.6 Per-operation refusal order

**[N]** Exactly these checks, in exactly this order. Order is observable — a
client routes on the reason it gets back.

**create**
```
1. name invalid                                 → NAME_INVALID
2. binary body whose hash the store lacks       → BYTES_NEVER_STORED
3. parent unwelcoming (§6.4)                    → PARENT_*
4. too deep / folder full                       → TOO_DEEP / FOLDER_FULL
```
**[N]** A name collision is **not** refused here. A create has no prior version
to CAS against, so refusing it would be the only thing standing between two
offline clients and a lost `notes.md`. §6.8 settles it instead.

**delete**
```
1. entry not found                              → ENTRY_UNKNOWN
2. entry already deleted                        → accept (idempotent)
3. any of the four presented tokens unissued    → UNKNOWN_VERSION
4. all four match current                       → accept
5. otherwise → "later versions modified the {…} of the entry"
```
**[N]** In (5), a move counts as a change of **name**: both change where the
entry lives in the namespace, and the reason has no third word.

**rename**
```
1. ENTRY_UNKNOWN
2. deleted                → ENTRY_DELETED
3. name invalid           → NAME_INVALID
4. CAS(name)              → UNKNOWN_VERSION / ALREADY_RENAMED
5. name taken among live siblings of the CURRENT parent, excluding self → NAME_TAKEN
```

**reparent**
```
1. ENTRY_UNKNOWN
2. ENTRY_DELETED
3. CAS(parent)            → UNKNOWN_VERSION / ALREADY_MOVED
4. destination (§6.6a) with the entry's CURRENT name
```

**move**
```
1. ENTRY_UNKNOWN
2. ENTRY_DELETED
3. name invalid           → NAME_INVALID
4. CAS(name)              → UNKNOWN_VERSION / ALREADY_RENAMED
5. CAS(parent)            → UNKNOWN_VERSION / ALREADY_MOVED
6. destination (§6.6a) with the REQUESTED name
```

**§6.6a — destination checks**, in order: unwelcoming (§6.4) → destination is
the entry itself or inside it (`DESTINATION_INSIDE_ENTRY`) → too deep / folder
full → name taken.

**[N]** "Inside it" includes "is it": moving a folder into itself severs it from
the root, unreachably.

**write**
```
1. ENTRY_UNKNOWN
2. deleted                → ENTRY_DELETED
3. entry is a folder      → NOT_A_FILE
4. CAS(content)           → UNKNOWN_VERSION / ALREADY_WRITTEN
5. binary body whose hash the store lacks → BYTES_NEVER_STORED
```
**[N]** `NOT_A_FILE` is decided **before** the token is considered: a folder has
no content token, so there is nothing to compare.

### 6.7 Application

**[N]** What each accepted operation appends, all at one transaction id:

| op | rows |
|---|---|
| create | name + parent + deletion(`false`) [+ content if a file] |
| rename | name |
| reparent | parent |
| move | name + parent |
| delete | deletion(`true`) |
| write | content |

**[N]** The entry row MUST be inserted before the logs that point at it.

**[N]** A create is the only transaction that writes four logs; that is exactly
what makes it recognisable in the stream.

**[N]** Applying a delete to an already-deleted entry acknowledges and appends
nothing. Acknowledging beats inventing a refusal for work already done. (See
§16.2 for the client-side consequence.)

### 6.8 Name settling

**[N]** Entries created within a unit of work are noted, and settled **once, at
the end**, after every queued transaction has had its say — not at the create
itself. The ordinary reason a create collides is a client that made an entry and
then typed a real name over it; settling late lets that rename land first, and
the collision usually turns out never to have mattered.

**[N]** For each noted entry, in creation order:

```
node absent or deleted                     → nothing (a tombstone holds no name)
no live sibling claimed this name earlier  → nothing
otherwise → append a controller-minted name row with an available name
```

**[N]** "Claimed earlier" means: a live sibling under the same parent, with the
same name, whose current name row has a **strictly lower position**, excluding
this entry. First claim wins, so two entries arriving with one name settle in
the order they arrived rather than the order they are looked at.

**[N]** An available name is found by trying `stem (2).ext`, `stem (3).ext`, …
for at most **98** candidates, then falling back to `stem (<entry-id-hex>).ext`.
A name with no stem before the last dot (a dotfile) is suffixed whole:
`.env` → `.env (2)`.

**[N]** The settling rename is an ordinary transaction: it takes a position, it
emits a `name` event, and it is attributed to whoever was presenting the work.
The create response is not special-cased and does not mention it.

**[N]** The settling transaction MUST carry no `utc_offset`. The only clock that
saw it is the server's; claiming a client's zone for work no client asked for
would be a fiction.

### 6.9 The choke point

**[N]** Exactly one function writes. It:

```
position = positions.take()
stamp position onto every row of this transaction
add rows; flush
return the stamped rows
```

**[N]** All of it happens inside the caller's **single database transaction**.

**[N]** The stamped rows MUST be returned, and the event built from them.
Announcing what just happened by re-reading five logs at that position is asking
the database to repeat what it was just told.

**[N]** Positions come from an in-memory counter owned by the workspace's
controller (§12). Nothing is locked, because nothing else writes this workspace.

**[N]** A rolled-back submission leaves a gap. That is correct and MUST NOT be
compensated for.

**[N]** A controller is seeded at `max(high-water read from the logs, the
highest position any controller in this process previously issued for this
workspace)`. The logs alone can **understate** it: a submission that rolled back
consumed a position no committed row carries, and a successor reading only the
logs would hand that number out again.

**[N]** The high-water read MUST come from the logs, not from a stored counter.
A counter is only as current as its last write, and a process that dies without
ceremony leaves the next one re-issuing committed positions.

### 6.10 Snapshots and executions

**[N]** These bypass the log machinery entirely.

```
already recorded (by primary key)          → acknowledge
snapshot naming a version never issued     → reject
execution against an unknown snapshot      → reject
otherwise                                  → insert rows, acknowledge
```

**[N]** Their rejections MUST NOT go through the refusal store: that store is
shaped around entry properties, and neither of these is one. There is nothing
here a later write could be diffed against. `version` is null.

### 6.11 Recording a refusal

**[N]** Every refusal MUST leave through one function, so none can leave without
being recorded (§4.3). The response is
`Rejected(reason, version=current token of the property at stake)` where the
property at stake is: rename → name, reparent → parent, write → content; and
nothing for create, delete, move, snapshot, execute.

---

## 7. Initialize

**[N]** Initialize is **one database transaction** containing, in order:

```
1. adjudicate the presented outbox, in counter order
2. settle names (§6.8)
3. flush
4. mint the stream token, bound to the position read from the logs NOW
5. take the workspace snapshot
6. commit
```

**[N]** Splitting these apart silently kills the no-flicker and the no-gap
guarantees. Steps 2 and 5 are in that order so the snapshot shows the names that
settled.

**[N]** Nothing rewrites the tokens a client presented. The client minted them,
so it already knows what its own queued work produces and chained accordingly.

**[N]** A create that is refused makes its entry **stillborn**: every later
request in the same outbox naming that entry is refused `CREATE_REFUSED`
without being judged — and **recorded anyway**. This is the one refusal that
never reaches the adjudicator, and for a while it was therefore the one that
kept nothing. That is the worst possible place to lose work: replay is how a
queue comes home, so a single refused create silently discarded every keystroke
queued behind it.

**[N]** The token's position MUST be read out of the **logs**, inside this
transaction — not off the controller's counter. The counter is the *next* number
to hand out and it moves before a submission commits, so a rolled-back
submission leaves it above anything committed. That costs the stream nothing,
but a token is a promise about what has already happened, and one bound to a
number no row carries tells a stream to skip the row that eventually takes it.

---

## 8. The stream

### 8.1 Transport

**[N]** Server-Sent Events. One `data:` line per event, in position order, and a
`: hb` comment every heartbeat interval **[H]**.

**[N]** Headers MUST include `Cache-Control: no-cache` and
`X-Accel-Buffering: no`.

### 8.2 The token

**[N]** The token is the credential, because EventSource cannot carry a header.
It MUST therefore be:

- **single-use** — the claim and the lookup MUST be one statement
  (`DELETE … WHERE token = ? AND expires > now() RETURNING position`), so two
  racing connects produce exactly one winner;
- **position-bound** — it names the position the accompanying snapshot was taken
  at;
- **short-lived** — 60 seconds in the reference implementation **[H]**.

**[N]** An invalid or spent token is `401`.

### 8.3 Splicing replay onto live

**[N]** In exactly this order:

```
1. claim the token → after
2. SUBSCRIBE (register the live queue)
3. read replay: everything with position > after
4. emit replay, tracking cursor = last position emitted
5. emit live events, skipping any with position <= cursor
```

**[N]** Subscribing before reading is what makes an event committed in between
land in **both**; the cursor is what drops the duplicate. Reversing the two
opens a gap that nothing will ever close.

### 8.4 Reading the logs as one observation

**[N]** The replay read MUST see all five logs at **one snapshot**
(`REPEATABLE READ`, and it MUST be the first statement in its transaction).

**[I]** Why this is not tidiness: a transaction's rows are spread across up to
four logs. Under read-committed, a transaction committing between two of the
five queries is seen in some and not others. A folder create caught that way
arrives as `{parent, deletion}`, which is not an event at all; caught the other
way it arrives as a bare `name`, which *is* one, for an entry the client has
never heard of. The first kills the stream loudly and the second loses the entry
in silence, which is worse.

### 8.5 Grouping

**[N]** Rows are grouped into events by the **transaction that wrote them**, not
by the position they landed at. Position only orders the result.

**[I]** This is what keeps a violated topology invariant (§12.1) producing an
*ugly* stream rather than a *wrong* one.

---

## 9. Content

### 9.1 Three different length units

**[N]** Be explicit about which is meant where:

| Quantity | Unit |
|---|---|
| delta offsets (`retain`) | UTF-16 code units, as Yjs counts them |
| `size` on a content row | UTF-8 bytes for text; byte length for a blob |
| name length bound (§6.3) | UTF-8 bytes |

**[N]** Delta arithmetic MUST be done on a UTF-16 encoding, not on Unicode code
points. The two agree until the first emoji and then disagree silently.

*(See §16.1: the contract's prose says `Version.size` is characters for text.
The implementation stores UTF-8 bytes.)*

### 9.2 Text as deltas

**[N]** A text write stores the **delta from the text it was written against**,
not the text. Storing every revision whole is the wasteful option; storing the
edit between revisions is not.

Delta operations, Yjs-shaped:

```
{ retain: int }      -- advance n UTF-16 units
{ insert: string }
{ delete: string }   -- the REMOVED TEXT, not its length
```

**[N]** `delete` MUST carry the removed text. Yjs carries a length; keeping the
text is what makes a delta invertible and therefore a delta chain walkable in
both directions.

**[N]** Runs of the same operation MUST be merged into one operation.

**[N]** Applying a delta: base left unconsumed by the delta is kept.

**[N]** Four operations MUST exist and MUST be mutually consistent:
`diff → delta`, `apply`, `invert`, `recover_base` (apply inverted deltas in
reverse).

### 9.3 Reconstruction

**[N]** An entry's text at position *p*:

```
anchor = text cache row for this entry (text, position), or ("", 0)
if p >= anchor.position: apply text deltas in (anchor.position, p] forwards
else:                    invert text deltas in (p, anchor.position] backwards
```

**[N]** Only **text** rows contribute. A binary write in the span contributes
nothing, so a file that went text → binary → text still reconstructs.

**[N]** The cache MUST be re-anchored at each new newest write, and the write
MUST be flushed before returning: a later write in the same unit of work reads
the anchor back with a SELECT to fold against, and leaving that to autoflush
makes correctness rest on a session setting two layers up.

**[N]** The base a write is diffed against is the entry's text at its **current
content position** — which, for a file whose newest write was binary, is its
last *text* state, by the rule above.

### 9.4 Blobs

**[N]** Named by SHA-256 of their bytes, stored once per deployment.

**[N]** `PUT` is idempotent by construction: if the store already holds the
digest, answer success without reading the body.

**[N]** The store MUST verify that the bytes hash to the claimed digest and
answer `409` if they do not.

**[N]** A `PUT` without `Content-Length`, or exceeding the host's limit **[H]**,
is `413`. Without a declared length the body's size is unknown until it has been
buffered, which is the thing a limit exists to stop.

**[N]** `GET` is served only when **some write in this workspace names those
bytes** — an accepted write *or a refused one*. A hash is not a secret (it
travels in `X-Content-Hash`, in every binary body, and through any client that
held the file), so knowing one buys nothing; authorisation is the host's
`authorize` plus this reference check.

**[N]** The refused-write branch is not optional. A refused write's bytes are the
only copy of what somebody uploaded, and they are already reachable through
`/content` by transaction id. The two doors disagreeing is how one serves 404
for something the other hands over.

### 9.5 Refused writes, and the predecessor chain

**[N]** A refused text write is stored as a delta, against — in this order of
preference:

1. **the client's own previous refusal**, if `predecessor` named one that this
   server holds for this entry;
2. **the accepted content the request presented** (`presented` token → its
   position → text at that position);
3. **nothing** — the delta is the whole text. This is a create, or a token the
   server never issued: there is no earlier state of this file anyone agreed to.

**[I]** A client whose writes are losing in a row drifts further from the
accepted head with each one, so diffing each against that head stores the whole
divergence again every time. Against the previous refusal it stores what was
typed since.

**[N]** The refused-text cache (§4.4) is keyed by (entry, **user**) — two
clients contesting one file would otherwise evict each other exactly when their
chains are longest.

### 9.6 The content endpoint

**[N]** Resolution, in order:

```
entry unknown, or not in this workspace       → 404 "no such entry"
content param omitted                         → the entry's newest write
content param given                           → the write with that id,
                                                if it belongs to this entry
still nothing, and a content param was given  → the newest REFUSED write with
                                                that transaction, this entry,
                                                this workspace
still nothing                                 → 404 "entry has no such content"
```

**[N]** A refused write is answered at the **same address** as an accepted one. A
client holding a transaction id should not have to know which way the answer
went in order to ask what it said — and the reason it is asking is usually that
it does not.

**[N]** "Newest of its transaction": a request re-sent after a dropped
connection is refused twice and leaves two rows; the one the client was holding
when it gave up is the later.

**[N]** The version a refused write reports is its **transaction**, not the
surrogate key of the row keeping it. The transaction is the only name the client
ever knew it by, and a refusal never became a token anyone can present.

**[N]** Responses:

- text → `{"type":"text","content":…,"version":…}` with `ETag: <version>`
- binary → raw bytes, `Content-Type: <mime>`, `ETag: <version>`,
  `X-Content-Hash: <digest>`

---

## 10. Drafts

A draft is a write asking to be **kept and not applied**.

**[N]** A draft write MUST NOT be judged. It is not competing for the file, so
there is no race for it to lose and no token for it to consume.

**[N]** It is recorded in the refusal store with reason `NOT_SHARED`, and
answered `{rejected: false, draft: true}`.

**[N]** The token it presented is **not consumed**, and nothing rebases under
it. The write that eventually shares the work presents the same one.

**[N]** No stream event will ever follow a draft. A client holding it in its
outbox MUST let it go on this answer, the way it does for a rejection.

**[N]** A draft's `cleared` flag is owned by the **server**, not by the client
that made the draft. The case worth reporting is the machine that never comes
back, and a flag kept only on that machine dies with it.

**[N]** `GET /drafts` returns **uncleared drafts only**, newest first. A
refusal shares the table and means the opposite thing; showing the two as one
tells somebody their work is stuck when it was simply superseded.

**[N]** `POST /drafts/cleared` marks, and MUST NOT delete. The row is still the
record of what that client had, and a snapshot may still name it.

**[I]** Why drafts exist: a client holding text the collaboration server has not
confirmed cannot let that text become the file's content. Adopting it would
either lose the text (the next store from somebody else would not contain it) or
carry it into other people's documents, where this client's own copy would
arrive later and say it twice.

---

## 11. Reading history and the past

### 11.1 History

**[N]** `GET /entries/{e}/history` returns versions **newest first**, ordered by
the **server's clock** — the only one every row shares. A client's minted time is
the more meaningful number to show and the wrong one to sort by: two clients'
clocks disagree, and interleaving them puts a version before the one it was a
change to.

**[N]** Scope: everything the workspace **accepted**, plus **this caller's own**
drafts and refusals. Listing somebody else's drafts publishes typing they never
shared.

**[N]** Standing is derived, not stored: `NOT_SHARED` → `draft`, any other
refusal reason → `refused`, a log row → `applied`.

**[N]** `why` is the refusal reason, and MUST be null for a draft — whose reason
is always the same one and is already its standing.

**[N]** `size` is read from the row's own `size` column, never measured from
what the row stores: a text row holds a *delta*, whose stored length is the size
of an edit script rather than of the file.

**[N]** Paging is by `before` (a timestamp), never by offset: rows arrive while
somebody is reading, and an offset would show one version twice or skip one.

**[N]** `more` MUST be answered by fetching **one more row than was asked for**
and dropping it, not by counting the history.

**[N]** An entry not in this workspace returns empty rather than reading through
a door opened for a different workspace.

### 11.2 Reconstruction

`POST /reconstruction` takes a list of `{id, name_version?, parent_version?,
deleted_version?, content_version?}` and answers what those transactions said.

**[N]** It looks in **both** the logs and the refusal store. Nothing in the
answer says whether a transaction was accepted, and that is deliberate: the
question is *what was the user seeing*, and a client shows its own queued work
before the server has ruled on it. A transaction later refused still described
the screen at the moment it was taken.

**[N]** `unresolved` names the tokens this server has never seen. Empty is the
answer a caller wants; anything in it names work that never arrived, and a
caller replicating a filesystem MUST treat it as a hole rather than as an entry
that had no name.

### 11.3 Snapshots and executions

**[N]** `GET /snapshots/{s}` returns the four tokens per entry the snapshot
named. `GET /entries/{e}/executions` returns runs newest first, with the opaque
`outputs` as recorded and an `ok` flag that is a column rather than something to
be read out of the JSON.

---

## 12. Concurrency, topology, and the controller

### 12.1 The topology invariant

**[N]** Exactly **one process** serves a workspace's writes and streams.

**[N]** Nothing in the code enforces this, and that is a deliberate trade: the
database holds no lock, no lease and no connection on a workspace's behalf, so a
live workspace costs nothing to keep and their number is bounded by memory
rather than by `max_connections`.

**[N]** A conforming server MUST implement the partial startup guard: refuse to
start when `WEB_CONCURRENCY > 1` unless an explicit acknowledgement variable is
set. **[N]** It MUST also document that this guard is partial — `WEB_CONCURRENCY`
is only uvicorn's *default* for `--workers`, so an explicit `--workers 4` sets
nothing there and starts four processes anyway.

**[N]** What breaking it costs: two processes each counting positions from their
own reading of the logs, handing out the same numbers. Because events are grouped
by transaction rather than by position (§8.5), the result is a stream that is out
of **order**, not one that means the wrong thing. Nothing will say so.

**[N]** Live-sibling name uniqueness (§6.6) is **also** held up by this
invariant, not by a database constraint — name and parent are versioned, so no
partial unique index can express it.

### 12.2 The controller

**[N]** One controller per workspace per process. **All** writes — single
transactions and Initialize alike — flow through it, serialized. Reads (content,
blobs, history) bypass it entirely; MVCC handles them.

**[N]** Initialize's one-consistent-view guarantee comes from that exclusion,
not from an isolation level.

**[N]** Fan-out to subscribed streams happens **inside** the serialization lock,
so stream queues observe events in commit order by construction rather than by
protocol.

**[N]** A controller is held for the whole duration of a submission, not taken
transiently — it carries the position counter, and retiring it mid-flight would
let its successor re-seed from rows that have not committed and hand out a
position that is about to be taken.

### 12.3 Controller lifecycle

**[N]** One lock guards get-or-create **and** release, with release re-checking
the reference count **inside** the lock. Otherwise a count hits zero, teardown
starts, and a new stream grabs a dying controller.

**[N]** Release is **grace-delayed** (30 s in the reference implementation
**[H]**), and a controller reclaimed within the grace period cancels the pending
release. The client sync loop turns every network blip into a
disconnect/reconnect pair; count-to-zero-destroy would rebuild the controller
and re-read its position on each one.

**[N]** Seeding reads the database and MUST NOT hold the registry-wide lock
across that read — one workspace waking up must not stall every other
workspace's first request. A per-workspace seeding lock keeps two arrivals from
seeding one workspace twice.

**[N]** On retirement the controller goes and the **last position it issued
stays** (§6.9). Everything else is rebuilt from the logs, which is what makes a
`kill -9` and a clean shutdown the same event for a workspace.

### 12.4 Study telemetry: the one thing allowed to be lost

**[N]** Study records (§5.7) have no outbox and MUST NOT get one. Losing a write
loses somebody's program; losing a telemetry row loses one data point in one
student's term. Paying for the second with the machinery that guarantees the
first would be paying with the editor's responsiveness.

**[N]** Their ids are still client-minted, so a client that *does* retry is not
counted twice.

---

## 13. Client algorithm

### 13.1 State

```
confirmed : Map<Id, Metadata>     -- this client's replica of server truth
queue     : Entry[]               -- the outbox, in order
shown     : Effective             -- derived: { view, overlaid, queued }
index     : Index                 -- derived: paths over the effective view
recorded  : Set<Transaction>      -- every transaction the server answered
```

**[N]** `shown = effective(confirmed, queue)` and `index = paths(shown.view)`.
Both are **derived**, recomputed whole, never patched.

### 13.2 One door for confirmed state

**[N]** The confirmed map is mutated by exactly two things: an Initialize
snapshot (replace-all) and a stream event. **A response to a request MUST NOT
touch it.**

**[I]** This is what makes the ordering question disappear: a response and its
event may arrive in either order, because only one of them carries state.

**[N]** Applying an event: `create` inserts `value` as the entry; every other
type sets its property's value and sets that property's token to
`event.transaction`. An event for an entry the map does not hold MUST be ignored
(the map is returned unchanged).

**[N]** A `write` event advances `content_version` and MUST also invalidate the
content cache for that entry.

**[N]** An Initialize snapshot is **replace-all**, tombstones included.

### 13.3 The outbox

**[N]** The outbox MUST be durable across page loads for work to survive a
crash. A client that keeps it only in memory is conforming but loses work; the
reference implementation makes durability the consumer's explicit choice **[H]**.

**[N]** Order in is order out: counter order, preserved.

**[N]** A queued item is a row of **pointers**. Content lives in a byte store
under its hash, never inline on the queued request. A text write goes in with
`content: null` as an explicit marker — a marker rather than an empty string, so
that a request which somehow escapes without being filled in is refused by the
server rather than silently blanking a file. A binary body is already a pointer
(hash, size, mime) and goes in whole.

**[N]** Successive writes to one entry **chain**; they MUST NOT coalesce. A
consumer that writes at particular moments — so it can later say what the code
was when the user did some thing — needs all of them to reach the server.

**[N]** A chained write is stored as a **delta against the one in front of it**.
The head of a chain holds whole text; everything behind it holds an edit script.
A queue that has been offline all afternoon is a document and a pile of diffs.

**[N]** A delta is only kept if it is *smaller* than the payload. A rewrite
diffs to remove-everything/insert-everything, whose JSON encoding is larger than
the text it describes — and chaining it would cost space *and* make the write
unreadable if its predecessor were lost.

**[N]** Digests are reference-counted: two items can name one digest (the store
is content-addressed) and a chained write names its predecessor's. Nothing is
released while anything still points at it.

**[N]** When an item is evicted, a chained write behind it MUST be handed the
digest it was holding, **in the same durable change** as the eviction. A store
told to remove these and separately to amend those can be killed between the
two, and what comes back is a delta against a predecessor that is gone.

**[N]** Bytes that are **gone** MUST be distinguished from a store that
**refused**. A refusal will likely answer next time, so the write waits. Gone
bytes will not, so the write must be given up and said out loud — and anything
that keeps retrying it stops the queue behind it moving at all.

### 13.4 Ordering rules for durability

**[N]** Two orderings, and the asymmetry is deliberate:

- **Queueing new work: row first, bytes second.** Bytes with no row are work
  that is gone unnoticed; a row with no bytes is work that is gone and *says*
  so, which the presenter can report and drop. The check and the capture MUST
  have no `await` between them.
- **Promoting a chained delta to whole text on the way out: bytes first, row
  second.** The row already exists and is already readable *as a delta*, so
  nothing is recorded only in the bytes at any moment. Promotion re-points the
  row **and** deletes the basis, so running it first and failing to store
  destroys both readings of a write that was valid a moment earlier. Run last it
  cannot fail. The cost is an orphaned payload if the process dies in between:
  a leak, not a loss.

**[N]** If storing bytes fails during queueing, the row MUST be taken back with
them. Leaving it behind poisons the chain: the next write diffs against it,
cannot read it, and throws — and so does every write to that file thereafter.

### 13.5 The effective view

**[N]** `effective = outbox replayed over confirmed`. Optimistic updates are
**derived, never applied**.

**[I]** Two consequences, both wanted. When a transaction is evicted because its
own event arrived, the confirmed change and the overlay's removal cancel exactly
and nothing flickers. When it is evicted by a refusal, the view snaps back on its
own — undo is not an operation here, it is a recomputation.

**[N]** An overlay MUST NOT advance a version token. The token it presents has to
stay the one the *server* has seen, or the next request would compare against a
value that was never issued. Responsibility for an optimistic value is therefore
recorded separately, in an `overlaid: Map<Id, Partial<Record<Property,
Transaction>>>`.

**[N]** Per operation:

| op | touches | applies |
|---|---|---|
| rename | name | name |
| reparent | parent | parent |
| move | name, parent | both |
| delete | deleted | `deleted = true` |
| write | content | *nothing* — only `modified` |
| create | all four | contributes a whole entry |
| snapshot, execute | — | nothing at all |

**[N]** Every overlay moves `modified` to a **pending** occurrence:
`{minted: from the transaction id, offset, accepted: null}` — including a write,
which changes nothing else about an entry and is the most ordinary reason a
file's mtime moves.

**[N]** A queued write's transaction MUST NOT be laid over `content_version`.
That token is what invalidates the content cache, and the cache must not be told
a write landed before it did.

**[N]** A queued create contributes an entry with its own transaction as all
four tokens — but **only when the view does not already hold that entry**. This
is a precondition, not an observation. A create leaves the outbox when the
*stream* carries it, not when the response acknowledges it, so there is a real
window in which the server has confirmed the create *and* writes after it while
the create is still queued. Laying `proposed` over an entry the server has moved
on rewinds every version to the create — and because only the stream drains the
outbox, it stays hidden rather than righting itself.

### 13.6 Announcing what changed

**[N]** Changes MUST be **derived by comparing the effective view before and
after** — never emitted from the request or event that caused them.

**[I]** Two consequences fall out and both are wanted: a stream event that merely
confirms this client's own queued work announces *nothing* (the overlay's removal
and the confirmed value cancel exactly), and a refusal announces the change that
takes it back without anybody modelling undo.

**[N]** A change carries: the entry, the kind, and `by` — the transaction
responsible for what it says **now**. That is what lets a consumer recognise its
own work and not do it twice.

**[N]** A change MUST also carry `retracting` when the transaction that was
speaking for that property has left the queue **without its value surviving** —
i.e. a refusal. A consumer skips its own work *taking effect*; it must never skip
the *undoing* of that work, which it did not do and did not ask for. `by` alone
cannot tell the two apart, because the value a refusal restores can perfectly
well be one this client asserted earlier and is still waiting on.

**[N]** Change kinds: `appeared`, `vanished`, `renamed`, `reparented`,
`removed`, `restored`, `written`, `accepted`.

**[N]** `accepted` exists because confirming your own work changes no value a
reader can see — but `modified.accepted` stops being null at exactly that
moment, and anything marking work as pending has to hear about it to stop.

**[N]** Comparison MUST be on what a property **says**, with the wire's
optionality flattened: an absent parent and a null one are the same root, an
absent tombstone is alive. Comparing raw fields announces a change every time the
server spells the same fact differently.

**[N]** For content, what it "says" is the **transaction responsible**, because
that is all the metadata holds.

**[N]** Departures MUST be announced before arrivals, so a name a departing entry
held is free before an arriving one asks for it.

### 13.7 The write pump

Content writes are the one operation whose token can be invalidated by this
client's **own** work in flight — precisely because §13.5 forbids laying a queued
write over `content_version`.

**[N]** The rule is not to relax the compare-and-swap. It is to stop asking two
questions with one answer:

```
what token invalidates my cached bytes?  → the confirmed one, still
what token do I write against?           → the one in front of me
```

**[N]** One content write per entry on the wire at a time. Writes to one entry
queue in order; the next presents the transaction of the one before it **once
that one has been accepted**.

**[N]** A write from somebody **else** landing in the middle still refuses
everything behind it, because their token is one nobody here can name. That is
the protection the swap exists to give, kept intact.

**[N]** The token actually presented is:

```
the write in front, if it is still queued AND was accepted as content
else the confirmed content token for this entry
else the token the request was minted with   -- a file whose CREATE is also queued
```

**[N]** A **draft** is answered without being rejected and is still not an
acceptable predecessor token. It never became the file's content, so the server
never issued its transaction as a version.

**[N]** `predecessor` on the outgoing request is the write in front of it in
*this* chain, or null. It is a storage hint (§9.5) and nothing else.

**[N]** Waiting for the **answer**, rather than for the stream event, is what
makes the queue affordable: only the head of a chain holds whole text.

**[N]** Two writes asked for in the same tick MUST be captured in the order they
were **asked for**. Queueing is not instantaneous — the payload is hashed and a
chained one is diffed — so without an explicit serialization the loser is stored
as a delta against a tail that is no longer the tail, and the chain claims the
user typed things in an order they did not.

**[N]** Staging and capture MUST be atomic against the tail moving: if the basis
write left the queue while this one was being staged, restage. The check and the
capture must have no `await` between them.

**[N]** On failure, per cause:

| cause | action |
|---|---|
| bytes gone (`LostBytes`) | evict that transaction, report it, **continue** — it cascades on its own as each follower loses its basis |
| byte store refused | leave queued, stop this entry's drain, retry next time |
| network error | leave queued, stop this entry's drain — nothing is known, least of all whether the server saw it |
| answered `draft` | evict; the writes behind carry on against the token it presented |
| answered ok | mark accepted; keep queued until the stream carries it |
| answered rejected | evict, recompute; if the reason is `UNKNOWN_VERSION`, **nudge** |

**[N]** "Stop this entry's drain" is required so that nothing behind an item can
overtake it.

### 13.8 The sync loop

**[N]** Cold start, reconnect and recovery are the **same path**. Every
disruption re-enters at Initialize.

```
loop:
  presented, unreadable = present the outbox      (§13.9)
  evict unreadable, report them
  snapshot = Initialize(workspace, presented)
  record every applied and rejected transaction as answered
  evict them
  confirmed = replace-all from snapshot.entries
  recompute; prefetch; resume the write pump
  follow the stream with snapshot.token
  ... until the stream fails or the watchdog expires ...
  back off, jittered; re-enter
```

**[N]** Backoff resets only once a stream is **established** — after a successful
reconcile — not once one is attempted. A server refusing connections instantly
would otherwise be retried in a tight loop.

**[N]** A **watchdog** MUST exist: no traffic at all for its interval means the
stream is not really there. A proxy that accepts the connection and then swallows
it must look like what it is rather than like a quiet workspace. Reference
default: 45 s, backoff 500 ms → 30 s, jittered to half **[H]**.

**[N]** Whichever side of the race wins, the connection MUST be aborted in a
`finally`. The watchdog case is the one that matters: nothing else would ever
hand the socket back.

**[N]** `nudge()` MUST do three things: reset the backoff, wake any sleep, **and
abort the current stream**. Waking the backoff alone misses exactly the case that
matters — a client whose state has just been called unsound is one whose stream
is working, so there is no backoff to wake from.

**[N]** A client MUST nudge on `UNKNOWN_VERSION` from any path (single submit or
pump). A tab becoming visible or coming online SHOULD nudge.

### 13.9 Presenting the outbox

**[N]** Only the **first** queued write per entry is presented to Initialize. The
rest are chained behind it, and each one's token is the transaction of the one in
front — which the server can only agree with *after* it has accepted that one.
Replay is a single batch with no answers in it, so there is nowhere for that
agreement to happen. The followers go out afterwards, through the pump, one
answer at a time.

**[N]** Presentation MUST NOT throw. An item whose bytes cannot be read failing
Initialize means the loop backs off, re-enters at Initialize, and fails the same
way for ever — one lost write turning into a queue that never drains again. What
cannot be read is **named and dropped before the batch goes**, not after.

**[N]** The transaction blamed for an unreadable item is the one the *read*
blames, which for a broken chain is not the item being presented: a delta three
deep fails on whichever ancestor lost its bytes, and that is the one there is
nothing left of.

### 13.10 Eviction, and what is answered

**[N]** A queued transaction leaves the outbox when:

- its **stream event** arrives (the normal path), or
- it is **rejected**, or
- it is answered **draft**, or
- it appears in Initialize's `applied` or `rejected`, or
- its bytes are lost.

**[N]** It MUST NOT leave on a plain acknowledgement. Those are different
moments, and dropping it at the response opens a window where the entry is in
neither the outbox nor the confirmed map — so a file blinks out of the tree just
after it is created.

**[N]** `recorded` — the set of transactions the server has answered — MUST be
durable alongside the queue and MUST NEVER be pruned. It is three ids per answer;
being complete is worth more than being small.

**[I]** It used to drop whatever the confirmed map covered, on the reasoning that
a current version is already answered for. That is true exactly until the next
write to that file: a transaction pruned while it was current became, the moment
something superseded it, a transaction neither the map nor the set could speak
for.

**[N]** Replay answers count. A draft sent during Initialize leaves the queue and
must be recorded, or a client that reloaded calls its own landed work unsettled
for ever.

### 13.11 `unsettled`

**[N]** `unsettled(transactions)` answers which of them this client has not yet
heard the server confirm. It MUST be computed as:

```
settled = { every token standing in the CONFIRMED map } ∪ recorded
answer  = transactions - settled
```

**[N]** From the **confirmed** map, not the outbox. A transaction the outbox has
never heard of is not settled — it is one this client never queued, or one whose
bytes died with a tab, and answering "portable" for either answers for something
that does not exist anywhere.

**[I]** This is the question a consumer asks before handing a snapshot to
anything that will read it elsewhere. An empty answer is what makes the snapshot
portable.

### 13.12 Content reading

**[N]** Read order: the cache keyed by **content token**, then the server.
Keying by token rather than by id is what makes the cache correct without an
invalidation step — a `write` event advances the token, so the old line simply
stops being asked for.

**[N]** A queued write's payload MUST be remembered under **its own transaction
id**, which the client minted and the server records unchanged. Without it a file
cannot be read back until it is confirmed, which is the one thing an offline
client cannot wait for.

**[N]** `at(entry, version)` MUST check the **outbox first**. It holds versions
the server has never heard of; asking the wire for one gets a 404, which is the
right answer to the wrong question.

**[N]** Who else to trust is **not** decided here. An editor holding a buffer
somebody is typing into knows something this does not, and only the consumer
knows it has one.

### 13.13 Paths

**[N]** The wire is entirely id-addressed. Paths are derived client-side from the
**effective** view, so a queued rename moves a file's path before the server has
answered.

**[N]** A reachable entry is one every step of whose ancestry is live. A deleted
folder's contents keep their rows and lose their path — which is what a user
means by deleting a folder.

**[N]** The walk MUST guard against cycles.

### 13.14 The shared-document rule

**[N]** When a consumer says an entry has a live shared document, path-addressed
`write` for that entry MUST be **refused locally**, with an error naming the
alternative.

**[I]** Content authored in a document moves only as CRDT updates. A client that
reads its file, diffs it and types the difference in creates NEW characters, so
when the original author's edits arrive the file says everything twice. Only
content that was never in a document — a kernel's output, an upload, a restore
from server history — is ever diffed in, and that is safe precisely because no
second copy of it exists.

**[N]** Three doors are therefore deliberately left open: `shares()` (used *by*
the document), `keep()` (drafts, by entry id — a file being deleted underneath
somebody is exactly when their unstored work needs keeping, and by then it has no
path), and `restore()` (text that came out of the server's own history, which
nobody's document holds a second copy of).

### 13.15 Kernel output

**[N]** Execution outputs MUST be reduced to plain JSON **before** they are
queued. A queued transaction is written down, and structured clone refuses a
class instance, a proxy, a function — and kernel output is full of those. The
failure is not local: the clone throws, the whole durable write fails, and one
unstorable output turns into "your work is not being saved".

**[N]** JSON is the right filter rather than a lucky one: the server stores these
as JSONB, so anything that does not survive the round trip was never going to be
kept. On circular structures or BigInt, keep the run and lose the shape.

---

## 14. The collaboration seam

This section is normative **only for implementations that have a collaboration
plane**. Everything above works without it.

### 14.1 What the room holds

**[N]** The room's document holds **text and nothing else**. Which stored version
that text descends from is bookkeeping, and it lives on the **host**. Putting it
in the document makes advancing it a write, so one person saving costs a round
trip to the collaboration server for every client that heard.

### 14.2 The plan

Given a room `{text, base}` and a file `{text, version}`:

```
base is null                → Seed(file.text, file.version)   -- nobody filled it
base == file.version        → Settled                          -- nothing to do
room.text == file.text      → Rebase(file.version)             -- bookkeeping only
otherwise                   → Carry(since=base, to=file.version)
```

**[N]** "Unseeded" is asked of the **base**, not the text: a file is allowed to be
empty, and a room judged by its text would be seeded again every time — doubling
its contents.

**[N]** `Rebase` exists for a write whose bookkeeping has not arrived yet. The
write travels through the server and the room's note of it through the document,
and nothing orders the two.

**[N]** A carried update MUST be built on the room's **live** state. A Yjs update
computed against a stale one is dropped without a word.

### 14.3 The three routes

**[N]** `POST /rooms/{e}` — idempotent, and the **only** way a room is ever
filled. Free in the common case, which is by a wide margin the common case: the
usual reason to ask is that somebody just saved and every other client with the
file open heard about it. A null `base` in the answer is not a failure — it is
what a file that is not text a room can hold says.

**[N]** `POST /rooms/{e}/warm` — answered `202` before the work starts. Creating a
room, asking what it holds and filling it is three calls and a second or two;
somebody *opening* a file waits for all of it, because an editor bound to an
unfilled room shows an empty document and then saves that over the real file.
Nobody is waiting when a file is **created**, so that is where this belongs.

**[N]** `POST /rooms/{e}/stored` — a member wrote the file, so the room already
holds the text and nothing is sent to the collaboration server. This is the whole
saving: the alternative is every client that hears about the write asking what
the room contains, which this host already knows.

**[N]** `POST /rooms/{e}/updates` — forward a client's own document update,
**forwarded and not interpreted**. The update carries its own identities, so it
merges exactly once however many routes it arrives by, including the client's own
connection when that returns. Sized like a blob, for the same reason: it is the
one route whose body length a caller chooses.

### 14.4 Caching

**[N]** The host MUST cache what it remembers about each room in memory. Every
client with a file open asks the host to settle its room each time anybody saves;
if answering meant a round trip, one person typing would cost one round trip per
collaborator per save. The table is the durable copy; the memory is the one that
answers.

**[N]** Locking MUST be **per entry**, not registry-wide. A registry-wide lock
puts every first open behind one round trip.

### 14.5 Bulk warming

**[N]** After a clone or bulk place, rooms are warmed **outside** the controller,
bounded in concurrency (8 in the reference implementation **[H]**), and failures
are **swallowed**. The work is already committed; a room this could not settle is
settled on the next open. Turning a collaboration server's bad minute into a
failed clone trades something durable for something that is only ever an
optimisation.

---

## 15. Invariants

These are the rules no change may break without an explicit recorded decision.

**S — server**

- **S1** One door for state. The five logs are the only record of what happened,
  and they are also the event stream. No publish step exists that can fail
  independently.
- **S2** The choke point is the only writer of positioned rows, and position,
  rows and commit are one database transaction.
- **S3** Initialize is one database transaction: adjudication, settling,
  snapshot, and the position-bound token together.
- **S4** Judgement is pure. No refusal is derived from stored state about
  refusals; re-presenting a transaction re-runs the same function.
- **S5** Every refusal is recorded, with exactly what applying it would have
  written. Including `CREATE_REFUSED`.
- **S6** Refusal rows are invisible to the stream, the delta chain and dedup —
  by living in other tables, not by filtering.
- **S7** A transaction id is spent once, on one operation, against one entry, and
  the check spans all five logs in both directions.
- **S8** Version tokens are per-property and equality-only. `UNKNOWN_VERSION` is
  a distinct class from a lost race.
- **S9** The server never remaps an id.
- **S10** Metadata carries no content descriptor.
- **S11** Replay is spliced onto live by subscribe-then-read, deduplicated by
  position; the replay read sees all five logs at one snapshot.
- **S12** Stream tokens are single-use, position-bound and short-lived, claimed
  in one statement.
- **S13** Snapshots, executions, clones and study rows take no position and
  produce no event.
- **S14** Blobs are immutable and content-addressed; only pointers go stale.
- **S15** One process per workspace. Not enforced; partially guarded; documented
  as the operator's promise.
- **S16** Tombstones outlive the longest offline session.

**C — client**

- **C1** One door for confirmed state: Initialize snapshots and stream events
  only. Responses adjudicate the outbox and nothing else.
- **C2** The effective view is derived, never patched; changes are derived by
  comparing two views.
- **C3** An overlay never advances a version token.
- **C4** Order is sacred in the outbox: counter order in, counter order out.
  Writes chain per entry; they do not coalesce.
- **C5** Capture before send. The row that names a payload is durable before the
  payload for new work, and after it for promotion (§13.4).
- **C6** No client-side "newer than" reasoning exists anywhere.
- **C7** A transaction leaves the outbox on its event, on a rejection, on a
  draft, on Initialize's verdict, or on lost bytes — never on a plain
  acknowledgement.
- **C8** `recorded` is durable and never pruned.
- **C9** Nothing on the reconcile path throws on unreadable work; it is named and
  dropped.
- **C10** Conflicts are never silent: a rejection produces a visible retraction.
- **C11** Text that came out of a shared document reaches the file only through
  that document.

**X — cross-cutting**

- **X1** The wire contract is declared once and generated from, never
  hand-copied.
- **X2** "Which logs does this operation write" is one function, shared by
  dedup, refusal recording and event announcement.
- **X3** "What may a name be" is one function, shared by entry naming and path
  splitting.
- **X4** Unicode normalisation happens at the door, once.

---

## 16. Divergences, gaps, and porting notes

### 16.1 Where `docs/ARCHITECTURE.md` no longer matches `release/`

These are documentation drift, not bugs. Each should be fixed in the map, and
this spec should be treated as the current truth.

| ARCHITECTURE.md says | `release/` does |
|---|---|
| §8 invariant 5: "coalescing is per-entry, writes-only" | Writes **chain**; coalescing was removed because it discarded every snapshot but the last (`outbox.ts` header) |
| §9: "Stream event types: 5" | Six: `create, name, parent, move, delete, write` |
| §9: "Request types: 7 (…Store…Content)" | Eight submittable ops: `create, delete, rename, reparent, move, write, snapshot, execute`; Store and Content are endpoints, not transactions |
| §9: "Server tables beyond the domain schema: 1 (stream tokens)" | Tokens, 7 refusal tables, 2 caches, rooms, cloned, snapshots, executions, 3 chat, 5 study |
| §9: "Client persistent stores: 2" | Three durable things: queue, bytes-by-hash, **and `recorded`** |

Also, prose vs code inside the contract itself: `Version.size` is documented as
"characters for text", and the implementation stores `len(content.encode())` —
UTF-8 **bytes**. Pick one; §9.1 currently documents the code.

### 16.2 Genuine gaps worth deciding on

These are places where the implementation is self-consistent but has a behaviour
worth confirming rather than inheriting. None is a correctness bug.

1. **Acknowledged-but-eventless transactions linger in the outbox until the next
   Initialize.** A client evicts on stream event, rejection, or draft. Three
   things are acknowledged and produce no event: `snapshot`, `execute`, and a
   `delete` of an already-deleted entry (§6.7). They stay queued until Initialize
   sweeps them into `applied`. Harmless for the view (the effective overlay
   ignores all three) and idempotent on the server, but it means a long-lived
   healthy stream accumulates queued no-ops, and every one is re-sent at every
   reconnect. *Options:* have the client evict on acknowledgement for ops that
   are declared eventless; or have the server emit nothing but return a flag —
   the same shape `draft` already uses.

2. **The 10 000-transaction Initialize cap has no client-side counterpart.** An
   outbox that exceeds it fails validation, and the loop re-enters at Initialize
   and fails identically for ever — the exact failure mode §13.9 was written to
   prevent, one level up. *Options:* chunk the presentation; or make an
   over-cap outbox a reported loss with the same door as unreadable bytes.

3. **A refused `move` carries no rebase token.** `_TOKEN_AT_STAKE` has entries
   for rename, reparent and write, and none for move — so a move that lost a
   name race is refused with `version: null`, and a client that wants to rebase
   has to re-Initialize or re-read. Deliberate? A move presents two tokens, so
   there is the same argument as for delete; but unlike delete, the reason
   string already says which one lost.

4. **`predecessor` is unauthenticated across users.** `_refusal_named` looks up
   a refusal by id and entry. Confirm it is also scoped to the requesting user —
   otherwise one client can cause its refused text to be stored as a delta
   against another client's refused text, which is a storage-shape leak rather
   than a disclosure, but is still cross-tenant coupling inside a workspace.

5. **`Snapshot.id` when `entries` is empty** is the transaction's own id, which
   is not an entry id. Nothing reads it, so this is benign — but a port that
   adds a foreign key there would break.

6. **Name uniqueness has no database constraint** (§12.1). It is held up by the
   single-writer topology invariant. A port to a different concurrency model must
   replace it with something, not assume the database will complain.

### 16.3 What a port must supply

Everything marked **[H]**: table names for users and workspaces, the
`authorize` dependency, the database, the blob store, `heartbeat_seconds`,
`grace_seconds`, `max_blob_bytes`, the collaboration adapter, the tutor adapter,
the client's byte store and outbox persistence, and the client's timing.

Everything else — the eight operations, the refusal set, the ordering of checks,
the event mapping, the delta format, the loop — is fixed by this document.

### 16.4 Change log

| Version | Date | Change |
|---|---|---|
| 1.0-draft | — | First specification, derived from `release/` @ `576b33e` |
