# Testing `wsfs_pytutor_suede`

> [!NOTE]
> This file describes how to set the suite up on this repository's **`main`**
> branch. What you are reading now shipped inside `release/`, so the paths
> below are `main`'s: this package's source is at `release/`, and everything
> the suite adds lives beside it.

**The most valuable property this code has is that nothing in it reads a clock
or tosses a coin for itself.** Both are handed in, so a twenty-minute cooldown
is tested in twenty milliseconds and the coin lands where the test says. A rule
about time that can only be tested by waiting is a rule nobody tests. Preserve
that exactly; it is what makes this suite fast enough to be run.

---

## 1. What `main` looks like

```
wsfs_pytutor_suede/
  release/                     <- this package (backend/ + frontend/)
  wsfs_assistant_suede/        <- root-owned, like every dependency here
  wsfs_python_suede/
  wsfs_svelte_suede/
  wsfs_core_suede/
  sqlmodel_utils_suede/
  dockview-svelte-suede/  with-events-suede/
  samples/backend/app.py       <- a host mounting core, the assistant AND this
  samples/frontend/            <- the SvelteKit app the shell is rendered in
  tests/  tests/frontend/
  pytest.ini
```

This package sits at the bottom of the graph because it is the only one that
needs two siblings at once: edits attributed to *this* person (Monaco's, through
`wsfs_python_suede`) and a model to judge progress with (`ITutor`, through
`wsfs_assistant_suede`). That is not a smell — a tutor for Python development is
supposed to know about Python and about the assistant it hands students to.

Install every dependency with `--root-owned`. Four packages meet here, and the
default per-dependent naming would give each of them several paths; TypeScript
reads two paths as two nominal types and Python builds two module objects.

## 2. Running it

```bash
./tests/run.sh                   # backend, against a throwaway postgres
./tests/run.sh -k episode -x
npx vitest run                   # the detection rules and the window
cd samples/frontend && npm run check
```

## 3. The study rows are allowed to be lost. Test that they are.

Spec §12.4, and it is the one place in wsfs where losing data is correct: study
rows have **no outbox and must not get one**. Everything else wsfs stores is
somebody's work; these are a study's observations of a term, and paying for
their certainty with a slower editor is a bad trade made on a student's time.

So the tests to have are the unusual ones:

- a batch of activity whose episode was never recorded is **dropped**, and the
  route still answers 204 — a client whose detection post was lost is still
  reporting what happened after it, and there is nothing to attach that to;
- a retried post is recorded **once**, because the ids are client-minted;
- an episode, its cooldown and its window land in **one transaction or none** —
  they are decided in the same instant by the same coin, and an episode row
  claiming a window no row records is a worse record than no row at all.

## 4. Every detection is recorded, including the silent ones

`Became` has four values, not two. `offered` and `silent` are the randomized
arms an analysis compares; `held back by the cooldown` and `held back by a
post-episode window` are detections that were never eligible.

Recording them is what makes *"this student was stuck four times and heard about
it once"* different from *"this student was stuck once"*. A test that only
checks the prompts cannot tell either from a student who was never stuck at all
— so assert on the arms that produce no visible effect.

## 5. `/progress`, and why it costs nothing extra

The route is this package's; the model behind it is the assistant's `ITutor`.
The host builds ONE tutor and hands it to both routers, so there is one key, one
model choice, one fallback.

`tests/progress.py` uses the same `Scripted` tutor the assistant's suite does
(`tests/tutors.py`), and asserts the thing that makes this not-a-conversation:

- the verdict is the **first word**, because a sentence explaining why there is
  NO progress contains the word "no", and half the ways of saying it contain
  "yes" as well;
- **no transcript goes in** — something said an hour ago must not decide what
  this minute looks like. The test puts a conversation there first and then
  checks the prompt has no trace of it;
- **no turn comes out.** It is a measurement; the transcript must not grow one.

That middle test reaches the assistant's routes as well as this package's, which
is why the mounted host app in `samples/backend` mounts all three routers.

## 6. The fragile input, and the test that guards it

Idle detection depends on hearing edits attributed to **the person at this
keyboard** — not to a peer, not to a formatter, not to the binding seeding the
surface. That attribution is two signals, split across two packages:

| Signal | Where | Sufficient on its own? |
|---|---|---|
| the Yjs transaction origin | `wsfs_svelte_suede` | yes |
| Monaco's `detailedReasons` | `wsfs_python_suede` | no — it refines the name |

**The failure mode to guard against is silent.** If the Monaco half is dropped
or broken while the Yjs half survives, the worst that happens is a vaguer `did`.
The other way round, a peer typing looks like this student typing, nobody is
ever detected as stuck, and *nothing fails* — the experiment quietly stops
finding anything.

Both tests live with the code they are about (`wsfs_svelte_suede`'s
`edits.test.ts` and `wsfs_python_suede`'s suite), and a change to either package
that breaks them breaks this feature. Run those suites too before releasing
this one.

## 7. The two pytutor names

`pytutor_llms_suede` is a generic model-provider wrapper with **nothing to do
with tutoring**. `wsfs_assistant_suede` imports it; this package does not, and
the import audit enforces that:

```bash
python3 tools/audit-imports.py
```

The two names will be confused. When they are, this section is the answer.

## 8. The application shell

`frontend/Workspace.svelte` is the composition root: the tree and the dock from
`wsfs_svelte_suede`, Monaco and the kernel from `wsfs_python_suede`, the chat
panel from `wsfs_assistant_suede`, the filesystem from core — and the nudge
protocol, which is the only part it declares itself.

It lives here because it is the only package that may depend on all four. The
intended end state is a generic `WorkspacePane` in `wsfs_svelte_suede` with
those four arriving through extension points, and this shell becoming the thing
that fills them; `FileView` has already been taken apart that way and is the
shape to copy.

Test it in the browser suite, not with `svelte-check` alone:

```bash
docker compose -f samples/compose.yml up -d --build
npm install && cd samples/frontend && npm install && npm run dev
npm run test:browser -- --component Tutor --browser chromium --silence 180
```

`--silence 180` because the default 120s window is too short and gives up with
`Report server timed out`, which reads like a hang and is not one. Run scenarios
one at a time and `curl -X DELETE http://localhost:8099/rendezvous` between
runs, or the second run meets the first one's agreed ids and tests nothing.
