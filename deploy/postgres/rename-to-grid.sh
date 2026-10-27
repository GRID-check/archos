#!/bin/sh
# Rename the databases and the application role the platform inherited from the
# AI-Q blueprint to their grid names (ADR-0145 row 10d):
#
#   aiq_jobs        -> grid_jobs
#   aiq_checkpoints -> grid_checkpoints
#   role aiq        -> grid
#
# Run on every deploy before the backend starts: the Kubernetes Job
# `pg-rename-to-grid` (deploy/pulumi/src/data/postgres-rename.ts) and the
# Compose service `postgres-rename`. Idempotent: a name already renamed is left
# alone, and a fresh install that never had the old names is left alone too, so
# the second run is a no-op.
#
# It connects as a superuser to the maintenance database `postgres`, from the
# libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD). A database is renamed
# with new connections refused and the open ones terminated: the deploy that
# carries this is a short outage, which the release note says. GRID_PASSWORD,
# when set, becomes the role's password afterwards, because a rename clears an
# MD5 hash (a SCRAM one survives).
#
# Usage: rename-to-grid.sh
set -eu

q() { psql -X -v ON_ERROR_STOP=1 -tAq -d postgres "$@"; }
database_exists() { [ "$(q -c "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
role_exists() { [ "$(q -c "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = 1 ]; }
# `as_role USER PASSWORD psql-args…`: one psql call as another login. A subshell,
# because a POSIX shell may keep `VAR=x function` assignments after the call.
as_role() { (PGUSER=$1 PGPASSWORD=$2 && export PGUSER PGPASSWORD && shift 2 && q "$@"); }

wait_for_server() {
  tries=0
  until pg_isready -q -d postgres; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { echo "postgres is not reachable" >&2; exit 1; }
    sleep 2
  done
}

# Compose logs in as the superuser it creates, `grid` on a fresh volume and `aiq`
# on one from before this script. Kubernetes logs in as `postgres` and never
# falls back.
log_in() {
  q -c "SELECT 1" >/dev/null 2>&1 && return
  [ "${PGUSER:-}" = grid ] || q -c "SELECT 1"
  PGUSER=aiq
  export PGUSER
  q -c "SELECT 1" >/dev/null
}

rename_database() {
  old=$1
  new=$2
  if database_exists "$new"; then
    # A run that died between the rename and this line left it closed.
    q -c "ALTER DATABASE $new ALLOW_CONNECTIONS true"
    echo "$new: present"
    return
  fi
  if ! database_exists "$old"; then
    echo "$old: absent, nothing to rename"
    return
  fi
  # Refuse new sessions first, or a client that reconnects between the
  # terminate and the rename keeps the database busy forever.
  q -c "ALTER DATABASE $old ALLOW_CONNECTIONS false"
  tries=0
  until q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$old' AND pid <> pg_backend_pid()" >/dev/null &&
    q -c "ALTER DATABASE $old RENAME TO $new" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || q -c "ALTER DATABASE $old RENAME TO $new"
    sleep 1
  done
  q -c "ALTER DATABASE $new ALLOW_CONNECTIONS true"
  echo "$old -> $new"
}

# A session cannot rename its own role. On Compose the only superuser IS the
# role being renamed, so a temporary superuser does it and is dropped after.
rename_role() {
  old=$1
  new=$2
  if role_exists "$new" || ! role_exists "$old"; then
    echo "role $new: present or nothing to rename"
    return
  fi
  if [ "$(q -c "SELECT current_user")" != "$old" ]; then
    q -c "ALTER ROLE $old RENAME TO $new"
    echo "role $old -> $new"
    return
  fi
  helper=grid_rename_helper
  helper_password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  q -c "DROP ROLE IF EXISTS $helper" -c "CREATE ROLE $helper SUPERUSER LOGIN PASSWORD '$helper_password'"
  as_role "$helper" "$helper_password" -c "ALTER ROLE $old RENAME TO $new"
  # The superuser is now called $new. Its password survives unless the hash was
  # MD5, so set it before logging in under the new name.
  if [ -n "${GRID_PASSWORD:-}" ]; then
    echo "ALTER ROLE $new PASSWORD :'password'" | as_role "$helper" "$helper_password" -v password="$GRID_PASSWORD"
    PGPASSWORD=$GRID_PASSWORD
  fi
  PGUSER=$new
  export PGUSER PGPASSWORD
  q -c "DROP ROLE $helper"
  echo "role $old -> $new"
}

set_password() {
  role=$1
  [ -n "${GRID_PASSWORD:-}" ] || return 0
  role_exists "$role" || return 0
  echo "ALTER ROLE $role PASSWORD :'password'" | q -v password="$GRID_PASSWORD"
}

wait_for_server
log_in
rename_database aiq_jobs grid_jobs
rename_database aiq_checkpoints grid_checkpoints
rename_role aiq grid
set_password grid
# Left behind only by a run that died between creating and dropping it.
q -c "DROP ROLE IF EXISTS grid_rename_helper"
echo "rename to grid names: done"
