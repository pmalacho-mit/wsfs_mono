# wsfs-pytutor-suede

**Role:** the embedded AI tutor for Python development — noticing that a student
is stuck, deciding whether to say anything, judging whether their program is
getting anywhere, and recording the experiment that measures whether any of it
helps. Backend and frontend.

This is the live research surface, and the reason the rest of the codebase
exists. It is also the fastest-moving repo in the set, which shapes several
recommendations below.

**Baseline:** `wsfs_suede` @ `576b33e`. Read `PORTING.md` §0 before acting on any
inventory here.

---

## 1. Boundaries

**BOUNDARY — depends on:** `wsfs-assistant-suede` (for the `ITutor` seam and the
chat panel) and `wsfs-python-suede` (for Monaco edit attribution). Both bring
`wsfs-svelte-suede` and `wsfs-core-suede` with them.

**BOUNDARY — must not depend on** `wsfs_suede__pytutor_llms_suede` **directly.**
Every model call goes through `ITutor`, which the host constructs once and hands
to both this repo and the assistant. See §4.

**BOUNDARY — nothing here reads a clock or tosses a coin for itself.** Already
true, and the most valuable property the code has: *"Both are handed in, so the
twenty-minute cooldown is tested in twenty milliseconds and the coin lands where
the test says. A rule about time that can only be tested by waiting is a rule
nobody tests."* Preserve it exactly.

**BOUNDARY — this is the only thing in the system allowed to lose data.**
Spec §12.4. Study rows have no outbox and must not get one. Everything else wsfs
stores is somebody's work; these are a study's observations of a term, and paying
for their certainty with a slower editor is a bad trade made on a student's time.

### Naming

`wsfs_suede__pytutor_llms_suede` is a generic model-provider wrapper with nothing
to do with tutoring — `wsfs-assistant-suede` imports it; this repo does not.
The two names will be confused. Say so in the README.

---

## 2. Why this repo sits at the bottom of the graph

It is the only package that needs something from two siblings at once:

| Needs | From | Why it cannot come from anywhere else |
|---|---|---|
| Edits attributed to *this person* | `wsfs-python-suede` | Monaco's `detailedReasons` is the only signal that names the gesture |
| A model, for `/progress` | `wsfs-assistant-suede` | `ITutor` — one provider, one key, one place that knows a model exists |
| Open the panel when an offer is accepted | `wsfs-assistant-suede` | the nudge's whole purpose |
| Runs and their outcomes | core, via python | executions: `outputs`, `ok` |

That is not a design smell. A tutor for Python development is *supposed* to know
about Python and about the assistant it hands students to. The dependency graph
matching the domain is the sign the split is right.

---

## 3. What it needs from `wsfs-python-suede`, and the fragile part

The detection rules are "the same error twice", "idle" and "no progress". Idle
detection depends on hearing edits **attributed to the person at this keyboard**
— not to a peer, not to a formatter, not to the binding seeding the model.

That attribution comes from the `edits.ts` split (svelte guide §3.2), which
separates two signals:

- the **Yjs transaction origin** — vendor-neutral, stays in the shared layer;
- **`detailedReasons`** — Monaco-specific, moves to `wsfs-python-suede`.

**The failure mode to guard against:** if the Monaco half is dropped or broken
without the Yjs half surviving, a peer typing looks like this student typing and
nobody is ever detected as stuck. Nothing fails. The experiment just quietly
stops finding anything.

