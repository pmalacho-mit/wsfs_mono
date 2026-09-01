> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

# wsfs-pytutor-suede

**The embedded AI tutor for Python development.** Noticing that a student is
stuck, deciding whether to say anything, judging whether their program is
getting anywhere, and recording the experiment that measures whether any of it
helps. Backend and frontend.

This is the live research surface, and the reason the rest of the codebase
exists.

## The two pytutor names

`pytutor_llms_suede` is a generic model-provider wrapper with **nothing to do
with tutoring**. `wsfs_assistant_suede` imports it; this package does not, and
must not. Every model call here goes through `ITutor`, which the host
constructs once and hands to both routers.

The two names will be confused. This is the answer.

## Why it sits at the bottom of the graph

It is the only package that needs two siblings at once:

| Needs | From | Why nowhere else |
|---|---|---|
| edits attributed to *this* person | `wsfs_python_suede` | Monaco's `detailedReasons` is the only signal that names the gesture |
| a model, for `/progress` | `wsfs_assistant_suede` | `ITutor` — one provider, one key, one place that knows a model exists |
| opening the panel when an offer is taken | `wsfs_assistant_suede` | the nudge's whole purpose |
| runs and their outcomes | core, via python | `outputs`, `ok` |

That is not a design smell. A tutor for Python development is *supposed* to know
about Python and about the assistant it hands students to; the dependency graph
matching the domain is the sign the split is right.

## Three properties to preserve exactly

**Nothing here reads a clock or tosses a coin for itself.** Both are handed in,
so a twenty-minute cooldown is tested in twenty milliseconds and the coin lands
where the test says. A rule about time that can only be tested by waiting is a
rule nobody tests.

**Every detection is recorded, including the ones that never reach a screen.**
`Became` has four values: the two randomized arms an analysis compares, and the
two that were never eligible. Recording those is what makes "this student was
stuck four times and heard about it once" different from "this student was stuck
once".

**This is the only thing in the system allowed to lose data.** Study rows have
no outbox and must not get one. Everything else wsfs stores is somebody's work;
these are a study's observations of a term, and paying for their certainty with
a slower editor is a bad trade made on a student's time.

## The application shell

`frontend/Workspace.svelte` is the composition root — the tree and the dock from
`wsfs_svelte_suede`, Monaco and the kernel from `wsfs_python_suede`, the chat
panel from `wsfs_assistant_suede`, the filesystem from core, and the nudge
protocol, which is the only part it declares itself.

It lives here because this is the only package that may depend on all four. The
intended end state is a generic pane in `wsfs_svelte_suede` with those arriving
through extension points, and this shell becoming the thing that fills them.
`FileView` has already been taken apart that way and is the shape to copy.

## Reading it

[GUIDE.md](./GUIDE.md) walks the files in the order they make sense in.

## Testing

See [TESTING.md](./TESTING.md), including §6 on the one failure in this system
that has no symptom.

**Setting the suite up in this repo's own `main` branch?**
[HANDOFF.md](./HANDOFF.md) is written for that: what to port, what needs a
consumer app, and the traps that cost time the first time round.
