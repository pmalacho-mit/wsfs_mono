# Every state two clients and a server can be in

A working document. The point is to enumerate first and decide second, so that
a design choice is visible as a choice rather than arrived at by accident.

Each scenario is marked **obvious** (there is only one sensible resolution) or
**choice** (more than one defensible answer; the options are listed and one is
recommended). The open choices are collected at the end.

---

## Vocabulary

### The four rungs a keystroke climbs

Almost every resolution below is "which rung is this work on, and what is the
next rung it needs". Naming them makes the whole matrix shorter.

| rung | where it is | survives | visible to |
|---|---|---|---|
| **1. typed** | browser memory | nothing | nobody |
| **2. kept** | local persistence (`y-indexeddb`) | tab close, crash, reboot | nobody |
| **3. shared** | the Liveblocks room | this client leaving | everyone in the room |
| **4. stored** | a version in the filesystem | everything | everyone, forever |

Only rung 4 is snapshot-able and permanent. Rung 2 depends on one machine.
Rung 3 depends on the room not being evicted.

**Work at rung 2 and no higher depends on a single laptop.** That is the
irreducible exposure, and no server design removes it.

### The second question every scenario has to answer

Each row below says what happens to the FILE. That is half of it. The other
half is **"can this client still be handed what it was looking at?"** — every
snapshot it took, resolvable by the server once a connection exists.

The two fail independently. A file can converge perfectly while a snapshot
naming work that never left one machine is unresolvable for ever, and the user
meets that as *the assistant cannot see my screen*. Taking a snapshot
therefore puts what is on screen on the server first — as content when the
room is reachable, as a draft when it is not — so the property is true by
construction rather than by luck.

### The two channels, which fail independently

| channel | carries | used for |
|---|---|---|
| **room channel** (Liveblocks) | Yjs updates | seeing each other type; rung 3 |
| **server channel** (HTTP) | stores, the change stream, page load | rung 4 |

They fail separately, and the interesting scenarios are all cases where one is
up and the other is not. "Offline" is not a state; it is four states.

### Ahead and behind

- **behind** — others hold work this client has not received
- **ahead** — this client holds work others have not received

**Behind is harmless. Ahead is the dangerous one.** A client that is behind can
store safely: it commits slightly older text, and the edits it hasn't seen get
stored moments later by whoever holds them. A client that is ahead cannot store
safely, for the reasons in D2 and B1.

### One transport rule, assumed throughout

> Content that came out of an editor moves as a **Yjs update**, never as text.
> Only content that was never in an editor (kernel output, an upload, a
> restore) is diffed in as text.

Text diffs create new characters, so the same work arriving twice survives
twice. Updates carry identity, so the same work arriving any number of times
lands once. Every "merge is safe" claim below rests on this.

---

## A. Both clients live, both channels good, overlapping

| # | situation | what happens | |
|---|---|---|---|
| A1 | both typing in one file | room merges continuously; both converge; each stores on its own debounce | **obvious** |
| A2 | one typing, one watching | watcher receives updates, stores nothing | **obvious** |
| A3 | both typing, one stores | the store captures a moment that may exclude the other's latest keystroke — fine, that client is merely *behind* | **obvious** |
| A4 | both store at nearly the same moment | two versions land, near-identical. Correct, but noisy history and double the writes | **choice — see C3** |

On reload after a clean session: outbox empty, local document equals the stored
version, nothing to replay.

---

## B. One client degraded

| # | situation | what happens | |
|---|---|---|---|
| B1 | **A loses the room channel, keeps the server channel**, keeps typing | A is *ahead*. Its work is at rung 2. B sees nothing. A must not store as the file's current content — see C1 | **choice** |
| B2 | A's room channel is flaky — drops and returns repeatedly | each return flushes A's updates; idempotent, so no doubling. The hazard is A storing in the window where it believes it is connected but has not finished flushing | **choice — see C2** |
| B3 | **A loses the server channel, keeps the room channel** | A cannot store, but its work reaches B at rung 3. **B's next store carries A's work to rung 4.** A is protected by B being online | **obvious** |
| B4 | A loses the server channel and is alone in the room | work reaches rung 2 only; replayed on A's next load | **obvious** |
| B5 | A loses both channels, keeps typing | identical to B4 | **obvious** |