**Work item, and do it before the `edits.ts` split happens:** write a test that a
peer's edit arriving through the shared document does not reset the idle timer.
Write a second that an edit with `detailedReasons` absent (the field is not in
Monaco's public typings and can vanish on an upgrade) still attributes correctly
via the Yjs origin.

---

## 4. `progress` lives here, and costs nothing extra

`Judging` / `Judged` and the `/progress` route are yours. It is a non-standard
assistant behaviour — one measurement, asked on a timer by something watching a
student work — and it belongs with the feature that asks it.

The wiring is free because the assistant exports the seam rather than only the
implementation:

```python
from wsfs_assistant import ITutor
from wsfs_assistant.llm import Tutor      # or any ITutor

tutor = Tutor(model=..., fallback=...)    # the host builds ONE

app.include_router(create_assistant_router(
    backend=backend, models=chat_models, authorize=authorize, tutor=tutor).router)

app.include_router(create_pytutor_router(
    backend=backend, models=study_models, authorize=authorize, tutor=tutor).router)
```

So this repo takes an `ITutor` and never imports a provider. One key, one model
choice, one fallback — and if you want the tutor's judgement to run on a
*different* model from the chat panel, that is one more argument at the
composition root rather than a second dependency here.

**Carry these across with the route:**

- The `Judging` / `Judged` shapes leave `contract.py` and are generated into this
  repo's schema.
- The docstring's insistence that this is *"NOT a question, and not part of
  anybody's conversation: no transcript goes in and no turn comes out"* — which
  is exactly why it does not stream, does not take a message id, and is not
  recorded. A future contributor will try to make it a chat turn.
- The `before` / `after` size caps (200k each as of `576b33e`).

**What stays with the assistant:** `MOST_TOKENS`, the model constants, the
fallback logic. Those are properties of the provider, not of either caller.

---

## 5. Backend or frontend?

Earlier drafts of this guide asked whether the tutor could be frontend-only.
With `/progress` here, it cannot — this repo has a `backend/`, and that settles
it. But the *shape* of the backend is still worth choosing deliberately, because
the two things in it have different lifetimes.

| Piece | Lifetime | Note |
|---|---|---|
| `/progress` | permanent | The intervention needs it |
| The study instrument | **per experiment** | Five tables encoding one experimental design |

The study's `Became` enum *is* the experiment: `offered` and `silent` are the
randomized arms, and `held_back_by_cooldown` / `held_back_by_window` are the
ineligible detections. A different study next term is a different enum.

**Recommendation:** keep both in this repo, but keep the study in one clearly
marked module with the wire shapes travelling with it, and put the recording
behind an injected seam:

```ts
export type Recorder = {
  detected: (told: Detected) => Promise<void>;
  accepted: (told: Accepted) => Promise<void>;
  activity: (told: Recorded, opts?: { keepalive?: boolean }) => Promise<void>;
};
```

Ship an HTTP recorder against this repo's own routes as the default, plus a
no-op. Three things become cheap:

- running the nudge **without** an experiment attached (swap in the no-op);
- running a **different** experiment next term (a second `Recorder`, no change to
  detection);
- lifting the study into `wsfs-study-suede` if a second experiment ever wants
  its own release cadence.

Given this is your active research surface, the second of those is the one that
will actually happen. Build for it now — it is a seam, not a refactor.

**Do not** route these through core's `Workspace` object the way `workspace.study`
does today. That is core knowing satellites exist.

---

## 6. Inventory as of `576b33e`

**INVENTORY caveat, stronger here than anywhere else:** this is your live
research code. Assume the file list below is the most stale thing in this
document set, and find things by role.

### Frontend

| Role | File | Anchor phrase |
|---|---|---|
| Detection rules + study protocol | `frontend/svelte/assistant/stuck.ts` (~395) | `Noticing that somebody is stuck` |
| The offer toast | `frontend/svelte/assistant/nudge.ts` | `The offer of help that appears when a run ends badly` |
| Window activity recording | `frontend/svelte/assistant/activity.ts` (~191) | *(check docstring)* |
| Goals | `frontend/svelte/assistant/goals.ts` | *(check docstring — verify it is pytutor, not assistant)* |
| Transport methods | `frontend/transport.ts`: `detected`, `accepted`, `activity`, `progress` | |
| Workspace surface | `frontend/workspace.ts`: the `study: {...}` group and `tutor.progressing` | → replaced by §5's `Recorder` |

### Backend

| Role | File |
|---|---|
| Recording | `backend/study.py` (~162) |
| `progress` route | `backend/main.py`, the `/progress` handler |
| Study wire shapes | `backend/contract.py`, `# -- the study` section (~156 lines) |
| `Judging` / `Judged` | `backend/contract.py`, in the `# -- the tutor` section |
| Tables | `backend/models.py`, `# -- the study` section (~171 lines) |

Tables: `StuckEpisodeRow`, `StuckOfferRow`, `StuckCooldownRow`, `StuckWindowRow`,
`StuckActivityRow`.

Shapes: `Rule`, `Became`, `Span`, `Detected`, `Accepted`, `Moment`, `Recorded`,
`Judging`, `Judged`.

Note the split-brain in `contract.py`: `Judging`/`Judged` sit under the
`# -- the tutor` banner alongside the chat shapes, because at `576b33e` they
shared a home. Grep for the class names, not the banner.

---

## 7. Behaviours that must survive the move

Six, all easy to lose and each worth a test before the file moves.

1. **Every detection is recorded, including the ones that never reach a screen.**
   `Became` has four values, not two. Recording the ineligible ones is what makes
   *"this student was stuck four times and heard about it once"* different from
   *"this student was stuck once."* A port that only records what was shown
   destroys the experiment without failing a test.

2. **One post, up to three rows.** An episode, its cooldown and its window are
   decided in the same instant by the same coin and are sent together. Sending
   them apart means a client that managed one request and not the next leaves an
   episode claiming a window that no row records.

3. **`Span` carries both ends, both from the client.** The protocol precalculates
   them — a cooldown is twenty minutes from when a prompt was shown, and the
   setting that says twenty could be different next term. Recomputing `until` on
   the server from today's configuration describes the server's present rather
   than the student's past. This matters more than it looks: it is what lets you
   change the protocol between terms without invalidating last term's data.

4. **`Moment` is deliberately open** (`extra: allow`). The shape belongs to
   whatever produced it. A server that parsed these would need redeploying every
   time the client learned to notice one more thing. Two fields are not open:
   `at` and `kind`.

5. **`Detected.code` holds the program at onset as text, not as a version.**
   *"What was on screen is not always what was stored, and this is evidence about
   the student rather than about the filesystem."* A port that "improves" this
   into a content token loses the thing it is for.

6. **The offer's wording is the protocol's, not decoration.** *"Looks like you're
   stuck"* tells a student a system has decided something about them; what is
   being measured is whether they *want* help, and a prompt that opens by
   diagnosing them is measuring something else. Do not let this get reworded in a
   UI pass.

---

## 8. Sequencing

This repo is **last** — it depends on both siblings. But it is also the one you
are actively developing, so the practical order is:

1. **In Phase 1, in the monorepo:** define `EditorSurface` and split `edits.ts`
   (svelte guide §3.2). Write the two attribution tests from §3 first. This
   unblocks python *and* protects your detection quality through the whole port.
2. **After step 7 (assistant):** confirm `ITutor` is importable and usable
   standalone — assistant guide §8.4. If it is not, `/progress` cannot move and
   the boundary needs revisiting before you go further.
3. **After step 9 (python):** extract this repo.

Within the repo, once you start:

1. Move `stuck.ts`, `nudge.ts`, `activity.ts` (and `goals.ts` if it belongs) out
   of `svelte/assistant/`.
2. Introduce the `Recorder` seam (§5) and drop `workspace.study`.
3. Make the offer's acceptance a callback rather than a direct panel import.
4. Move `study.py`, `/progress`, and their shapes and tables.
5. Point `progressing` at this repo's own client rather than core's.

---

## 9. How to know it worked

1. **Import audit clean** (`PORTING.md` §5). In particular: no `pytutor_llms`.
   `grep -rn "pytutor_llms" .` returns nothing.
2. **The whole detection protocol runs with an injected clock and an injected
   coin.** No `sleep`, no real randomness, no network. The twenty-minute cooldown
   tests in twenty milliseconds.
3. **A peer's edit does not reset the idle timer** (§3). The test that guards the
   `edits.ts` split.
4. **Attribution survives `detailedReasons` being absent** (§3). The test that
   guards a Monaco upgrade.
5. **`/progress` runs against a fake `ITutor` with no API key.**
6. **All four `Became` values are reachable in tests**, and each produces a row.
7. **With the no-op `Recorder`, the nudge still works and nothing is recorded.**
   Proof that a term without an experiment costs one line.
8. **Core, assistant and python all mount and serve with this repo not
   installed.**
9. **`CONFORMANCE.md` has no study rows in it, and never should.** Study
   telemetry is explicitly outside the durability contract that suite exists to
   prove. If someone adds a "no study row was lost" test, that is a sign the
   boundary in §1 has drifted.
