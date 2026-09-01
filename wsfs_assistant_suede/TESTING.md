# Testing `wsfs_assistant_suede`

> [!NOTE]
> This file describes how to set the suite up on this repository's **`main`**
> branch. What you are reading now shipped inside `release/`, so the paths
> below are `main`'s: this package's source is at `release/`, and everything
> the suite adds lives beside it.

**Nothing in this suite talks to a model, and that is the point of the seam.**
`ITutor` is one method — given what has been said, produce more text — so every
test hands over a tutor that says what the test told it to. If a test ever needs
an API key, the seam has stopped being a seam.

---

## 1. What `main` looks like

```
wsfs_assistant_suede/
  release/                     <- this package (backend/ + frontend/)
  wsfs_core_suede/             <- root-owned, like every dependency here
  wsfs_svelte_suede/
  pytutor_llms_suede/
  sqlmodel_utils_suede/
  samples/backend/app.py       <- a host app mounting core AND this package
  samples/frontend/            <- a SvelteKit app that mounts the panel
  tests/                       <- pytest
  tests/frontend/              <- vitest
  pytest.ini
```

Install every dependency with `--root-owned`. The default names one after
whoever asked for it, which gives one folder two paths — Python then builds two
module objects, and `Models` from one is not the `Models` the other declares.

**The host app is the shape to copy**, because mounting is what this package
mostly is:

```python
backend = Backend.over(models, database, blobs, ..., collaboration=...)
chat = build_chat_models(core=models, user_table=Account, workspace_table=Project)

app.include_router(create_router(backend=backend, authorize=authorize).router)
app.include_router(
    create_assistant_router(
        backend=backend, models=chat, authorize=authorize, tutor=tutor
    ).router
)
```

Both routers on one prefix, and nothing collides: core's paths are core's and
`/chat` is this package's. It mounts **over** core and never consumes core's
`Mounted` — that object is for an application calling the work behind a route
without HTTP'ing itself, which is a different job from adding routes.

## 2. Running it

```bash
./tests/run.sh                       # against a throwaway postgres
./tests/run.sh -k transcript -x
npx vitest run
cd samples/frontend && npm run check
```

`pytest.ini` puts the import root **above** this repository, so `release/`'s
`from ...wsfs_core_suede` resolves the way it will in a consumer:

```ini
pythonpath = .. tests samples/backend
```

## 3. The scripted tutor

`tests/tutors.py` holds it, shared rather than copied because
`wsfs_pytutor_suede`'s suite asks the same thing of it:

```python
async with tutored(processes, Scripted("NO\n", "Nothing has changed.")) as api:
    ...
```

It records every `Said` it was handed, which is what lets a test assert on the
PROMPT rather than only on the answer — and the prompt is where most of the
behaviour worth protecting lives.

## 4. Four behaviours to keep a test on

Each is non-obvious, load-bearing, and easy to lose in a refactor.

1. **Two calls, not one.** Asking records the question and *starts* the work;
   the stream attaches to work already under way. A client that never attaches
   changes nothing — the answer is written down when it finishes, because a
   person who asks and closes the tab has still asked.
2. **Asking twice is answered once.** The message id is the client's, so a
   retried request finds its own question already recorded. It still gets a
   token, because the reason to retry is usually that the first answer never
   arrived.
3. **The token is not spent by being read.** It names a generation running in
   this process, not a durable fact, so a page that reloaded mid-answer picks
   the same one up. What retires it is age, not somebody having heard it.
4. **A transcript is one person's.** A workspace can have more than one person
   in it, and what somebody asked a tutor is theirs. Test it with two users in
   one workspace, not with one.

## 5. What this package reads of core, and what it must never do

It reads snapshots, runs and reconstructed text through core's public seam —
`reconstruct.reconstructed`, `records`, `text`, `minted_at` — and appends only
to its own three tables.

**It never writes a workspace.** No test should be able to make it. If the
assistant ever needs to, it does so through `Mounted.place` as an ordinary
application consumer, never by reaching into `service` — a second write path is
the one thing the design refuses.

## 6. `progress` is NOT here

`/progress`, `Judging` and `Judged` belong to `wsfs_pytutor_suede`. What this
package owes that one is the **seam**, exported as API rather than as a
convenience:

```python
from wsfs_assistant_suede.backend import ITutor, Said
from wsfs_assistant_suede.backend.llm import Tutor
```

The host builds ONE `Tutor` and hands it to both routers. So the thing to
protect in review is that `ITutor` stays narrow enough for a caller wanting a
one-shot judgement: one method, no transcript handling, no message ids, no
attachment assembly. The day any of those leak in, pytutor has to fake a
conversation to ask a yes/no question.

`tutor.fenced` is exported for the same reason — pytutor formats a judgement's
prompt the same way, and two spellings of one rule drift.

## 7. The panel

`svelte/Assistant.svelte` and `Conversation` are tested in the browser suite,
against a scripted assistant rather than the real routes
(`samples/frontend/src/lib/harness/tutor.ts`). The wire is tested where it can
be tested honestly — in `tests/tutor.py`, over real HTTP.

`Conversation.attach` takes an **`Assistant`**, not a `Workspace`. That is the
composition the split is built on: core gives you a filesystem, this gives you
a conversation about one, and core exposing an extension slot on `Workspace`
would be core knowing that satellites exist.

## 8. The boundary

```bash
python3 tools/audit-imports.py
```

`backend/llm.py` is the only file that may import a model library, and the
audit names it. Nothing here may import pyodide, monaco, `wsfs_python_suede` or
`wsfs_pytutor_suede`.
