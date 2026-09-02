# A line said twice

**Status: ROOT CAUSE FOUND.** Pre-existing — not caused by the change being
integrated when it surfaced. The cause is on the CLIENT, not the host: it
stores text the collaboration server has not got yet. See "The fix".

## The failure

`Sample` › "a person editing through the real UI loses nothing, round after
round" fails roughly **one run in five**. When it fails, it fails like this:

```
timed out waiting for round 1: soak-six.md to reach the other client -- saw {
  "wanted": "soak-six.md\nr0 r1 ",
  "got":    "soak-six.md\nr0 r0 r1 ",
  "acted":  ["0:type:soak-six.md", "1:type:soak-six.md"],
  "mineSays":  ["01a060a4-0a49-7526-b807-6b9bbbe8b95b"],
  "otherSays": ["01a060a4-0a49-7526-b807-6b9bbbe8b95b"],
  "shell": [{ "dirty": false, "stage": "open", "speaks": true, ... }]
}
```

**`r0` appears twice.** This is not a lost write or a slow one — it is the
doubling this whole design exists to prevent, and which the comments in
`room.svelte.ts`, `keeper.py` and `editor.ts` all warn about in different
words.

Three details narrow it considerably:

- **Both clients agree.** `mineSays` and `otherSays` are the same content
  version, so the doubled text is in the FILE, agreed by the server. This is
  not two clients disagreeing.
- **The file is settled.** `dirty: false`, so every write this client made was
  answered.
- **The room is open.** `speaks: true`, and only two plain `type` actions had
  happened.

## The cause

**The client stores text before the collaboration server has it.** The host,
settling, reads a room that genuinely lacks that text, correctly carries it in
— and the client's own copy arrives afterwards. The line is said twice.

`Room.saveVersion` names this hazard exactly:

> Storing text that is still on its way is the whole hazard: the server would
> see a write whose content the room does not have, carry it in, and then this
> client's own copy would arrive and say it twice.

The guard meant to prevent it is:

```ts
if (this.attached) await this.#provider?.handedOver();
```

Two ways through it. It is **skipped entirely when the room is not attached**,
which is the window a person hits by opening a file and typing at once. And
when it does run it rests on the provider's **status flag** (`ahead: () =>
provider.getStatus() === "synchronizing"`), which can still read as settled in
the moment between a local edit and the provider noticing there is anything to
send. Either way the client concludes its text has landed, stores it, and the
premise everything downstream depends on is false.

### The trace

From a failing run, logging every carry the host performed. The file is
`soak-three.md`, which the test expected to say `r3 r4 ` and which said
`r3 r3 r4 `:

```
[CARRY] guard=True before='soak-three.md\n' room='soak-three.md\n'
        after='soak-three.md\nr3 '
```

The room the host read held **no `r3 `** while the file already did. So the
carry was right, and so was everything around it. Read that line twice before
proposing a fix on the host: there is no guard the server can add here, because
at the moment it looks, the room really is missing the text.

### What this is not

Ruled out by measurement, not by argument — each an earlier hypothesis of mine,
each wrong:

| suspected | ruled out by |
|---|---|
| transport retries | the failing run reported `resends: 0`; nothing was ever retried |
| the reconstruction cache | reverting `_text_of` to `at()` left the rate unchanged |
| seeding onto a room that already has text | logged every `Seed`; all fired on empty rooms |
| a stale base reaching the carry | the trace above: `before` and `room` are identical |

One more trap worth writing down. **Two different failures share this test's
name**: text that arrives twice, and text that never arrives at all (`wanted
"…r11 "`, `got "…"`). A pass/fail count cannot tell them apart, and four
measurements were taken across that mixture before anybody classified it.
Classify by comparing the length of `got` against `wanted` before comparing any
rates.

## The fix

**Advance the room's base inside the write's own transaction.** When a write
carries content that came from the room, the server records that the room is
now at that version as part of committing it. Then `plan()` sees `base ==
file.version`, answers `Settled`, and no carry is attempted — there is no
window left to lose a race in.

That also retires the separate `stored` note, which is a second message with no
ordering against the first: `_moved` assigns blindly, so a late note drags the
base *backwards*, and making that note retryable would have widened the hazard
rather than closed it.

**Both writes that carry room content must say so** — the ordinary store, and
the `pagehide` rescue. `rescue` writes the room's text to the file with
`keepalive` as the tab goes; leaving it unmarked recreates the gap on exactly
the path the soak exercises most.

### `closing()`, and why it stays

`rooms.closing()` refuses to carry from a stale ancestor when the room's text
is reachable from the file's by inserting alone, carrying from the room itself
instead. It fixes a real defect — `carried()` doubles when the room already
holds part of the change, which `tests/core/rooms.py` reproduces every time —
but it is **not** what fixed this failure, and on its own it left the soak at
2/12.

It is kept as depth, not as the fix: one diff on a path that already diffs, no
storage, and the only thing between a base that is stale for some reason nobody
has enumerated and silent corruption. Three mechanisms were proposed for this
bug before the right one; the guard costs little enough to keep for the fourth.

## Why it is worth the trouble

Everything else in this system degrades honestly. Work that cannot be sent is
kept; a room that cannot be reached is said so; a refused write is reported.
This is the one failure that is *silent and wrong*: nobody is told, nothing
errors, and the file simply says something the person did not type. It is the
worst failure this codebase has, and the reason the soak test exists.
