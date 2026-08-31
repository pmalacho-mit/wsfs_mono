# wsfs — Conformance Suite

Companion to `SPEC.md`. Every row is a behaviour a conforming implementation
must exhibit, keyed to the clause that requires it. A port is finished when all
**MUST** rows pass.

Marks: **✓** = the existing suite already pins this (per the repo READMEs and
`AUDIT.md`); **○** = worth adding.

---

## A. Wire and shapes

| # | Behaviour | Clause | |
|---|---|---|---|
| A1 | `op` is present on every submitted request and is the discriminator | §5.1 | ✓ |
| A2 | A create with `type=file, content=null` is malformed, not refused | §5.2 | ○ |
| A3 | A create with `type=folder, content≠null` is malformed | §5.2 | ○ |
| A4 | An NFD name and an NFC name for the same string collide as siblings | §5.1 | ○ |
| A5 | `offset` outside ±1439 is rejected as malformed | §2.6 | ○ |
| A6 | A `parent` event at the root serialises `value: null` explicitly | §5.5 | ○ |
| A7 | A create event's `Metadata` rides in `value`, and `type` reads `file`/`folder` | §5.5 | ✓ |
| A8 | A `write` event carries no `value` | §5.5 | ✓ |
| A9 | Client types are generated from the server contract; hand-editing them breaks the build | §5, X1 | ✓ |

## B. Adjudication order

Each row: construct the state, submit, assert the **exact** reason string.

| # | Behaviour | Clause | |
|---|---|---|---|
| B1 | create → invalid name beats missing bytes beats bad parent beats too-deep | §6.6 | ○ |
| B2 | create into a never-created parent → `PARENT_UNKNOWN`, not `PARENT_DELETED` | §5.4, §6.4 | ✓ |
| B3 | create into a deleted parent → `PARENT_DELETED` | §6.4 | ✓ |
| B4 | create into a folder whose *ancestor* is deleted → `PARENT_DELETED` | §6.4 | ○ |
| B5 | create colliding on name is **accepted**, then settled by a `name` event | §6.6, §6.8 | ✓ |
| B6 | rename → `ENTRY_DELETED` before `NAME_INVALID` before CAS before `NAME_TAKEN` | §6.6 | ○ |
| B7 | write to a folder → `NOT_A_FILE`, decided before the token | §6.6 | ✓ |
| B8 | write to a deleted entry → `ENTRY_DELETED` (typed, so drafts can route) | §6.6 | ✓ |
| B9 | move into itself → `DESTINATION_INSIDE_ENTRY` | §6.6a | ○ |
| B10 | move into its own descendant → `DESTINATION_INSIDE_ENTRY` | §6.6a | ○ |
| B11 | delete of an already-deleted entry → acknowledged, **no event** | §6.7 | ○ |
| B12 | delete whose name moved → `…modified the name…`; content moved → `…content…`; both → `…content and name…` | §6.6 | ○ |
| B13 | delete where a *move* changed the entry reports it as **name** | §6.6 | ○ |
| B14 | 64-deep create → `TOO_DEEP`; 10 000th sibling → `FOLDER_FULL` | §6.4 | ○ |
| B15 | `..`, `.`, empty, `a/b`, `NUL`, trailing space, 256-byte name → `NAME_INVALID` | §6.3 | ○ |

## C. Compare-and-swap

| # | Behaviour | Clause | |
|---|---|---|---|
| C1 | A stale token yields the operation's stale reason **and** `version` = the current token | §5.3, §6.11 | ✓ |
| C2 | A token never issued yields `UNKNOWN_VERSION`, not a stale reason | §6.5 | ✓ |
| C3 | A token issued **for another entry** yields `UNKNOWN_VERSION` | §6.5 | ○ |
| C4 | A collaborator's write does **not** invalidate a pending rename | §2.2 | ✓ |
| C5 | A refused delete returns `version: null` | §5.3 | ○ |
| C6 | A refused create returns `version: null` | §5.3 | ○ |
| C7 | *(open, §16.2.3)* a refused move returns `version: null` today | §16.2 | ○ |

## D. Dedup and identity