B3 is worth dwelling on: it is the case where collaboration itself is the
durability mechanism. It also means a client that is *only* connected to the
room is in better shape than one that is only connected to the server.

---

## C. Both clients degraded

| # | situation | what happens | |
|---|---|---|---|
| C1 | both lose the room channel, both keep typing | both *ahead*, neither may store as current. On reconnect both sets of updates merge, each line once | **obvious** (given the transport rule) |
| C2 | both lose everything, return at different times | first back flushes and stores; second back merges and stores. Order does not matter | **obvious** |
| C3 | both are refused stores for a long stretch | work sits at rung 2 on two machines. Nothing is lost unless a machine is | **choice — see C1 at the end** |

---

## D. Disjoint in time — no overlap at all

The morning/afternoon case. This is where the surprising outcomes live.

| # | situation | what happens | |
|---|---|---|---|
| D1 | A works all morning, fully synced and stored, closes the tab. B opens in the afternoon | the room may have been evicted; B's load reseeds it from the stored version. B sees exactly what A left | **obvious** |
| D2 | A works in the morning **while ahead** (room channel was down), closes the tab. B opens in the afternoon | **B cannot see A's work — it exists only on A's laptop.** B edits and stores. The file now has B's changes and not A's. When A eventually reopens, A's local updates replay and merge, and A's morning work reappears in a file that has moved on | **choice — the big one, see C2 at the end** |
| D3 | A works in the morning, work reached the room but nobody ever stored it, both close | the work is at rung 3 only. It survives until the room is evicted, then it exists only in A's local persistence | **choice — see C4 at the end** |
| D4 | A and B both work at separate times, both accumulating local work | sequential merges on each return; safe under the transport rule | **obvious** |
| D5 | A never returns | A's rung-2 work is gone permanently | **obvious, and unavoidable** |
| D6 | A returns after the file has been deleted or replaced with bytes | A's document has nothing to merge into | **choice — see H2/H3** |

D2 is the scenario most likely to produce a "why did that happen" from a real
user, and it has no purely technical answer — see the choices section.

---

## E. Tab close, reload, crash

| # | situation | what happens | |
|---|---|---|---|
| E1 | clean close, everything stored | nothing to replay | **obvious** |
| E2 | crash with work in memory only (no local persistence) | **lost** — this is the entire argument for `y-indexeddb` | **obvious** |
| E3 | crash with local persistence | replayed on next load | **obvious** |
| E4 | reload while a store is in flight | the outbox already covers this; the load adjudicates it | **obvious** |
| E5 | **two tabs, same user, same file** | both attach to the same room and share local persistence. Updates from tab 1 reach tab 2 by both routes; idempotent, so it converges | **choice — is this supported? see C5** |
| E6 | reload while *ahead* | local updates replay on load and reach the room through the server; then the client is no longer ahead | **obvious** |

E6 is the quiet win of replaying document state at load: a reload is a way out
of being ahead, not just a risk to survive.

---

## F. Writes that did not come from a room

| # | situation | what happens | |
|---|---|---|---|
| F1 | a kernel or script writes text over a file two clients have open | no update exists to forward, so it must be diffed in as text. Safe: no second copy exists anywhere | **obvious** |
| F2 | who applies that diff — the server once, or each client independently | one actor deciding is one decision; N clients deciding is N chances to disagree | **choice — see C6** |
| F3 | a client that is *not* in the room writes the file | its content came from its own editor, so a second copy may exist | **choice — require any client with a document to join the room before writing** |
| F4 | bytes (a PNG) land over an open text file | the write lands; rooms stand down rather than merging; the editor becomes a preview | **obvious** |
| F5 | a snapshot is restored over an open file | server-origin content, so diff it in — possibly a very large diff | **obvious** |

---

## G. Room lifecycle

| # | situation | what happens | |
|---|---|---|---|
| G1 | room was never created (file predates the feature, or a tool made it) | created on first open, idempotently | **obvious** |
| G2 | room evicted while nobody was connected | next load reseeds from the stored version, plus replay from any returning client's local persistence | **obvious** |
| G3 | room evicted while someone is connected | the provider reconnects and re-uploads its state; idempotent | **obvious** |
| G4 | room preserved but stale — the file changed on the server while the room was cold | on open, the document's recorded version is behind the file's; the gap is diffed in as server-origin content | **obvious** |
| G5 | room holds unstored work *and* the file moved on underneath it | carry the gap in; the CRDT keeps the unstored work | **obvious** |

