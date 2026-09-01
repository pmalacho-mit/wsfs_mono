"""Whether a student has got anywhere since a few minutes ago.

ONE MEASUREMENT, NOT A QUESTION. No transcript goes in and no turn comes out:
this is asked on a timer by the client that is watching somebody work, which is
why it does not stream, does not take a message id, and is not recorded. What
is recorded is the episode, and only if the answer is no.

NOTHING HERE IMPORTS A MODEL LIBRARY, and this package imports one nowhere
else either. What it takes is `ITutor` -- the assistant's seam, one method --
so the host builds one provider, with one key and one fallback, and hands the
same object to both routers.
"""

from __future__ import annotations

from ...wsfs_assistant_suede.backend.tutor import (
    ITutor,
    Said,
    fenced,
)

__all__ = ["ITutor", "Said", "judged"]


JUDGING = """\
You are grading progress, not code. You will be shown what a student is trying \
to do, their program a few minutes ago, and their program now.

Answer with one word on the first line -- YES if they have made meaningful \
progress toward the goal since the earlier version, NO if they have not -- and \
then one short sentence saying why.

Meaningful progress is work toward the goal: new or changed code that moves \
them along, or a fix to something that was wrong. It is NOT whitespace, \
renaming, comments, deleting and retyping the same thing, or edits that leave \
them where they were. If the two versions are the same, the answer is NO.\
"""


def _asking(goal: str, before: str, after: str) -> list[Said]:
    return [
        Said(role="system", text=JUDGING),
        Said(
            role="user",
            text=(
                f"The goal:\n{goal}\n\n"
                f"{fenced('A few minutes ago:', before)}\n\n"
                f"{fenced('Now:', after)}"
            ),
        ),
    ]


async def judged(tutor: ITutor, goal: str, before: str, after: str) -> tuple[bool, str]:
    """Whether the student got anywhere, and why somebody thinks so.

    NO HISTORY, and that is the whole difference between this and a question.
    A conversation is about what has been said; this is one measurement of two
    snapshots, and carrying a transcript into it would let something said an
    hour ago decide what this minute looks like.

    Collected rather than streamed: nobody is reading it, and the answer is a
    yes or a no.
    """
    said = "".join([delta async for delta in tutor.answer(_asking(goal, before, after))])
    first, _, rest = said.strip().partition("\n")
    """The first word rather than a search for "yes" anywhere: a sentence
    explaining why there is NO progress contains the word "no", and half the
    ways of saying it contain the word "yes" as well."""
    progressing = first.strip().upper().startswith("YES")
    why = (rest.strip() or first.strip())[:400]
    return progressing, why
