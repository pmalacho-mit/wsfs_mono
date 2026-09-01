"""The embedded tutor for Python development: stuck detection, the offer, the
judgement on a timer, and the study instrument that measures whether any of it
helps.

NOT `pytutor_llms`. That is a generic model-provider wrapper with nothing to do
with tutoring, and this package does not import it -- every model call here
goes through the `ITutor` seam `wsfs_assistant_suede` exports. The two names
will be confused; see the README.
"""

from .main import Pytutor, create_pytutor_router
from .models import StudyModels, build_study_models

__all__ = [
    "Pytutor",
    "StudyModels",
    "build_study_models",
    "create_pytutor_router",
]