---

## H. The file stops being what the room shows

| # | situation | what happens | |
|---|---|---|---|
| H1 | file renamed or moved while open | rooms are keyed by entry id, not path — unaffected | **obvious** |
| H2 | file deleted while open | **choice — see C7** |
| H3 | file becomes binary while open | room stands down, document preserved but inert, editor becomes a preview | **obvious** |
| H4 | file restored to an earlier version while open | server-origin write, diffed in | **obvious** |

---

# The decisions

These were open when the enumeration was written. All but one are settled,
and the reasoning is worth more than the answer.
## Revised decisions

### C1 — what a client that is *ahead* does with work it cannot store

**Resolved: drafts.** The original three options collapse, because the premise
was wrong. The rule was never "you may not store"; it is **"you may not store
*as the file*"**. The work goes to the server immediately, is durable and
recoverable, and asserts nothing about shared state.

This also dissolves *"a held store is never retried"* from the known problems.
Nothing needs retrying to be safe.

And it is load-bearing beyond failure handling: a snapshot is only
reconstructable server-side when every token in it exists on the server. Today,
a user with unsynced typing who asks the assistant a question produces a
snapshot that cannot be resolved. Drafts make it resolvable, which is the normal
case rather than an edge case.

### C2 — how old local-only work can be before returning it surprises the user

**Resolved: always merge, no threshold.** Old local work always syncs.

The reasoning is that the previous version is always stored, so the state before
the merge is recoverable. The user can get back. That makes silent merging the
right default: it is never destructive, only occasionally surprising, and the
undo path exists.

This removes the product decision the original document deferred.

### C4 — closing the gap between shared and stored

**Unchanged recommendation: store on open** if the room's document holds work
the stored version does not. Nearly free, no timers, no server job.

With load-time replay from local persistence, the only remaining way to lose
rung-3 work is D5 — the room evicted *and* nobody holding it locally ever
returns — which is irreducible.

### C5 — one user in two tabs

**Resolved: explicitly supported, and tested as such.** Two tabs are treated as
two clients and must behave exactly like two browsers. Nothing may assume it is
the only client on this machine.

**The gotcha to test for:** local state is shared per origin, so the outbox and
the local document store are *not* private to one tab. Nothing may assume an
entry in the outbox was written by the tab that finds it. This is believed to
hold already, but it has never been exercised and must not be assumed.

### C6 — who carries an outside write into a room

**Resolved: the server, once.** Clients stop reacting to content changes for
entries they have open.

**Built, and it taught one thing worth keeping.** Moving the work to the server
did not move finding 3 with it: the server decided from one read of the room
and built its update from a later one, so a room that caught up in between was
handed what it already held. The rule survives the move -- *the content is the
authority, and it must be consulted against the read being acted on, not an
earlier one.* Whoever carries, carries under that rule.

### C7 — an open room whose file is deleted

**Resolved: the room stands down**, with a restore affordance — *and a draft is
written first.* No work that has not been stored may be lost to a deletion the
user did not make. The same rule applies to a file becoming binary.

### C3 — who stores, and how often

**Still open.** Deferred; it is history noise, not correctness.

---

## New scenarios that drafts introduce

| # | situation | resolution | |
|---|---|---|---|
| J1 | client is ahead and stores | write is labelled draft; file's current content unchanged; other clients unaffected | **obvious** |
| J2 | that client reconnects; its work merges; it stores again | the second write is current content. The draft is **cleared** | **obvious** |
| J3 | client is ahead, drafts, and never returns | draft remains uncleared forever — it is the only copy of that work | **obvious, and the reason drafts exist** |
| J4 | client drafts, reconnects, its work merges, and a *collaborator deletes that text* before anyone stores | the draft is **cleared**. The work reached people and was deliberately removed; that is editing, not loss | **obvious once the clearing condition is propagation rather than content** |
| J5 | client drafts repeatedly during one long disconnection | each draft supersedes the previous one *from the same client for the same entry* — the newer strictly contains the older's intent. Bounds the storage of a long offline session | **obvious**; the one safe use of supersession |
| J6 | two clients are both ahead and both draft | two independent drafts. Neither clears the other; they are different work | **obvious** |
| J7 | a draft is referenced by a snapshot sent to the assistant | resolvable, because the token is on the server. This is the main reason drafts are common rather than rare | **obvious** |
| J8 | the machine that made an uncleared draft never comes back | only the server can report this. The client's local draft list dies with the machine, so **the server owns the cleared flag** | **obvious** |
| J9 | client drafts, then the debounce fires again with no change | deduped by digest; no row written | **obvious** |

