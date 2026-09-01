# Handoff: testing `wsfs-pytutor-suede` on `main`

You are picking this up in the package's own repository. `release/` holds the
published code; everything else on `main` exists to test it.

**This is the composition root**, and it depends on all four of the others. That
is the single most important fact for testing it: the defects that live here are
not in any one piece, they are in how the pieces are wired together — and the
only thing that can see those is an end-to-end run.

| | What it is | How it is tested |
|---|---|---|
| `release/backend/` | episodes, progress, the study record | `pytest` — 13 tests |
| `release/frontend/` (the watcher) | when to offer help, and what to record | `vitest` — 56 tests |
| `release/frontend/Workspace.svelte` | the whole app, composed | a real browser |

## 1. The gates, in order

```bash
npx svelte-check --tsconfig ./tsconfig.json    # from a consumer app; see §3
npx vitest run                                 # 56 passed
./tests/run.sh                                 # 13 tests, containerised postgres
npm run test:browser -- --component Tutor --browser chromium --silence 300 --forward 5173,1153
```

The 56 `vitest` tests are the good news: the stuck detector, the nudge protocol
and the activity log are pure logic over a clock, so they are tested without a
browser and they are tested thoroughly. Port `tests/frontend/pytutor/` first —
`stuck.test.ts`, `nudge.test.ts`, `activity.test.ts`.

## 2. The defect class this package exists to catch

Every failure found in the monorepo that belonged to *this* package was a
composition failure — each piece correct, the wiring wrong. Two are worth
knowing by name, because both will happen again:

**A read that was secretly a write.** The tutor panel drew its attachment list
with `attached={attachable().visible.map(...)}`. `attachable()` calls
`snapshot({ resolveDirty: true })`, which *stores every dirty file* — a write,
evaluated during render. Svelte forbids state mutation in a template expression
and throws, so the `dirty = false` that should have followed the write was
refused, and the file stayed marked unsaved for as long as it was open. The
write had already gone out, so nothing was lost and nothing looked wrong; only a
soak test noticed. The fix was to split the two questions: `attachable()` writes
and is called only from `askTheTutor`; `filesOnScreen()` reads and is safe from
a template. Full post-mortem in the monorepo's `docs/a-file-that-stayed-dirty.md`
— port it.

**Declaration order in the composition root.** `Watching`'s constructor calls
`looking()` immediately, so the thing it looks at must be declared *above* it.
It was not, and the temporal dead zone meant nothing rendered at all. There is
no type error for this. The order in `Workspace.svelte` is load-bearing:
`whatTheyAreLookingAt` → `watching` → `onDestroy` → `events.subscribe` →
`laidOut` → `putTheTutorOnTheRight` → `attachable` → `askTheTutor`.

## 3. You need a consumer app, and here it is nearly the whole app

Because this package composes the others, its browser test mounts a real
workspace: explorer, dock, Monaco, runner, tutor panel. That means the app needs
a host with a database, a sync engine, and — for the tutor's answers — a model.

```bash
npx liveblocks dev --port 1153     # needs Bun on PATH; mints sk_localdev
```

Then `LIVEBLOCKS_SECRET_KEY=sk_localdev LIVEBLOCKS_BASE_URL=http://localhost:1153`
on the host, `VITE_LIVEBLOCKS_BASE_URL=http://localhost:1153` on the dev server,
and `--forward 5173,1153` on the run. **`--forward` is the step people miss** —
the browser is in a container, so the sync engine must be published on *its*
localhost, and without it rooms fail to open with no mention of a port.

**`Tutor` also needs a model key**, unlike every other component. With none, the
sample serves a tutor that says it is not wired to a model, and the test sees
the failure paragraph. That is correct behaviour, not a bug — but it means this
one test cannot be green in an environment without a key. Say so plainly in CI
rather than deleting the test.

## 4. `base` and `authorize` are required, and must stay required

The assistant's requests carry identity. When those props had defaults
(`base = "/wsfs"`, `authorize = () => ({})`), composing the panel into an app
produced unauthenticated requests, and the only symptom was the tutor's answer
failing. Types were perfect and every unit gate was green. Both props are
required with no defaults now, in `Workspace.svelte` and `WorkspacePane.svelte`.
Keep it that way, and make any future prop carrying a host or an identity
required too.

## 5. Traps that cost time in the monorepo

- **`Report server timed out` with no test output means the component did not
  compile.** A component that fails to build never reports, and that looks
  exactly like a hang. Ask Vite:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/src/lib/<X>.test.svelte`.
- **Do not filter your type gate by directory.** The monorepo's `typecheck.sh`
  reported only errors under `wsfs_*_suede/`, so a broken test component
  reported as clean.
- **Read the console before theorising about timing.** The `resolveDirty` defect
  above was diagnosed three times as an intermittent race, because the round it
  failed on varied. The actual cause was one line in `console.error` that no
  assertion was reading. A varying failure point is evidence of a varying
  *trigger*, not necessarily a varying cause.
- **Do not run the backend suite and the browser suite at once.** The backend
  suite's compose file creates a second docker network, and the browser driver
  picks its network by expecting exactly one — so a concurrent run dies with
  `Multiple networks found`, naming neither suite.
