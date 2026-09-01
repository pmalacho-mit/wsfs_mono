"""Bringing a database that already exists up to the schema the code expects.

`create_all` creates missing TABLES and does nothing about missing COLUMNS, so
a schema change against a database that has been running is silent until the
first write, which then fails with `column ... does not exist`. That has
happened twice.

What this does is the safe half -- adding columns -- and what it refuses to do
is the rest. A column the code no longer declares might be holding the only
copy of something, and dropping it to make the schema match is a data decision
nobody asked for.
"""

import pytest
from sqlalchemy import text
from sqlmodel import Session, SQLModel

from conftest import Api, acknowledged, new_id
from wsfs_suede.release.backend.migrate import Missing, missing, widen
from wsfs_suede.samples.backend.app import MODELS

A_TABLE = MODELS.refused_text.__tablename__


def columns(session: Session, table: str) -> set[str]:
    rows = session.exec(
        text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ).bindparams(t=table)
    ).all()
    return {row[0] for row in rows}


@pytest.fixture
def without_cleared(session: Session):
    """A database from before `cleared` was declared.

    Put back afterwards, because the schema is made once for the whole run and
    a column dropped here would be missing for every test after it -- which is
    the same failure this module is about, arriving sideways.
    """
    session.exec(text(f'ALTER TABLE "{A_TABLE}" DROP COLUMN "cleared"'))
    session.commit()
    yield
    widen(session.connection(), SQLModel.metadata)
    session.commit()


def test_a_database_that_matches_needs_nothing(session: Session):
    assert missing(session.connection(), SQLModel.metadata) == []


def test_a_column_the_code_added_is_noticed(session: Session, without_cleared: None):
    assert Missing(table=A_TABLE, column="cleared") in missing(
        session.connection(), SQLModel.metadata
    )


def test_a_column_the_code_added_is_put_back(session: Session, without_cleared: None):
    widen(session.connection(), SQLModel.metadata)
    session.commit()

    assert "cleared" in columns(session, A_TABLE)
    assert missing(session.connection(), SQLModel.metadata) == []


def test_widening_twice_is_the_same_as_widening_once(
    session: Session, without_cleared: None
):
    widen(session.connection(), SQLModel.metadata)
    widen(session.connection(), SQLModel.metadata)
    session.commit()

    assert missing(session.connection(), SQLModel.metadata) == []


async def test_rows_that_were_already_there_get_the_default(
    api: Api, session: Session
):
    """The case that makes this worth doing rather than dropping the table:
    a column added to a database that already has work in it.

    The row is made the way one really is, so it carries the references a
    hand-written INSERT would have to invent.
    """
    entry, born = new_id(), api.transaction()
    acknowledged(
        await api.create(
            entry, name=f"{entry}.py", transaction=born,
            content={"type": "text", "content": "before\n"},
        )
    )
    acknowledged(await api.write(entry, born, "before\nkept\n", draft=True))

    session.exec(text(f'ALTER TABLE "{A_TABLE}" DROP COLUMN "cleared"'))
    session.commit()

    widen(session.connection(), SQLModel.metadata)
    session.commit()

    held = session.exec(text(f'SELECT cleared FROM "{A_TABLE}"')).all()
    assert [row[0] for row in held] == [False]


def test_a_column_the_code_no_longer_declares_is_left_alone(session: Session):
    """Refused, not guessed at. It may hold the only copy of something, and
    making the schema match by dropping it is a data decision nobody asked
    for."""
    session.exec(text(f'ALTER TABLE "{A_TABLE}" ADD COLUMN "an_old_idea" INTEGER'))
    session.commit()
    try:
        widen(session.connection(), SQLModel.metadata)
        session.commit()
        assert "an_old_idea" in columns(session, A_TABLE)
    finally:
        session.exec(text(f'ALTER TABLE "{A_TABLE}" DROP COLUMN "an_old_idea"'))
        session.commit()