### Every scenario asks whether the snapshot survives

`SCENARIOS.md` now carries this too, but it belongs here because drafts are
what make it answerable: a snapshot names what was on screen, and what was on
screen may exist nowhere but one laptop. Taking a snapshot puts it on the
server first — content if the room is reachable, a draft if not.

Two things that turned out to be true of the SERVER side of this, found by
asking the question rather than by reasoning about it:

- A **refused** write is recorded and rebuildable, exactly as a draft is.
  Anything the server wrote down can be handed back, whatever it decided about
  it.
- A reconstruction answers **once per entry**, so two snapshots of one file
  taken at different moments are two requests, not one.

### The clearing condition

> A draft is created because this client's updates had not reached the room.
> It is cleared when they have.

Creation and clearing are the same predicate, flipped, and both are decidable
locally. Clearing is **not** "a later stored version contains this text" — see
J4, where that test would strand a draft that was never actually lost.

---

## Writes that did not come from a Yjs editor

`SCENARIOS.md` group F, made explicit, because this is where the transport rule
earns its keep.

The distinction that matters is not text-versus-binary. It is **whether a second
copy of this content exists in somebody's document.** Content from a script or a
kernel has no second copy, so diffing it in cannot double it. Content from an
editor always has one.

| # | situation | resolution |
|---|---|---|
| K1 | Python writes **text**, file open in nobody's room | commit the version. Nothing else. The next open finds the room behind and the server carries the gap in |
| K2 | Python writes **text**, file open in a live room | server commits, then carries the change into the room once, and advances `base`. Members receive it as an ordinary update. **No client computes anything** |
| K3 | Python writes **bytes**, file open in a live room | every open client writes a **draft of its current text first**, then the room stands down. The editor becomes a preview. No merge is attempted |
| K4 | Python writes **bytes**, file open in nobody's room | commit the version. Nothing else |
| K5 | Python **reads** a file that has unstored work in a room | it reads the stored version, which lacks that work. The client must checkpoint before handing a file to a kernel — this is what `dirty` is for. If the client is ahead and cannot checkpoint as current, an in-browser kernel should read the *document*, not the server |
| K6 | Python writes text to a file that a client is ahead on | both survive: the server's change lands in the room, the client's local work merges when it reconnects. Neither overwrites the other |

### How K2 is carried, precisely

Two requirements that are easy to conflate and both mandatory:

1. **What the diff is between.** Compute it between the two *stored versions* —
   the one the room records as its base, and the newly written one. Never
   between the room's live text and the new version: that would describe the
   users' unstored work as text to delete, and applying it would delete it.
2. **What the update is causally based on.** Apply those edits to the room's
   **live** document, and send the resulting incremental update. An update
   computed against a stale snapshot is dropped silently by Yjs — no error, no
   effect.

Because the room's live text has drifted from the base version, the diff's
positions no longer line up. Apply the change as a **patch with fuzzy
matching** (`fast_diff_match_patch` is already a dependency) against the live
text, then apply the minimal difference between the live text and the patched
result as document edits. Misplacement is possible in pathological cases;
loss is not, and duplication is not, because this content has no second copy.


---

# How the open choices were framed at the time

The options each decision chose between, kept because the rejected ones are
the argument for the chosen one.


Everything above marked **choice**, with the options and a recommendation.

## C1. What a client that is *ahead* does with work it cannot store

The case: A's room channel is down, A keeps typing, A can still reach the
server. The work is at rung 2 and cannot honestly be stored as the file's
current content, because the file's current content is supposed to be something
everyone's document agrees on.

**Option 1 — refuse and wait.** The store is declined; the work stays local and
goes when the room comes back. *Nothing is lost, but nothing is durable beyond
one laptop either, possibly for hours.*

**Option 2 — store it anyway as the file's content.** Then either other clients
never receive it (their next store silently drops it) or it gets pushed into
their documents as text (which doubles it when A reconnects). *Both outcomes are
bad; this is the one to rule out.*

