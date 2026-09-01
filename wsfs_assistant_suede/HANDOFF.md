# Handoff: testing `wsfs-assistant-suede` on `main`

You are picking this up in the package's own repository. `release/` holds the
published code; everything else on `main` exists to test it.

Two halves that are tested very differently: a backend that talks to a model,
and a panel that streams an answer into a conversation.

| | What it is | How it is tested |
|---|---|---|
| `release/backend/` | routes, transcripts, and `llm.py` | `pytest` against a **scripted** tutor over real HTTP — 16 tests |
| `release/frontend/` | the chat panel and the nudge | a real browser — 19 tests |

## The rule that makes this testable

**Only `llm.py` talks to a model.** Everything else takes an `Assistant` and
does not care what is behind it. That is what lets the backend suite run with
no model key and no network: `tests/assistant/tutor.py` stands up a scripted
tutor and drives the real HTTP routes against it.

If a test here ever needs a real model key, something has reached past `llm.py`.
Find out what before making the test pass.

## 1. The gates, in order

```bash
npx svelte-check --tsconfig ./tsconfig.json    # from a consumer app; see §3
./tests/run.sh                                 # 16 tests, containerised postgres
npm run test:browser -- --component assistant --browser chromium --silence 300
```

There are no `vitest` tests in this package. The panel's logic is inseparable
from its rendering — streaming deltas into a transcript, keeping the newest
message visible — so it is asserted in the browser instead.

## 2. What to port

- `tests/assistant/tutor.py` — the scripted assistant and the route tests. Read
  it first; it is the model of how to test an LLM feature without an LLM.
- `samples/frontend/src/lib/harness/tutor.ts` — the frontend's equivalent
  double. `scripted()` returns `{ assistant, respondWith, fails, asked, reads,
  breaks }`: `respondWith(...deltas)` sets the next answer, `fails(why)` ends it
  badly, `breaks(n)` makes the next *n* transcript reads fail as a flaky load
  would.
- The two browser components: `Assistant.test.svelte` (13) and
  `nudge.test.svelte` (6).

## 3. You need a consumer app for the browser half

A SvelteKit app importing `release/frontend`, plus `sweater-vest-suede` as a dev
dependency, plus this package's backend mounted somewhere the app can reach.

**And it must be authenticated.** This is the defect the browser suite caught in
the monorepo, and it is the one most likely to recur:

> The panel had `base = "/wsfs"` and `authorize = () => ({})` as *defaults*.
> Composed into an app, that meant no `X-User-Email` header, so every request
> was rejected — and the only symptom a person saw was the answer paragraph
> saying the tutor stopped before finishing. Types were perfect. The unit gates
> were green.

`base` and `authorize` are now **required props with no defaults**, precisely so
this cannot happen again. Keep them required. If you add another prop that
carries identity or a host, make it required too.

## 4. Traps that cost time in the monorepo

- **Tailwind does not scan `node_modules`.** `streamdown-svelte` names its
  utilities in its own `theme.js`, not in markup this project owns, so those
  classes were never generated. The cost: the copy and download buttons on every
  code block had `pointer-events-auto` dropped, so the `pointer-events-none`
  shell around them swallowed every click. The buttons were drawn, lit, enabled
  and unreachable, and nothing errored. Your `app.css` needs an `@source` line
  for `streamdown-svelte/dist` at whatever path your app resolves it to — and
  the path is relative to the CSS file, so it changes if the file moves.
  This alone was the difference between 12/13 and 19/19.
- **A test that only asserts on the DOM passes while the console fills with
  errors.** Use the `quiet()` helper — it collects `console.error`, `error` and
  `unhandledrejection` — and assert on it.
- **`Report server timed out` with no test output means the component did not
  compile.** Ask Vite:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/src/lib/<X>.test.svelte`.
- **Do not filter your type gate by directory** — the monorepo's did, and a file
  that would not parse reported as clean.
- **The sample serves a tutor that says it is not wired to a model when there is
  no key**, which is what keeps the browser suite runnable without one. Keep
  that behaviour: it is the difference between a suite anyone can run and a
  suite that needs a secret.