| # | Behaviour | Clause | |
|---|---|---|---|
| D1 | Re-sending an accepted transaction returns the recorded outcome; one entry, ever | §6.2 | ✓ |
| D2 | An id spent on a rename, re-presented as a **write** → `ID_TAKEN` | §6.2 | ✓ |
| D3 | An id spent on a create, re-presented as a **rename** → `ID_TAKEN` | §6.2 | ✓ |
| D4 | An id spent against entry X, re-presented against entry Y → `ID_TAKEN` | §6.2 | ○ |
| D5 | A create whose **entry** id exists anywhere → `ID_TAKEN` (checked globally, not per workspace) | §6.1 | ✓ |
| D6 | Same-txn-id create retried never double-mints | §6.2 | ✓ |
| D7 | Snapshot / execute replay is acknowledged, not double-recorded | §6.10 | ✓ |

## E. The choke point and positions

| # | Behaviour | Clause | |
|---|---|---|---|
| E1 | Position, rows and commit are one database transaction | §6.9, S2 | ✓ |
| E2 | A create's four rows share one position; a move's two share one | §2.4 | ✓ |
| E3 | A rolled-back submission leaves a gap, and the gap is never reused | §6.9 | ○ |
| E4 | A controller re-seeded after retirement does not re-issue a position its predecessor issued | §6.9 | ✓ |
| E5 | High water is read from the logs, never from a counter | §6.9 | ✓ |
| E6 | A row constructed without the choke point cannot reach storage (`position = 0` sentinel) | §4.1 | ○ |

## F. Initialize

| # | Behaviour | Clause | |
|---|---|---|---|
| F1 | The outbox is adjudicated **in order**, inside the same transaction as the snapshot | §7 | ✓ |
| F2 | The snapshot reflects names settled in step 2 | §7, §6.8 | ○ |
| F3 | The token's position is read from the logs, not the counter; a rolled-back submission before it does not create a stream gap | §7, §8.2 | ○ |
| F4 | A refused create makes dependents `CREATE_REFUSED`, **and those are recorded** | §7 | ✓ |
| F5 | A `CREATE_REFUSED` write's text is recoverable afterwards through `/content` | §7, §9.6 | ✓ |
| F6 | Only the first queued write per entry is presented | §13.9 | ✓ |
| F7 | Applied and rejected ids both count as answers | §13.10 | ✓ |
| F8 | Stranded work is reconciled through Initialize after a stream kill | §13.8 | ✓ |
| F9 | *(open, §16.2.2)* an outbox over 10 000 does not wedge the loop | §16.2 | ○ |

## G. The stream

| # | Behaviour | Clause | |
|---|---|---|---|
| G1 | Replay-then-live splices with no gap and no repeat | §8.3 | ✓ |
| G2 | Subscribe happens **before** the replay read | §8.3 | ✓ |
| G3 | An event committed during the overlap is deduped by position | §8.3 | ✓ |
| G4 | Tokens are single-use: two racing connects, one winner | §8.2 | ✓ |
| G5 | An expired token is `401` | §8.2 | ○ |
| G6 | The replay read sees all five logs at one snapshot: a create committing mid-read is never split into a bare `name` or a `{parent, deletion}` | §8.4 | ○ |
| G7 | Events are grouped by transaction, not by position | §8.5 | ✓ |
| G8 | Heartbeats arrive on an idle stream | §8.1 | ○ |

## H. Content

| # | Behaviour | Clause | |
|---|---|---|---|
| H1 | Delta round trip: `apply(diff(a,b), a) == b` for text containing astral-plane characters | §9.2 | ○ |
| H2 | `recover_base(apply(d, a), [d]) == a` | §9.2 | ○ |
| H3 | Reconstruction of an older version walks backwards from the cache anchor | §9.3 | ✓ |
| H4 | text → binary → text still reconstructs the text chain | §9.3 | ○ |
| H5 | Deleting both caches changes no answer, only latency | §4.4 | ○ |
| H6 | Blob PUT verifies the hash (`409` on mismatch) and dedupes (`200` when held) | §9.4 | ✓ |
| H7 | Blob PUT without `Content-Length`, or over the limit, is `413` | §9.4 | ○ |
| H8 | Blob GET is refused for a workspace that references the bytes nowhere | §9.4 | ○ |
| H9 | Blob GET succeeds when only a **refused** write names the bytes | §9.4 | ○ |
| H10 | `/content?content=<refused txn>` returns the refused text, with `ETag` = the transaction | §9.6 | ✓ |
| H11 | A write refused twice: `/content` returns the **later** row | §9.6 | ○ |
| H12 | A run of refusals stores each as a delta against the previous when `predecessor` is supplied | §9.5 | ○ |
| H13 | A `predecessor` naming nothing is ignored, not refused | §5.2 | ○ |