**Option 3 — store it to a private lane.** Commit the work as a version that is
**not** the entry's current content: a draft belonging to A, snapshot-able and
recoverable, that asserts nothing about what the room says. When A reconnects,
the room merges normally, A stores properly, and the draft is superseded.

**Recommended: option 3, with option 1 as its fallback.** It is the only one
that gets the work to rung 4 without making a claim about shared state that is
not true. It costs a concept — a version that is not the current content — but
you already snapshot everything, so the storage machinery exists. It also turns
"a refused store is never retried", currently an open problem, into something
that does not need retrying to be safe.

If option 3 is too much for now, option 1 is correct and safe; it just leaves
the exposure in D5.

## C2. How old local-only work can be before returning it is a surprise

The case: D2. A's morning work resurfaces in the afternoon, merged into a file
someone else has since edited and stored.

**Option 1 — always auto-merge.** What a CRDT does by default. Correct in the
small, startling in the large: text a colleague wrote and abandoned yesterday
silently reappears inside today's file.

**Option 2 — always present it as a draft to accept or discard.** Safe, but
annoying for the ten-second disconnection that is the common case.

**Option 3 — merge below a threshold, offer a choice above it.** Short gaps
merge silently; anything older than the threshold surfaces as "you have
unsynced changes from *this morning* — merge or discard?"

**Recommended: option 3.** The threshold is a product decision rather than a
technical one; something on the order of the length of a working session. This
is the one place in the whole matrix where being technically correct and being
unsurprising genuinely diverge, and the user should get the casting vote.

## C3. Who stores, and how often

**Option 1 — every client stores on its own debounce** (today). Simple; produces
near-duplicate versions when two people type together.

**Option 2 — one member of the room is elected to store.** Less noise; needs an
election, and a handover when that member leaves.

**Option 3 — the server stores the room's content periodically.** No client
coordination; adds a server-side job and puts the server in the room.

**Recommended: option 1 now, option 2 when history noise becomes a complaint.**
This is a quality-of-history question, not a correctness one — worth deferring
until there is evidence of it mattering.

## C4. Closing the gap between shared and stored

The case: D3. Work reached the room, nobody stored it, everyone closed. It now
lives only in the room (until eviction) and in local persistence.

**Option 1 — try to store on tab close.** Best-effort and unreliable; browsers
do not guarantee it.

**Option 2 — store on *open* if the room's document holds work the stored
version does not.** The next person to open the file commits the previous
session's unstored work. Cheap, no timers, no server job.

**Option 3 — a server-side flush when a room empties.**

**Recommended: option 2, and it is nearly free.** Combined with replay from
local persistence at load, the only way to lose rung-3 work is for the room to
be evicted *and* nobody who holds it locally to ever return — which is D5, and
irreducible.

## C5. Is one user in two tabs a supported case?

Both tabs attach to the same room and share local persistence. Updates arrive
by two routes and are idempotent, so it should converge. The question is whether
it is *supported* — i.e. tested and reasoned about — or merely *not prevented*.

**Recommended: support it explicitly and add a scenario for it.** People open
two tabs constantly, and "it happens to work" is not a claim anyone should be
making without a test.

## C6. Who carries an outside write into a room

**Option 1 — each client notices and repairs its own document.** N clients
diffing independently; the current behaviour.

**Option 2 — the server carries it in once, and members simply receive it.**

**Recommended: option 2.** One decision instead of N, and it removes the
possibility of two members disagreeing about the same write. It also confines
text diffing — the one operation that can double content — to one place where it
can be reasoned about.

## C7. What happens to an open room when the file is deleted

**Option 1 — the room stands down**, like the binary case: the document is
preserved but inert, and the user is told.

**Option 2 — the next store resurrects the file.**

**Option 3 — deletion is refused while anyone has it open.**

**Recommended: option 1, with an explicit "restore" affordance.** Option 2
makes deletion unreliable; option 3 makes deletion depend on who is looking.

---

# What covers what

`../AUDIT.md` maps every row above to the scenario that covers it, names the
three that nothing covers, and records what the system was measured doing.
Kept there rather than here so that this document stays a statement of what
must be true, and the evidence for it stays somewhere that has to be re-run
to stay honest.
