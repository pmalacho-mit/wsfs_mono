"""Bringing a database that already exists up to the schema the code expects.

`create_all` creates missing TABLES and does nothing about missing COLUMNS. On
a database that has been running, a schema change is therefore silent until
the first write, which fails with `column ... does not exist` -- at which point
the failure is a 500 in the middle of somebody's work rather than a refusal to
start.

THIS DOES THE SAFE HALF AND REFUSES THE REST. Adding a column the code
declares and the database lacks is mechanical: the default fills the rows that
were already there. Everything else -- a column the code no longer declares, a
type that changed, a constraint that moved -- is a data decision, and guessing
at one to make a schema match is how a migration destroys something. Those are
reported and left alone.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Column, Connection, MetaData, Table, inspect, text


@dataclass(frozen=True)
class Missing:
    """A column the code declares and the database does not have."""

    table: str
    column: str


def _present(connection: Connection, table: str) -> set[str]:
    return {held["name"] for held in inspect(connection).get_columns(table)}


def _existing(connection: Connection, metadata: MetaData) -> list[Table]:
    """Only tables that are already there.

    A table the database has never seen is `create_all`'s business, and it
    makes the whole table at once -- so it is never missing columns.
    """
    there = set(inspect(connection).get_table_names())
    return [table for table in metadata.sorted_tables if table.name in there]


def missing(connection: Connection, metadata: MetaData) -> list[Missing]:
    """Every column the code expects that the database has not got."""
    return [
        Missing(table=table.name, column=column.name)
        for table in _existing(connection, metadata)
        for column in table.columns
        if column.name not in _present(connection, table.name)
    ]


def widen(connection: Connection, metadata: MetaData) -> list[Missing]:
    """Add the columns the code declares and the database lacks.

    Returns what it added, so a caller can say so rather than doing it
    silently. Idempotent: a second run finds nothing to do.

    Raises rather than guessing when a column is NOT NULL, the table already
    has rows, and nothing says what those rows should hold. Filling them with
    a value nobody chose is how a migration quietly invents data.
    """
    added = missing(connection, metadata)
    wanted = set(added)
    for table in _existing(connection, metadata):
        for column in table.columns:
            if Missing(table=table.name, column=column.name) in wanted:
                _add(connection, table, column)
    return added


def _add(connection: Connection, table: Table, column: Column) -> None:
    """Nullable first, filled, then constrained.

    Adding a NOT NULL column to a table that already has rows fails outright,
    and adding one with a DEFAULT quietly rewrites every existing row. Doing
    it in three steps makes the filling explicit and keeps it in one
    transaction with the constraint that depends on it.
    """
    kind = column.type.compile(dialect=_dialect())
    connection.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {kind}'))
    if column.nullable:
        return
    _fill(connection, table, column)
    connection.execute(
        text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{column.name}" SET NOT NULL')
    )


def _fill(connection: Connection, table: Table, column: Column) -> None:
    filling = _declared_default(column)
    if filling is None:
        raise Unfillable(table=table.name, column=column.name)
    connection.execute(
        text(f'UPDATE "{table.name}" SET "{column.name}" = :filling').bindparams(
            filling=filling
        )
    )


def _declared_default(column: Column) -> object | None:
    """What the code says a row without this column should hold.

    Only a plain value counts. A default that is a function or a SQL
    expression is one the code means to evaluate per row, and using it to
    backfill history would stamp every old row with the moment of the
    migration.
    """
    if column.default is not None and not callable(getattr(column.default, "arg", None)):
        return getattr(column.default, "arg", None)
    return None


@dataclass(frozen=True)
class Unfillable(Exception):
    """A column that cannot be added without inventing what the old rows held."""

    table: str
    column: str

    def __str__(self) -> str:
        return (
            f'"{self.column}" on "{self.table}" is NOT NULL and declares no plain '
            "default, so the rows already there have nothing to be given. Give it a "
            "default, make it nullable, or migrate it by hand."
        )


def _dialect():
    from sqlalchemy.dialects import postgresql

    return postgresql.dialect()
