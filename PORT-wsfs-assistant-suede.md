# wsfs-assistant-suede

**Role:** getting a language model involved with a wsfs workspace — asking it a
question with files and runs attached, streaming the answer, keeping the
transcript, and rendering all of it. Backend and frontend.

**Baseline:** `wsfs_suede` @ `576b33e`. Read `PORTING.md` §0 before acting on any
inventory here.

---

## 1. Boundaries

**BOUNDARY — depends on:** `wsfs-core-suede`, `wsfs-svelte-suede`,
`wsfs_suede__pytutor_llms_suede`.

**BOUNDARY — must not depend on:** pyodide, monaco, `wsfs-python-suede`,
`wsfs-pytutor-suede`.

**BOUNDARY — `ITutor` is this repo's public API.** `wsfs-pytutor-suede` mounts
its own `/progress` route over the same seam rather than wiring a second
provider. Exporting `ITutor`, `Said`, and the shipped `Tutor` implementation is
therefore a commitment, not a convenience — see §4.

**BOUNDARY — mounts over core; does not consume `Mounted`.** It takes
`Backend` + `Authorize`, builds its own tables and its own router, and returns
its own mounted-alike. See `PORTING.md` §3.3.

**BOUNDARY — no model library outside one adapter module.** `tutor.py`'s
docstring already states this: *"Nothing here imports a model library."* The
seam is `ITutor`, one method, host-supplied. `llm.py` is the only file that knows
a model exists. Preserve this exactly — it is what lets the whole feature be
driven in a test on a machine with no API key.

**BOUNDARY — reads core, never writes it.** As of `576b33e` this is true and it
is worth keeping true: the assistant's backend imports `reconstruct` and reads
snapshot rows, and appends nothing to any log. If the assistant ever needs to
*write* a workspace, it does so through `Mounted.place` as an ordinary
application consumer — never by reaching into `service`.

---

## 2. Why this is the easiest satellite to extract

It has the cleanest seam in the codebase. As of `576b33e`, `tutor.py` imports
five things from core (`reconstruct`, `contract`, `minted`, `models`, `text`),
and nothing in core imports it except `main.py` and `Backend`. There is no
circularity to unpick and no shared mutable state.

Extract this **first** among the satellites (`PORTING.md` §6, step 7).

---

## 3. Inventory as of `576b33e`

### Backend

| Role | File | Anchor phrase |
|---|---|---|
| Ask, hear, transcript, prompt assembly | `backend/tutor.py` (~700) | `what it is asked, what it is shown, and what it says back` |
| The one file that talks to a model | `backend/llm.py` (~88) | `The tutor that actually talks to a model` |
| Wire shapes | `backend/contract.py`, `# -- the tutor` section (~99 lines) | `# -- the tutor` |
| Tables | `backend/models.py`, `# -- the tutor` section (~90 lines) | `# -- the tutor` |
| Routes | `backend/main.py`: `/chat`, `/chat/stream`, `/chat` (GET) | `Put a question to the tutor` |

Tables to take: `ChatAskedRow`, `ChatAttachmentRow`, `ChatAnsweredRow`
(`Models.asked`, `.attachment`, `.answered`).

Contract shapes to take: `Attaching`, `Asking`, `Asked`, `Attached`, `Turn`,
`Transcript`, `Answering`. **Not** `Judging` / `Judged` — those go to pytutor.

### Frontend

| Role | File | Notes |
|---|---|---|
| Panel | `frontend/svelte/assistant/` (~1,183) | `Assistant.svelte`, `AttachedFiles.svelte`, `conversation.svelte.ts`, `activity.ts`, `goals.ts`, `stuck.ts`, `nudge.ts` |
| Chat UI kit | `frontend/svelte/shadcn/ai-elements/` | Only consumer is this panel — see svelte guide §5 |
| Transport methods | `frontend/transport.ts`: `ask`, `hear`, `conversation` | Split out of core's transport; `progress` goes to pytutor |
| Workspace surface | `frontend/workspace.ts`: the `tutor: {...}` group, minus `progressing` | Split out |

**INVENTORY caveat — the assistant folder is mixed.** As of `576b33e`,
`svelte/assistant/` contains `stuck.ts` (~395) and `nudge.ts`, which are the
**tutor's** detection and offer logic, not the assistant's chat. See §6.

---

## 4. `progress` goes to pytutor — and the seam that makes that free

`Judging` / `Judged` and the `/progress` route are **not** this repo's. They are
a non-standard tutoring behaviour: asked on a timer by something watching a
student work, to decide whether to intervene. That is `wsfs-pytutor-suede`'s
feature, and the route belongs with the feature.

The only reason to hesitate was cost: `/progress` is an LLM call, and giving
pytutor its own provider wiring would mean a second copy of the model choice,
the fallback, the token cap and the key handling. That cost disappears if the
seam is exported properly, which is the work item here.

**Export the seam, not just the implementation:**

```python
from wsfs_assistant import ITutor, Said     # the seam — one method
from wsfs_assistant.llm import Tutor        # the shipped implementation
```

The host constructs **one** `Tutor` and hands it to both routers:

```python
tutor = Tutor(model=..., fallback=...)

app.include_router(create_assistant_router(
    backend=backend, models=chat_models, authorize=authorize, tutor=tutor).router)

app.include_router(create_pytutor_router(
    backend=backend, models=study_models, authorize=authorize, tutor=tutor).router)
```

