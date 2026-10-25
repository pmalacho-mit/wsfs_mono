# A file that stayed dirty

A post-mortem of the last failure in the browser suite, kept because the bug
was cheap to fix and expensive to find, and because the reason it was
expensive is a mistake anybody can repeat.

**Status: fixed.** `wsfs_pytutor_suede/frontend/Workspace.svelte` no longer
stores anything while it draws. The scenario that caught it —
`Sample` › "a person editing through the real UI loses nothing, round after
round" — passed five consecutive runs after the change, having never passed
before it.

## The symptom

One scenario in `Sample.test.svelte` drives the real UI the way a person
drives it: open a file, type, sometimes close the tab, sometimes fire
`pagehide`, and after every round ask two questions. Does somebody else have
what was typed, and has the file settled — meaning `dirty` is false and the
tab is still open.

The first question always passed. The second timed out after 20 seconds:

```
timed out waiting for round 1: soak-six.md to settle -- saw [{
  "path": "soak-six.md", "open": true, "visible": true,
  "dirty": true, "stage": "open", "watched": true, "speaks": true
}]
```

The round it died on moved between runs — 0 sometimes, 1 others. **That is
what made it look like a race, and it is why this took three passes to
diagnose.** It was reported twice as an intermittent timing fault in the store
path. It was neither intermittent in cause nor in the store path.

## What the failure actually said

Two facts are visible in that one line, and together they rule out most of
what "a file stayed dirty" suggests.

`speaks: true` — **the room was open.** Every path through
`Room.submitVersion()` clears `dirty`: the ordinary path returns a transaction,
and the withheld path returns `#recordDraft(...)`, which always carries a
non-null draft, so `#leftThisMachine` is true either way and
`#nothingUnsent()` runs. A file with an open room that is still dirty has
therefore not been through `submitVersion()` since it was last typed into.

The preceding assertion had passed — **the other client already had the
text.** It reads `client.workspace.holding(path)`, which is that client's view
of the *file*, fed by the server. So the write had not merely been attempted,
it had landed and been streamed to a second client.

Put together: the write succeeded and the flag saying "there is unsent work
here" was never cleared. Nothing was lost. It was bookkeeping, and it was
stuck.

## The cause

`Workspace.svelte` drew the tutor panel with this:

```svelte
attached={attachable().visible.map(...)}
```

`attachable()` calls `shell.snapshot({ resolveDirty: true })`. `resolveDirty`
means *store every dirty file first*, so that the versions a question names
are the versions the person was looking at. It is the right thing for a
question. It is a **write**.

That expression is a template expression, evaluated during render. Storing a
file ends in `#nothingUnsent()`, which assigns `this.dirty = false` — a
`$state` mutation. Svelte forbids state mutation inside a template expression
or a `$derived`, and it does not warn: it throws.

```
Uncaught Svelte error: state_unsafe_mutation
Updating state inside `$derived(...)`, `$inspect(...)` or a template
expression is forbidden.
    in Panel.svelte
```

The write itself had already gone out — which is why the other client had the
text — and the assignment that would have recorded it was refused. The file
stayed dirty for as long as it was open.

The apparent randomness was never in the store path. It was in *when the
tutor panel happened to re-render while a file was dirty*, which depends on
which action the seeded sequence picked that round.

## Why it hid for so long

Three things kept it quiet, and each is worth recognising on its own.

**It only exists when the packages are composed.** `wsfs_svelte_suede` owns
the snapshot and `wsfs_pytutor_suede` owns the panel that asks for one. Each
is correct alone. The defect is in how the second uses the first, so no unit
test in either package could see it, and `svelte-check` cannot see it at all —
the types are perfect.

**It needs a real room.** Without a Liveblocks server no room opens, the file
takes a different path out, and the scenario fails for an unrelated reason
that looks the same from outside. It became reproducible only after the local
sync engine was wired up.

**The error went to the console and the assertion did not read it.** The test
asserted on a snapshot; the explanation was one line away in
`console.error`, unread. Adding `quiet()` — the harness helper that collects
`console.error`, `error` and `unhandledrejection` — to the failure message
produced the cause on the first run, after three sessions of hypothesising.

## The fix

Split the two uses, because they are two different questions and only one of
them is allowed to write.

```ts
/** What a QUESTION carries: stored first, so the versions are the ones seen. */
const attachable = () => {
  const taken = shell?.snapshot({ resolveDirty: true });
  return { entries: taken?.entries ?? [], visible: filesInView(taken) };
};

/** What the PANEL draws, taken without storing anything. */
const filesOnScreen = () => filesInView(shell?.snapshot()).map(...);
```

A plain `snapshot()` only reads — `storeEveryDirtyFile()` runs under
`resolveDirty` and nowhere else — so it is safe from a template. `attachable`
stays exactly as it was and is now called only from `askTheTutor`, where
somebody has asked for something and a write is what they asked for.

## What to take from it

**A getter that stores is a trap, whatever it is called.** `attachable()`
reads like a question. It was a command. The name is what let it be dropped
into a template without anybody thinking about it, and the fix is really the
rename: `filesOnScreen` asks, `attachable` acts.

**Read the console before theorising about timing.** A varying failure point
is evidence of a varying *trigger*, not necessarily a varying cause. Three
rounds of plausible reasoning about debouncers and network races were beaten
by one line of captured output.

**Where two packages meet, only an end-to-end test is looking.** This class of
defect — each side correct, the composition wrong — is precisely what the
browser suite is for, and it is the argument for keeping the room suites
runnable rather than skipped. See `docs/GUIDE.md` for running them against a
local sync engine, which costs nothing and is what made this reproducible.
