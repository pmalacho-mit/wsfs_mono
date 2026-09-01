> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# wsfs-assistant-suede

**Getting a language model involved with a wsfs workspace.** Asking it a
question with files and runs attached, streaming the answer, keeping the
transcript, and rendering all of it. Backend and frontend.

## `ITutor` is this package's public API

One method — *given what has been said, produce more text* — supplied by the
host, exactly as a collaboration server is. `backend/llm.py` is the only file
here that knows a model exists.

That is not ceremony. It is what lets the whole feature be driven in a test, on
a machine with no API key, against a tutor that says what the test told it to.

It is also a **commitment**: `wsfs_pytutor_suede` mounts its own `/progress`
route over the same seam rather than wiring a second provider. So the host
builds ONE tutor and hands it to both routers — one key, one model choice, one
fallback:

```python
tutor = Tutor(model=..., fallback=...)
app.include_router(create_assistant_router(..., tutor=tutor).router)
app.include_router(create_pytutor_router(..., tutor=tutor).router)
```

Which means `ITutor` has to stay narrow enough for a caller wanting a one-shot
judgement. If transcript handling, message ids or attachment assembly ever leak
into it, pytutor ends up faking a conversation to ask a yes/no question.

## Mounts over core; does not consume `Mounted`

It takes core's `Backend` and the host's `Authorize` — the same two things
core's own router takes — builds its own tables and routes, and hands back its
own mounted-alike. `Mounted` is for an application calling the work behind a
route without HTTP'ing itself, which is a different job from adding routes.

**It reads core and never writes it.** Snapshots, runs and reconstructed text
in; three tables of its own out; nothing reaches `service`. An assistant that
ever needs to write a workspace does it through `Mounted.place` as an ordinary
application consumer.

## Two objects on the client, not one

```ts
const workspace = connect({ workspace: id, transport });
const chat = assistant(workspace, { base, authorize });
```

Core exposing an extension slot on `Workspace` would be core knowing that
satellites exist, which is the boundary the whole split is about. `assistant()`
builds its own requests against the same base URL and authorisation, and takes
`workspace` for the two things it needs: its id, and `snapshot()` to record what
the user was looking at when they asked.

`snapshot` stays core's. It is a transaction, it travels through the outbox, and
"what was on screen when X happened" is not a model's idea.

## The two pytutor names

`pytutor_llms_suede` is a generic model-provider wrapper with nothing to do with
tutoring — **this** package imports it, to talk to a model.
`wsfs_pytutor_suede` is the research feature, and it does not. The two will be
confused; this paragraph is the answer.

## Reading it

[GUIDE.md](./GUIDE.md) walks the files in the order they make sense in.

## Testing

See [TESTING.md](./TESTING.md). Nothing in the suite talks to a model.

**Setting the suite up in this repo's own `main` branch?**
[HANDOFF.md](./HANDOFF.md) is written for that: what to port, what needs a
consumer app, and the traps that cost time the first time round.