## I. Drafts

| # | Behaviour | Clause | |
|---|---|---|---|
| I1 | A draft is acknowledged with `draft: true` and applies nothing | §10 | ✓ |
| I2 | A draft consumes no token: the next real write presents the same one | §10 | ✓ |
| I3 | No stream event follows a draft; the client evicts on the answer | §10, §13.10 | ✓ |
| I4 | `/drafts` lists uncleared drafts only, never refusals | §10 | ✓ |
| I5 | `/drafts/cleared` marks and does not delete | §10 | ✓ |
| I6 | Drafts are captured on offline create and on write-to-deleted | §10 | ✓ |
| I7 | History shows a draft as `draft` with `why: null`, never as `refused` | §11.1 | ○ |

## J. Controller lifecycle

| # | Behaviour | Clause | |
|---|---|---|---|
| J1 | One controller per workspace | §12.2 | ✓ |
| J2 | Submissions never overlap | §12.2 | ✓ |
| J3 | Fan-out reaches all streams in commit order | §12.2 | ✓ |
| J4 | Grace-period release, cancelled by a reconnect inside the window | §12.3 | ✓ |
| J5 | The release/acquire race under hammering produces no dying-controller handout | §12.3 | ✓ |
| J6 | Visit-created controllers do not leak | §12.3 | ✓ |
| J7 | Seeding one workspace does not block another workspace's first request | §12.3 | ○ |
| J8 | Startup refuses `WEB_CONCURRENCY > 1` without the acknowledgement variable | §12.1 | ○ |

## K. Client state

| # | Behaviour | Clause | |
|---|---|---|---|
| K1 | A response never mutates the confirmed map | §13.2, C1 | ✓ |
| K2 | Response-before-event and event-before-response converge identically | §13.2 | ✓ |
| K3 | An event for an unknown entry is ignored | §13.2 | ○ |
| K4 | An event confirming this client's own queued work announces **nothing** | §13.6 | ✓ |
| K5 | A refusal announces a change carrying `retracting` | §13.6 | ○ |
| K6 | Effective-view snap-back on refusal (rollback is recomputation) | §13.5 | ✓ |
| K7 | A queued write does not advance `content_version` in the view | §13.5 | ✓ |
| K8 | A queued write **does** move `modified`, with `accepted: null` | §13.5 | ○ |
| K9 | A queued create is not laid over an entry the server already confirmed | §13.5 | ✓ |
| K10 | Departures are announced before arrivals | §13.6 | ○ |
| K11 | An `accepted` change fires when `modified.accepted` stops being null | §13.6 | ○ |

## L. Outbox and the write pump

