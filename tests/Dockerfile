FROM python:3.12-slim

ENV \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# The project sits one level below the import root, so each package resolves
# its sibling dependencies the way a consumer that installed it would: by
# relative import out of the project package. Renaming this folder breaks
# those imports.
WORKDIR /app/wsfs_mono

# fast_diff_match_patch ships no aarch64 wheel, so it is compiled here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first: editing source then leaves these layers cached.
COPY requirements.txt ./requirements.txt
COPY requirements-tutor.txt ./requirements-tutor.txt
COPY tests/requirements.txt ./tests/requirements.txt
RUN pip install -r requirements.txt -r requirements-tutor.txt -r tests/requirements.txt

# compose bind-mounts the source over the top for the dev loop; copying it in
# keeps the image runnable on its own (CI, or a bare `docker run`).
COPY pytest.ini ./pytest.ini
COPY wsfs_core_suede/ ./wsfs_core_suede/
COPY wsfs_assistant_suede/ ./wsfs_assistant_suede/
COPY wsfs_pytutor_suede/ ./wsfs_pytutor_suede/
COPY sqlmodel_utils_suede/ ./sqlmodel_utils_suede/
COPY pytutor_llms_suede/ ./pytutor_llms_suede/
COPY samples/ ./samples/
COPY tests/ ./tests/

CMD ["pytest"]
