"""The tutor that actually talks to a model.

The one file here that imports `wsfs_suede__pytutor_llms_suede`, and the only
one that knows a model exists. A host builds one of these and hands it to
`Backend.over`, exactly as it hands over a collaboration server; everything
else in this package takes `ITutor` and never learns which of them it has.

WHY A MODEL IN THIS TIER. Tutoring is a conversation, and a conversation that
pauses for a minute is not one. So the choice is the fastest model that can
still read code and be right about it, and NO EXTENDED THINKING -- which is
what this provider does by default, since it never sends a thinking budget.
The reply is bounded too: a tutor that answers a two-line question with two
pages has misjudged the room, and a cap is the bluntest way to say so.
"""

from __future__ import annotations

from typing import AsyncIterator, Sequence, cast

from ...wsfs_suede__pytutor_llms_suede import Msg, Provider
from ...wsfs_suede__pytutor_llms_suede.providers.anthropic import AnthropicProvider

from .tutor import ITutor, Said

MODEL = "claude-sonnet-5"
"""Fast enough to hold a conversation, and able to read code.

Haiku answers sooner and is worse at the part that matters here -- saying WHY
something is wrong rather than that it is. Opus is better at that and slow
enough to change what the panel is for. This is the middle, and the fallback
below is what answers when it cannot.
"""

FALLBACK = "claude-haiku-4-5-20251001"
"""Better than an apology. A tutor that is briefly less insightful is still a
tutor; one that is unavailable is a blank panel."""

MOST_TOKENS = 1_500
"""About two screens. Long enough to explain a function and walk through a
traceback; short enough that nobody waits on prose they will not read."""


class Tutor(ITutor):
    """`ITutor`, over whichever provider recognises the model."""

    def __init__(
        self,
        *,
        model: str = MODEL,
        fallback: str | None = FALLBACK,
        providers: Sequence[Provider] | None = None,
        most_tokens: int = MOST_TOKENS,
    ) -> None:
        self._model = model
        self._fallback = fallback
        self._providers = tuple(providers) if providers else (AnthropicProvider(),)
        self._most_tokens = most_tokens

    @property
    def model(self) -> str:
        return self._model

    async def answer(self, said: Sequence[Said]) -> AsyncIterator[str]:
        stream = await Provider.TextStream.Select(
            Provider.TextStream.Request(
                messages=_messages(said),
                model=self._model,
                fallback_model=self._fallback,
                model_metadata=[
                    AnthropicProvider.ModelMetadata(max_tokens=self._most_tokens)
                ],
            ),
            *self._providers,
        )
        async for event in stream:
            if event.type == "error":
                raise event.payload
            yield event.payload.delta


def _messages(said: Sequence[Said]) -> list[Msg]:
    """Ours, in the shape the library takes.

    The library's `Msg` is OpenAI's message param whichever provider ends up
    serving it -- the Anthropic one lifts the system message out itself -- so
    a system line goes in as a message rather than as a separate argument.
    """
    return [cast(Msg, {"role": one.role, "content": one.text}) for one in said]
