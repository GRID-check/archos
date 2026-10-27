"""``deploy/postgres/rename-legacy-names.sh`` renames the branded databases and roles, once (ADR-0145 row 10d).

It runs on every deploy before the backend starts, on Kubernetes as the
``postgres`` superuser and on Compose as the role it renames, so each shape is
run here against a real server, twice: the second run must change nothing. A
client still connected to an old database is what the deploy will meet, so one
is held open while the script runs.

Needs a superuser URL to a throwaway cluster in ``GRID_TEST_POSTGRES_URL``
(``task be:test:postgres`` provides one) and ``psql`` on the PATH.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "postgres" / "rename-legacy-names.sh"
_URL = os.environ.get("GRID_TEST_POSTGRES_URL")

pytestmark = pytest.mark.skipif(
    not _URL or not shutil.which("psql"), reason="GRID_TEST_POSTGRES_URL or psql not available"
)

OLD_DATABASES = ("aiq_jobs", "aiq_checkpoints")
NEW_DATABASES = ("jobs", "checkpoints")
RLS_ROLES = {
    "grid_app_owner": "app_owner",
    "grid_app_platform": "app_platform",
    "grid_app_rw": "app_rw",
    "grid_keda_scaler": "keda_scaler",
}
ROLES = ("aiq", "agent", "rename_helper", *RLS_ROLES, *RLS_ROLES.values())
RLS_PASSWORDS = {
    "RUNTIME_PASSWORD": "rw-test-password",
    "SCALER_PASSWORD": "scaler-test-password",
}  # pragma: allowlist secret


def _env(user: str) -> dict[str, str]:
    url = urlparse(_URL or "")
    return {
        **os.environ,
        "PGHOST": url.hostname or "127.0.0.1",
        "PGPORT": str(url.port or 5432),
        "PGUSER": user,
        "PGPASSWORD": url.password or "unused",
    }


def _superuser() -> str:
    return urlparse(_URL or "").username or "postgres"


def _psql(sql: str, user: str | None = None, database: str = "postgres") -> str:
    result = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-tAq", "-d", database, "-c", sql],
        env=_env(user or _superuser()),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _run_script(user: str, *args: str, **extra: str) -> subprocess.CompletedProcess[str]:
    env = {**_env(user), "ROLE_PASSWORD": "test-password", **extra}  # pragma: allowlist secret (throwaway cluster)
    return subprocess.run(["sh", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=120, check=False)


def _login(role: str, password: str, sql: str, database: str = "postgres") -> str:
    url = urlparse(_URL or "")
    env = {**_env(role), "PGPASSWORD": password, "PGHOST": url.hostname or "127.0.0.1"}
    result = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-tAq", "-h", url.hostname or "127.0.0.1", "-d", database, "-c", sql],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _databases() -> set[str]:
    return set(_psql("SELECT datname FROM pg_database").split())


def _roles() -> set[str]:
    return set(_psql("SELECT rolname FROM pg_roles").split())


@pytest.fixture(autouse=True)
def _clean_cluster():
    def clean():
        for name in (*OLD_DATABASES, *NEW_DATABASES, "grid_app", "app"):
            _psql(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        for role in ROLES:
            _psql(f"DROP ROLE IF EXISTS {role}")

    clean()
    yield
    clean()


def _old_install(*, superuser: bool) -> None:
    attributes = "SUPERUSER LOGIN" if superuser else "LOGIN"
    _psql(f"CREATE ROLE aiq {attributes} PASSWORD 'aiq-test-password'")  # pragma: allowlist secret
    for name in OLD_DATABASES:
        _psql(f"CREATE DATABASE {name} OWNER aiq")
    _psql("CREATE TABLE job_info (id int)", user="aiq", database="aiq_jobs")


def _assert_renamed(*, with_data: bool = True) -> None:
    databases = _databases()
    assert set(NEW_DATABASES) <= databases
    assert not set(OLD_DATABASES) & databases
    roles = _roles()
    assert "agent" in roles
    assert not {"aiq", "rename_helper"} & roles
    for name in NEW_DATABASES:
        assert _psql(f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '{name}'") == "agent"
        assert _psql(f"SELECT datallowconn FROM pg_database WHERE datname = '{name}'") == "t"
    # The data came along, and the renamed role reaches it.
    if with_data:
        assert _psql("SELECT count(*) FROM job_info", user="agent", database="jobs") == "0"


def test_kubernetes_shape_renames_under_a_live_connection_and_a_second_run_is_a_no_op():
    _old_install(superuser=False)
    held = subprocess.Popen(
        ["psql", "-X", "-d", "aiq_jobs", "-c", "SELECT pg_sleep(60)"],
        env=_env("aiq"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while _psql("SELECT count(*) FROM pg_stat_activity WHERE datname = 'aiq_jobs'") == "0":
            assert time.monotonic() < deadline, "the held connection never opened"
            time.sleep(0.1)

        first = _run_script(_superuser())
        assert first.returncode == 0, first.stderr
        assert "aiq_jobs -> jobs" in first.stdout
        assert "role aiq -> agent" in first.stdout
        assert held.wait(timeout=30) != 0, "the connection to the old database survived the rename"
    finally:
        held.kill()

    _assert_renamed()
    second = _run_script(_superuser())
    assert second.returncode == 0, second.stderr
    assert "->" not in second.stdout
    _assert_renamed()


def test_compose_shape_renames_the_superuser_it_logs_in_as():
    # Compose's only superuser is the role being renamed, and it starts the
    # script under the new name, which does not exist yet.
    _old_install(superuser=True)

    first = _run_script("agent")
    assert first.returncode == 0, first.stderr
    assert "role aiq -> agent" in first.stdout
    _assert_renamed()

    second = _run_script("agent")
    assert second.returncode == 0, second.stderr
    assert "->" not in second.stdout
    _assert_renamed()


def test_a_fresh_install_without_the_old_names_is_left_alone():
    _psql("CREATE ROLE agent LOGIN")
    for name in NEW_DATABASES:
        _psql(f"CREATE DATABASE {name} OWNER agent")

    result = _run_script(_superuser())

    assert result.returncode == 0, result.stderr
    assert "->" not in result.stdout
    _assert_renamed(with_data=False)


def test_the_app_database_is_renamed_before_the_migrations():
    _psql("CREATE ROLE agent LOGIN")
    _psql("CREATE DATABASE grid_app OWNER agent")

    first = _run_script(_superuser())

    assert first.returncode == 0, first.stderr
    assert "grid_app -> app" in first.stdout
    assert {"app"} <= _databases() and "grid_app" not in _databases()
    assert "->" not in _run_script(_superuser()).stdout


def test_a_fresh_install_migrates_under_the_old_role_names_and_renames_them_after():
    # Kubernetes keeps these roles in the script, not in CloudNativePG's
    # `managed.roles`. A fresh cluster has none: the migrations written before
    # the rename grant to the old names, so those are what it creates.
    _psql("CREATE ROLE agent LOGIN")
    _psql("CREATE DATABASE app OWNER agent")

    before = _run_script(_superuser(), ENSURE_RLS_ROLES="1", **RLS_PASSWORDS)
    assert before.returncode == 0, before.stderr
    assert {"grid_app_owner", "grid_app_platform", "grid_app_rw", "grid_keda_scaler"} <= _roles()
    assert not set(RLS_ROLES.values()) & _roles()
    # What a migration does with them: a grant to the runtime role by its old name.
    _psql("CREATE TABLE notes (id int)", database="app")
    _psql("GRANT SELECT ON notes TO grid_app_rw", database="app")

    after = _run_script(_superuser(), "after-migrate", **RLS_PASSWORDS)

    assert after.returncode == 0, after.stderr
    assert "role grid_app_rw -> app_rw" in after.stdout
    assert set(RLS_ROLES.values()) <= _roles() and not set(RLS_ROLES) & _roles()
    # The grant, the password and the step-up all came along.
    assert _login("app_rw", RLS_PASSWORDS["RUNTIME_PASSWORD"], "SELECT count(*) FROM notes", database="app") == "0"
    assert (
        _login("app_rw", RLS_PASSWORDS["RUNTIME_PASSWORD"], "SET ROLE app_platform; SELECT current_user")
        == "app_platform"
    )
    assert _login("keda_scaler", RLS_PASSWORDS["SCALER_PASSWORD"], "SELECT current_user") == "keda_scaler"
    assert _psql("SELECT rolbypassrls::text || rolinherit::text FROM pg_roles WHERE rolname = 'app_rw'") == "falsefalse"

    again = _run_script(_superuser(), "after-migrate", **RLS_PASSWORDS)
    assert again.returncode == 0, again.stderr
    assert "->" not in again.stdout
    # The next deploy's first step finds the new names and creates nothing.
    rerun = _run_script(_superuser(), ENSURE_RLS_ROLES="1", **RLS_PASSWORDS)
    assert rerun.returncode == 0, rerun.stderr
    assert "created" not in rerun.stdout and not set(RLS_ROLES) & _roles()


def test_compose_renames_the_roles_init_db_created_without_a_scaler():
    _old_install(superuser=True)
    _psql("CREATE ROLE grid_app_platform NOLOGIN BYPASSRLS")
    _psql("CREATE ROLE grid_app_rw LOGIN NOINHERIT")
    _psql("GRANT grid_app_platform TO grid_app_rw")
    assert _run_script("agent").returncode == 0

    after = _run_script("agent", "after-migrate")

    assert after.returncode == 0, after.stderr
    assert {"app_platform", "app_rw"} <= _roles() and not {"grid_app_platform", "grid_app_rw", "keda_scaler"} & _roles()
    assert _psql("SELECT pg_has_role('app_rw', 'app_platform', 'MEMBER')::text") == "true"
