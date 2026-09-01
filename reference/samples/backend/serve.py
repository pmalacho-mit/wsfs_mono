"""Serve the sample host, for a browser or a benchmark to talk to.

The test suite builds this app in-process; this is the same app with a port
and a schema, so a frontend has something to point at. ONE WORKER, because
one process per workspace is the invariant the controller rests on.

    python -m samples.backend.serve            # http://0.0.0.0:8099
"""

from __future__ import annotations

import os

import uvicorn
from sqlmodel import SQLModel, create_engine

from .app import create_sample_app
from ...release.backend import migrate
from ...wsfs_suede__sqlmodel_utils_suede.postgres.config import (
    ConfigFromEnvironment,
    config_to_url,
)


def create_tables() -> None:
    """Make the schema match the code before anything is served.

    `create_all` makes tables that are missing and does nothing about columns
    that are, so a database that has been running quietly disagrees with the
    code until the first write fails. `widen` closes that half; anything it
    will not do by itself, it raises about here rather than at the moment
    somebody is typing.
    """
    engine = create_engine(config_to_url(ConfigFromEnvironment(), addon="psycopg"))
    SQLModel.metadata.create_all(engine)
    with engine.begin() as connection:
        for added in migrate.widen(connection, SQLModel.metadata):
            print(f"schema: added {added.table}.{added.column}")
    engine.dispose()


def main() -> None:
    create_tables()
    uvicorn.run(
        create_sample_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8099")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