| # | Behaviour | Clause | |
|---|---|---|---|
| L1 | Outbox order in = order out | §13.3, C4 | ✓ |
| L2 | Writes to one entry chain; none is discarded | §13.3 | ✓ |
| L3 | A chained write is stored as a delta; the chain head holds whole text | §13.3 | ✓ |
| L4 | A delta larger than its payload is stored whole instead | §13.3 | ○ |
| L5 | Evicting a chain head hands its digest to the follower in one durable change | §13.3 | ○ |
| L6 | Two writes issued in one tick are captured in issue order | §13.7 | ○ |
| L7 | If the tail leaves during staging, the write is restaged, not queued against a ghost | §13.7 | ○ |
| L8 | A byte-store failure during capture takes the row back with it | §13.4 | ○ |
| L9 | Promotion stores whole text **before** re-pointing the row | §13.4 | ○ |
| L10 | Lost bytes evict and cascade; the rest of the chain still goes | §13.7 | ✓ |
| L11 | A store refusal leaves the item queued and readable as a delta | §13.7 | ○ |
| L12 | A follower presents the transaction of the accepted write in front of it | §13.7 | ✓ |
| L13 | A **draft** is never used as a predecessor token | §13.7 | ○ |
| L14 | A write whose create is still queued presents the create's transaction | §13.7 | ○ |
| L15 | Another client's write in the middle refuses everything behind it | §13.7 | ✓ |
| L16 | Unreadable items are dropped **before** the Initialize batch, not after | §13.9 | ✓ |
| L17 | The blamed transaction for a broken chain is the ancestor that lost its bytes | §13.9 | ○ |
| L18 | `recorded` survives a reload and is never pruned | §13.10 | ○ |
| L19 | `unsettled` reads the confirmed map plus `recorded`, not the outbox | §13.11 | ○ |
| L20 | A write superseded by a later write is still reported settled | §13.10 | ○ |

## M. The sync loop

| # | Behaviour | Clause | |
|---|---|---|---|
| M1 | Every disruption re-enters at Initialize | §13.8 | ✓ |
| M2 | Backoff resets only after a successful reconcile | §13.8 | ○ |
| M3 | The watchdog fires on a connection that is accepted and then silent | §13.8 | ○ |
| M4 | The socket is handed back in a `finally`, whichever side of the race won | §13.8 | ○ |
| M5 | `nudge` aborts a **healthy** stream (the `UNKNOWN_VERSION` case) | §13.8 | ✓ |
| M6 | A request dropped while the stream stays healthy is still resubmitted | §13.7 | ✓ |

## N. Torture / convergence

The suite that has already earned its place. Seeded, deterministic, replayable.

| # | Behaviour | Clause | |
|---|---|---|---|
| N1 | Random **request** drops → convergence | all | ✓ |
| N2 | Random **response** drops, after the server applied — the nasty case | all | ✓ |
| N3 | Random stream kills → convergence | all | ✓ |
| N4 | Initialize failures → convergence | all | ✓ |
| N5 | After healing: field-level convergence between client confirmed state and server truth, **with an empty outbox** | all | ✓ |
| N6 | Two clients, one workspace, overlapping writes and renames → both converge | §2.2 | ○ |
| N7 | Multi-tab: two clients in one browser converge via the stream | §2.5 | ✓ |
| N8 | A client offline across a timezone change replays with per-transaction offsets intact | §2.6 | ○ |

## O. Collaboration seam *(only if implemented)*

| # | Behaviour | Clause | |
|---|---|---|---|
| O1 | An empty file's room is not re-seeded (unseeded is judged by `base`) | §14.2 | ○ |
| O2 | `room.text == file.text` with a stale base rebases rather than carrying | §14.2 | ○ |
| O3 | A carried update is built on the room's live state | §14.2 | ○ |
| O4 | `stored` makes every other client's settle a no-op | §14.3 | ○ |
| O5 | `updates` merges exactly once when the same update also arrives by the client's own connection | §14.3 | ○ |
| O6 | Room routes reject an entry that belongs to another workspace | §5.7 | ○ |
| O7 | With `shared()` true, path-addressed `write` throws locally and `shares` does not | §13.14 | ○ |
| O8 | With `shared()` always false, the whole suite above still passes | §1 | ○ |

## P. Property-based checks worth adding

These are cheap and catch classes the table cannot enumerate.

- **P1** For any random sequence of valid operations applied to a fresh
  workspace, the tree derived by folding the stream from position 0 equals the
  tree derived by §4.2 queries.
- **P2** For any entry, `content` at every historical token reconstructs, from
  both directions of the cache anchor.
- **P3** For any interleaving of a client's queued outbox and a peer's applied
  transactions, the client's effective view after full drain equals the server's
  tree.
- **P4** No sequence of operations produces two live siblings with the same name
  under one parent.
- **P5** No sequence produces a live entry unreachable from the root except
  through a deleted ancestor.
- **P6** Position is strictly increasing over the stream, and every position
  belongs to exactly one transaction.
