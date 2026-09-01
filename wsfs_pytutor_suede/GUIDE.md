# A tour of `wsfs_pytutor_suede`

The embedded tutor for Python development: noticing that a student is stuck,
deciding whether to say anything, judging whether their program is getting
anywhere, and recording the experiment that measures whether any of it helps.

This is the live research surface, and the reason the rest of the codebase
exists. It is also the composition root: the only package that may depend on
all four below it.

---

## 1. `Workspace.svelte` is the composition

Almost nothing in it is declared here. It renders
`wsfs_svelte_suede`'s shell and fills the three holes:

```svelte
<Shell
  {workspace} {entering} {events} {editorFor}
  onReady={laidOut}
  protectedName={(path) => headerFor(path) !== undefined}
/>
```

It also takes **`base` and `authorize`**, and neither has a default. The chat
and the study mount over core's prefix and build their own requests, so they
need the same base URL and the same authorisation the transport was built with
— and a default that sent no credentials would be a silent 4xx that types
cannot catch and a person experiences as *"the tutor stopped before
finishing"*. That is exactly how it was found.

- **`editorFor`** returns `PythonFile.svelte`, which is the one place all three
  UI packages meet: the problem statement (this package's), Monaco and the
  terminal (`wsfs_python_suede`'s), inside a file the shell owns.
- **`events`** feeds `Watching` — every panel opened, closed or focused, and
  every edit, is something the idle rule counts.
- **`onReady`** gets the grid, and puts the chat panel on the right. It also
  gets `override`, which is what the kernel is built with.

**One ordering trap, and it is enforced by the browser suite.** `Watching`'s
constructor calls `looking()` immediately, so `whatTheyAreLookingAt` has to be
declared before `watching`. Getting that wrong is a temporal-dead-zone
`ReferenceError` that renders nothing and looks like a layout failure. The
declarations in that file are ordered deliberately; keep them that way.

## 2. `stuck.ts` — the rules

Three, and they are the feature:

| Rule | Fires when |
|---|---|
| the same error twice | two runs end with the same error |
| idle | nobody has done anything for a while |
| no progress | the model says the program has not moved toward its goal |

**Nothing here reads a clock or tosses a coin for itself.** Both are handed in,
so a twenty-minute cooldown is tested in twenty milliseconds and the coin lands
where the test says. That is the most valuable property this code has — a rule
about time that can only be tested by waiting is a rule nobody tests. Preserve
it exactly.

**Detecting and offering are kept apart.** Detecting is a set of rules about
what a person has been doing. Offering is a study protocol laid over the top —
a coin toss, a cooldown, a post-episode window — which decides whether a
detection is allowed to become a prompt.

**Every detection is recorded, including the ones that never reach a screen.**
`Became` has four values, not two: `offered` and `silent` are the randomized
arms an analysis compares, and the other two are detections that were never
eligible. Recording those is what makes "this student was stuck four times and
heard about it once" different from "this student was stuck once".

`settingsFrom` reads the URL — `?nudge.idle=10` — over whatever the course
configured, which is what makes a term's settings watchable in a minute.

## 3. `watching.svelte.ts` — the protocol, wired

Everything a component would otherwise hold at once: when to look at the clock,
whether a detection may become a prompt, what to write down, and what to say on
the person's behalf when they take it.

Three methods are the whole interface: `acted(kind, detail)`, `ran(outcome)`,
`typed()`. One interval drives the time-based rules — sized from the settings
rather than fixed, because a five-second tick is useless for a four-second
threshold and somebody testing with `?nudge.idle=4` would conclude the setting
does nothing.

`announce()` puts **every** detection in the console, whatever became of it.
The protocol's difficulty is that most of what it does is invisible: a
detection randomized into silence, one that arrived during a cooldown, and one
that never happened look identical from outside — like nothing.

## 4. `activity.ts` — the post-episode window

A rich record of what a student did in the minutes after an episode, for both
arms, which is the comparison. Cheap to call from anywhere including per
keystroke: outside a window it is a comparison against `undefined`.

## 5. The backend

```
main.py       POST /progress, and three write-only study routes
progress.py   whether the program moved -- one measurement, not a conversation
study.py      episodes, offers, cooldowns, windows, activity
models.py     five tables, built against core's
```

**`/progress` is not a question.** No transcript goes in and no turn comes out:
it is one measurement, asked on a timer by the client watching somebody work.
The verdict is the **first word** of the answer, because a sentence explaining
why there is NO progress contains the word "no", and half the ways of saying it
contain "yes" as well.

**`study.py` is the one place in wsfs allowed to lose data.** Spec §12.4. Study
rows have no outbox and must not get one: everything else wsfs stores is
somebody's work, and these are a study's observations of a term. Paying for
their certainty with a slower editor is a bad trade made on a student's time.

So every route answers 204 whether or not there was anything to write, and
`_kept` rolls back rather than raising. What keeps it honest is that the ids
are client-minted, so the retries a client *does* make are recorded once.

One thing that must not be lost: **an episode, its cooldown and its window land
in one transaction or none.** They are decided in the same instant by the same
coin, and an episode row claiming a window no row records is a worse record
than no row at all.

## 6. The one failure with no symptom

Idle detection depends on hearing edits attributed to **the person at this
keyboard**. That attribution is two signals across two packages:

| Signal | Where | Sufficient alone? |
|---|---|---|
| the Yjs transaction origin | `wsfs_svelte_suede` | yes |
| Monaco's `detailedReasons` | `wsfs_python_suede` | no — it names the gesture |

If the Monaco half breaks, the worst that happens is a vaguer `did`. **The
other way round, a peer typing looks like this student typing, nobody is ever
detected as stuck, and nothing fails.** The experiment quietly stops finding
anything.

Both tests live with the code they are about. Run those suites too before
releasing this one.

## 7. The two pytutor names

`pytutor_llms_suede` is a generic model-provider wrapper with **nothing to do
with tutoring**. `wsfs_assistant_suede` imports it; this package does not, and
`tools/audit-imports.py` enforces that. Every model call here goes through
`ITutor`, which the host constructs once and hands to both routers.

## 8. Running it

```bash
./tests/run.sh -k "episode or progress"
npx vitest run tests/frontend/pytutor
cd samples/frontend && npm run test:browser -- --component Tutor --silence 300
```

Watching the protocol by hand is the fastest way to understand it:

```
http://localhost:5173/?nudge.idle=5&nudge.cooldown=10&nudge.offerRate=1
```

`offerRate=1` makes the coin always say offer, so you see the prompt rather
than the silent arm. Every detection prints to the console either way.

## 9. Your first change

Add a fourth detection rule. `stuck.ts` is where the three live, `Rule` in
`backend/contract.py` is the closed set the server accepts, and
`tests/frontend/pytutor/stuck.test.ts` drives the rules with a fake clock — so
a new rule is testable in milliseconds.

Harder, and more valuable: the study currently records what a student did. It
does not record what they were *shown* — which prompt text, in what words. If
you want the experiment to say anything about phrasing, that is where to start.
