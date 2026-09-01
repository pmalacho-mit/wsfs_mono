"""Getting a language model involved with a wsfs workspace.

`ITutor` is this package's public API as much as the routes are: one method,
host-supplied, and the seam `wsfs_pytutor_suede` mounts its own `/progress`
route over rather than wiring a second provider. See `llm.Tutor` for the
shipped implementation.
"""

from .main import Assistant, create_assistant_router
from .models import ChatModels, build_chat_models
from .tutor import ITutor, Said

__all__ = [
    "Assistant",
    "ChatModels",
    "ITutor",
    "Said",
    "build_chat_models",
    "create_assistant_router",
]
