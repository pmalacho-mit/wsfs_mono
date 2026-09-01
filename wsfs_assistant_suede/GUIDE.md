# A tour of `wsfs_assistant_suede`

Getting a language model involved with a workspace: asking it a question with
files and runs attached, streaming the answer, keeping the transcript, and
drawing all of it.

Backend and frontend. It mounts **over** core rather than wrapping it.

---

## 1. `ITutor` is the point

```python
class ITutor(Protocol):
    @property
    def model(self) -> str: ...
    async def answer(self, said: Sequence[Said]) -> AsyncIterator[str]: ...
```

One method: *given what has been said, produce more text.* The host supplies
it, exactly as it supplies core a collaboration server, and **`backend/llm.py`
is the only file in this package that knows a model exists.**

That is not ceremony. It is what lets the whole feature be driven in a test, on
a machine with no API key, against a tutor that says what the test told it to —
which is how `tests/assistant/tutor.py` works.

It is also a **commitment**: `wsfs_pytutor_suede` mounts its own `/progress`
route over the same seam rather than wiring a second provider, so the host
builds ONE tutor and hands it to both routers. One key, one model choice, one
fallback.

Which means `ITutor` has to stay narrow enough for a caller wanting a one-shot
judgement. If transcript handling, message ids or attachment assembly leak into
it, pytutor ends up faking a conversation to ask a yes/no question.

## 2. The backend, in the order it runs

```
main.py       three routes: POST /chat, GET /chat/stream, GET /chat
     ↓
tutor.py      what a question is shown, what was asked before, and the answer
     ↓
llm.py        the only file that talks to a provider
```

**Start with `tutor.py`.** It is most of the package, and four things in it are
non-obvious and load-bearing:

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
   the same one up. What retires it is age.
4. **A transcript is one person's.** A workspace can have more than one person
   in it, and what somebody asked a tutor is theirs.

`prompt()` is where a question is assembled: the system prompt, then what has
been said before, then the files and runs the client attached. `_shown` is the
part worth reading — it reconstructs each attached file *at the version the
person was looking at*, which is what the snapshot is for.

## 3. `models.py` — mounting over core

```python
build_chat_models(core=models, user_table=Account, workspace_table=Project)
```

Three tables — `asked`, `attachment`, `answered` — and `ChatModels` carries
`core` because every query that reaches a core table (a snapshot's entries, a
run's output) reaches it through this object. Which tables the assistant reads
is therefore answerable by reading one dataclass.

**It never writes a workspace.** Snapshots, runs and reconstructed text in;
three tables of its own out; nothing reaches `service`. An assistant that ever
needs to write does it through `Mounted.place` as an ordinary application
consumer — a second write path is the one thing the design refuses.

## 4. The client is composed beside core, not hung off it

```ts
const workspace = connect({ workspace: id, transport });
const chat = assistant(workspace, { base, authorize });
```

Two objects because they are two packages. Core exposing an extension slot on
`Workspace` would be core knowing that satellites exist, which is the boundary
the whole split is about.

`assistant()` builds its own requests against the same base URL and
authorisation (via core's `requesting`), and takes `workspace` for the two
things it needs: its id, and `snapshot()` to record what the person was looking
at.

**Both arguments are load-bearing and neither should ever gain a default.**
The composition means these requests no longer ride core's transport, so an
`authorize` that sends nothing is a 4xx the type checker cannot see and the
person experiences as the tutor failing mid-answer. **`snapshot` stays core's** — it is a transaction, it travels through the
outbox, and "what was on screen when X happened" is not a model's idea.

## 5. The panel

```
svelte/Assistant.svelte       the panel
svelte/conversation.svelte.ts the transcript, as state
svelte/AttachedFiles.svelte   what is going with the next question
svelte/ai-elements/           the chat UI kit (vendored)
```

**`conversation.svelte.ts` is the one to read.** One list, two sources: what was
said before this page existed is read back a page at a time; what is being said
now arrives delta by delta. They meet in `turns`, so the panel draws one thing.

**Nothing there is the record.** The server writes the question down when it is
asked and the answer when it finishes, whether or not the panel is still open —
so losing the stream loses the live text and nothing else. That is why `reload`
exists and why failing to hear an answer is not an error worth showing.

`attach()` takes an **`Assistant`**, not a `Workspace`. That is the composition
above, showing through.

## 6. `progress` is NOT here

`/progress`, `Judging` and `Judged` belong to `wsfs_pytutor_suede`. What this
package owes that one is the *seam*, exported as API:

```python
from wsfs_assistant_suede.backend import ITutor, Said
from wsfs_assistant_suede.backend.llm import Tutor
```

`tutor.fenced` is exported for the same reason — pytutor formats a judgement's
prompt the same way, and two spellings of one rule drift.

## 7. The two pytutor names

`pytutor_llms_suede` is a generic model-provider wrapper with nothing to do
with tutoring. **This** package imports it, to talk to a model.
`wsfs_pytutor_suede` is the research feature, and it does not. They will be
confused; this section is the answer.

## 8. Running it

```bash
./tests/run.sh -k tutor          # the routes, against a scripted tutor
npx vitest run
cd samples/frontend && npm run test:browser -- --component Assistant --silence 300
```

`tests/tutors.py` holds the scripted tutor, shared with pytutor's suite because
both ask the same thing of it. It records every `Said` it was handed, which is
what lets a test assert on the **prompt** rather than only on the answer — and
the prompt is where most of the behaviour worth protecting lives.

## 9. Your first change

Add something to what a question carries. `Attaching` in `backend/contract.py`
is the shape; `_shown` in `tutor.py` is where it becomes prose;
`tests/assistant/tutor.py` asserts on the prompt, so you will see the effect
immediately.

Harder: `ITutor` currently streams text and nothing else. Tool use would need a
second method and a very careful look at §1 — the constraint that keeps pytutor
able to ask a yes/no question is the thing to protect.