So pytutor depends on this repo for the **seam**, never on `pytutor_llms`
directly. One provider, one key, one place that knows a model exists — and
`/progress` lives with the feature it serves.

**What this repo must therefore preserve:** `ITutor` has to stay narrow enough
that a caller wanting a one-shot judgement is not forced through conversation
machinery. As of `576b33e` it is one method — *given what has been said, produce
more text* — which is already right. Do not let transcript handling, message ids
or attachment assembly leak into it while extracting; if they do, pytutor ends up
faking a conversation to ask a yes/no question.

**Also moving with `progress`:** the `Judging` and `Judged` shapes leave
`contract.py` with it, and pytutor generates them into its own schema. The
`MOST_TOKENS` / model-choice constants stay here, in `llm.py`, since they are
properties of the provider rather than of either caller.

## 5. Splitting the client surface cleanly

Core's `Workspace` object currently carries a `tutor: {ask, hear, said,
progressing}` group. That has to leave core (`PORTING.md` §3.3), and the
question is what replaces it.

**Do not** have core expose an extension slot on `Workspace`. That is core
knowing satellites exist, and it is the boundary this whole port is about.

**Do** compose beside it:

```ts
import { connect } from "wsfs-core-suede";
import { assistant } from "wsfs-assistant-suede";

const workspace = connect({ workspace: id, transport });
const chat = assistant(workspace, { base, authorize });
```

`assistant(workspace, ...)` builds its own transport methods against the same
base URL and authorisation, and takes `workspace` for the two things it needs
from it: `workspace.id`, and `workspace.snapshot(entries)` to record what the
user was looking at when they asked.

**BOUNDARY:** `snapshot()` stays in core. It is a member of the `Submitted`
union, travels through the outbox, and is generically useful — "what was on
screen when X happened" is not an LLM concept. The assistant *consumes*
snapshots; it does not own them.

This composition shape also settles the schema-generation question
(`PORTING.md` §3.2): this repo generates its own `schema.generated.d.ts` from a
FastAPI app holding only `create_assistant_router`, and imports `Id`, `Version`,
`Occurrence`, `Executed`, `Versions` from core's `contract.ts`.

---

## 6. Untangling `svelte/assistant/`

The folder holds two features. As of `576b33e`:

| File | Feature | Goes to |
|---|---|---|
| `Assistant.svelte` (~189) | chat panel | here |
| `AttachedFiles.svelte` | attaching files to a question | here |
| `conversation.svelte.ts` (~247) | transcript state | here |
| `stuck.ts` (~395) | **detection rules + study protocol** | `wsfs-pytutor-suede` |
| `nudge.ts` | **the offer toast** | `wsfs-pytutor-suede` |
| `activity.ts` (~191) | recording activity in a window | `wsfs-pytutor-suede` |
| `goals.ts` | *check its docstring* — likely pytutor | probably `wsfs-pytutor-suede` |

The dependency runs pytutor → assistant, for two separate reasons that both
point the same way: the nudge, when accepted, opens the assistant panel, and
`/progress` needs the `ITutor` seam. That is the right direction and it is why
pytutor depends on this repo rather than the reverse.

**Work item:** find where the offer's acceptance opens the panel and make it an
explicit callback pytutor is handed, rather than a direct import. As of
`576b33e` `Workspace.svelte` wires both, so the seam may not exist yet.

---

## 7. Preserve these behaviours through the move

Four things in `tutor.py` are non-obvious, load-bearing, and easy to lose in a
port. Each has a test worth writing before you move the file.

1. **Two calls, not one.** Asking records the question and *starts the work*;
   the stream attaches to work already under way. *"A person who asks and closes
   the tab has still asked, and the answer is written down whether or not anyone
   was listening."* A port that makes `/chat` return the answer breaks this.
2. **Asking twice is answered once.** The message id is client-minted, so a
   retried request finds its own question already recorded — and still gets a
   token, because the reason to retry is usually that the first answer never
   arrived.
3. **The answer is written in its own session.** The request's session is long
   closed by the time a generation finishes. This is not a style choice; it is
   the shape of the feature.
4. **`Asking.snapshot` is nullable.** A snapshot is a transaction like any
   other: it can be refused for naming a version the server never issued, or
   never sent at all. A tutor that answers from the question alone is worse than
   one that answers with context, and better than one that refuses.

Also carry across the two TTLs and the reasoning attached to them (token-to-listen
~10 min, finished-generation-kept ~5 min as of `576b33e`) — they encode
"a slow page load should not cost somebody the answer they are already paying
for."

---

## 8. How to know it worked

1. **Import audit clean** (`PORTING.md` §5).
2. **`grep -rn "pytutor_llms" backend/`** returns exactly one file.
3. **The full feature runs against a fake `ITutor` with no API key** — ask,
   stream, transcript, attachments. This is the check that proves the seam
   survived.
4. **`ITutor` is importable and usable without touching anything else in this
   repo** — no chat tables, no message id, no transcript. That is what pytutor
   needs, and the check that `/progress` did not have to move back here.
5. **Core's test suite has no chat tests in it.** Absent, not skipped.
6. **Ask → close the tab → reopen → the transcript has the answer.** Behaviour
   §7.1, and the one most likely to be quietly broken.
7. **Ask twice with the same message id → one question, one answer, two tokens.**
   Behaviour §7.2.
8. **Core mounts and serves with this repo not installed.**
