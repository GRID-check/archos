"""What a claim-queue table must be beyond its ``CREATE TABLE``: added columns, and the status guard.

THE DATABASE REFUSES AN ILLEGAL STATUS TRANSITION. ``claim_queue`` moves a row
through four statuses, and every statement that moves one says in its own
``WHERE`` which rows it may touch. Nothing held all of those statements to one
rule, so a new statement, a hand-written repair or a replica on older code could
bring a retired job back to life: a cancelled upload claimed again, a dead job's
blanked payload handed to a worker. The rule is a trigger on the table instead:

* a row is born ``queued`` (``enqueue``);
* every status is one of ``queued``, ``claimed``, ``dead``, ``cancelled``;
* a live row (queued or claimed) may move to any status: claimed by a worker,
  given back (``release_claims``, a lane over its cap), cancelled by a person,
  retired dead (``mark_dead``, ``reap_exhausted``);
* a retired row (dead or cancelled) keeps its status until ``purge_retired``
  deletes it. ``mark_done`` deletes a finished row rather than moving it.

A refused statement raises ``check_violation`` (SQLSTATE 23514) on Postgres and
aborts on SQLite. Ingest is a reconciliation loop, not a state machine people
drive, so the rule lives where every writer meets it, not in a Python module a
writer could skip. ``ingest_jobs`` has no such guard on purpose: there a live
owner's write wins over a row another replica settled (``ingest_status_store``).
"""

from __future__ import annotations

from sqlalchemy import text

from aiq_agent.common.db_utils import present_columns


def upgrade_columns(conn, table: str, wanted: dict[str, str], *, postgres: bool) -> None:
    """Add each of ``wanted`` (name to definition) that ``table`` lacks; no DDL when none is missing."""
    present = present_columns(conn, table)
    guard = "IF NOT EXISTS " if postgres else ""
    for column, definition in wanted.items():
        if column not in present:
            _execute_constant(conn, f"ALTER TABLE {table} ADD COLUMN {guard}{column} {definition}")


def ensure_status_guard(conn, table: str, *, born: str, live: tuple[str, ...], retired: tuple[str, ...]) -> None:
    """Install the trigger that refuses an illegal status transition on ``table`` (see the module docstring).

    On Postgres the function is replaced on every start, so a changed rule
    reaches a running database with the deploy; the trigger, whose creation
    locks the table, is created only when it is missing.
    """
    statuses = _sql_list((*live, *retired))
    retired_list = _sql_list(retired)
    if conn.dialect.name != "postgresql":
        _ensure_sqlite_guard(conn, table, born=born, statuses=statuses, retired=retired_list)
        return
    function = f"{table}_status_guard"
    _execute_constant(
        conn,
        f"CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $guard$\n"
        "BEGIN\n"
        f"  IF NEW.status NOT IN ({statuses}) THEN\n"
        f"    RAISE EXCEPTION '{table}: unknown status %', NEW.status USING ERRCODE = 'check_violation';\n"
        "  END IF;\n"
        f"  IF TG_OP = 'INSERT' AND NEW.status <> '{born}' THEN\n"
        f"    RAISE EXCEPTION '{table}: a job is born {born}, not %', NEW.status USING ERRCODE = 'check_violation';\n"
        "  END IF;\n"
        f"  IF TG_OP = 'UPDATE' AND OLD.status IN ({retired_list}) AND NEW.status <> OLD.status THEN\n"
        f"    RAISE EXCEPTION '{table}: job % is %, it cannot become %', OLD.job_id, OLD.status, NEW.status\n"
        "      USING ERRCODE = 'check_violation';\n"
        "  END IF;\n"
        "  RETURN NEW;\n"
        "END\n"
        "$guard$",
    )
    present = conn.execute(
        text("SELECT 1 FROM pg_trigger WHERE tgname = :name AND tgrelid = to_regclass(:table)"),
        {"name": function, "table": table},
    ).scalar()
    if not present:
        _execute_constant(
            conn,
            f"CREATE TRIGGER {function} BEFORE INSERT OR UPDATE OF status ON {table} "
            f"FOR EACH ROW EXECUTE FUNCTION {function}()",
        )


def _ensure_sqlite_guard(conn, table: str, *, born: str, statuses: str, retired: str) -> None:
    """The same rule as two SQLite triggers, so the suites that run on SQLite meet it too."""
    _execute_constant(
        conn,
        f"CREATE TRIGGER IF NOT EXISTS {table}_status_born BEFORE INSERT ON {table} "
        f"WHEN NEW.status <> '{born}' OR NEW.status NOT IN ({statuses}) "
        f"BEGIN SELECT RAISE(ABORT, '{table}: a job is born {born}'); END",
    )
    _execute_constant(
        conn,
        f"CREATE TRIGGER IF NOT EXISTS {table}_status_moves BEFORE UPDATE OF status ON {table} "
        f"WHEN NEW.status NOT IN ({statuses}) OR (OLD.status IN ({retired}) AND NEW.status <> OLD.status) "
        f"BEGIN SELECT RAISE(ABORT, '{table}: illegal status transition'); END",
    )


def _sql_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _execute_constant(conn, statement: str) -> None:
    """Run DDL built from module constants and dialect literals; nothing here is user input."""
    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    conn.execute(text(statement))
