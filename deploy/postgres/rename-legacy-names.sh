#!/bin/sh
# Rename the databases and the application role the platform inherited from the
# AI-Q blueprint to names without a brand (ADR-0145 row 10d):
#
#   aiq_jobs        -> jobs
#   aiq_checkpoints -> checkpoints
#   grid_app        -> app
#   role aiq        -> agent
#
# and, once the migrations have run (`after-migrate`), the row-level-security
# roles:
#
#   grid_app_owner    -> app_owner
#   grid_app_platform -> app_platform
#   grid_app_rw       -> app_rw
#   grid_keda_scaler  -> keda_scaler
#
# The roles go last because the migrations written before the rename grant to
# them by their old names: a fresh install creates them under those names
# (`ensure_rls_roles` here, `init-db.sql` in Compose), migrates, and renames.
#
# Run on every deploy before the backend starts: the Kubernetes Jobs
# `pg-rename-legacy-names` and `pg-rename-rls-roles`
# (deploy/pulumi/src/data/postgres-rename.ts) and the Compose services
# `postgres-rename` and `postgres-rename-roles`. Idempotent: a name already
# renamed is left alone, and a fresh install that never had the old names is
# left alone too, so the second run is a no-op.
#
# It connects as a superuser to the maintenance database `postgres`, from the
# libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD). A database is renamed
# with new connections refused and the open ones terminated: the deploy that
# carries this is a short outage, which the release note says. ROLE_PASSWORD,
# when set, becomes the role's password afterwards, because a rename clears an
# MD5 hash (a SCRAM one survives). RUNTIME_PASSWORD and SCALER_PASSWORD, when
# set, are the runtime and the KEDA scaler role's passwords: Kubernetes keeps
# these roles here rather than in the Cluster's `managed.roles`, which would
# create the new names as new, empty roles before the rename ran.
#
# Usage: rename-legacy-names.sh [after-migrate]
set -eu
PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
export PGOPTIONS

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

# Compose logs in as the superuser it creates, `agent` on a fresh volume and `aiq`
# on one from before this script. Kubernetes logs in as `postgres`, whose
# password the operator sets a moment after superuser access is switched on,
# so a refused login is retried for a while before it fails the run.
log_in() {
  tries=0
  until q -c "SELECT 1" >/dev/null 2>&1; do
    if [ "${PGUSER:-}" = agent ] && (PGUSER=aiq && export PGUSER && q -c "SELECT 1" >/dev/null 2>&1); then
      PGUSER=aiq
      export PGUSER
      return
    fi
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || q -c "SELECT 1"
    sleep 5
  done
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
  helper=rename_helper
  helper_password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  q -c "DROP ROLE IF EXISTS $helper" -c "CREATE ROLE $helper SUPERUSER LOGIN PASSWORD '$helper_password'"
  as_role "$helper" "$helper_password" -c "ALTER ROLE $old RENAME TO $new"
  # The superuser is now called $new. Its password survives unless the hash was
  # MD5, so set it before logging in under the new name.
  if [ -n "${ROLE_PASSWORD:-}" ]; then
    echo "ALTER ROLE $new PASSWORD :'password'" | as_role "$helper" "$helper_password" -v password="$ROLE_PASSWORD"
    PGPASSWORD=$ROLE_PASSWORD
  fi
  PGUSER=$new
  export PGUSER PGPASSWORD
  q -c "DROP ROLE $helper"
  echo "role $old -> $new"
}

set_password() {
  role=$1
  password=${2:-${ROLE_PASSWORD:-}}
  [ -n "$password" ] || return 0
  role_exists "$role" || return 0
  echo "ALTER ROLE $role PASSWORD :'password'" | q -v password="$password"
}

# The row-level-security roles, old name then new (ADR-0041, ADR-0145 row 10d).
RLS_ROLES="grid_app_owner:app_owner grid_app_platform:app_platform grid_app_rw:app_rw grid_keda_scaler:keda_scaler"

# Whichever of a role's two names exists, or nothing.
current_name() {
  if role_exists "$2"; then echo "$2"; elif role_exists "$1"; then echo "$1"; fi
}

# Before the migrations: every row-level-security role exists under one of its
# names. One that has neither is a fresh install, created under the OLD name
# the earlier migrations grant to; `after-migrate` renames it. The scaler role
# only where its password is set (Kubernetes). Passwords follow the Secrets.
ensure_rls_roles() {
  for pair in $RLS_ROLES; do
    old=${pair%%:*}
    new=${pair#*:}
    [ -z "$(current_name "$old" "$new")" ] || continue
    case $new in
      app_owner) q -c "CREATE ROLE $old LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE" ;;
      app_platform) q -c "CREATE ROLE $old NOLOGIN BYPASSRLS" ;;
      app_rw) q -c "CREATE ROLE $old LOGIN NOINHERIT NOBYPASSRLS" ;;
      keda_scaler)
        [ -n "${SCALER_PASSWORD:-}" ] || continue
        q -c "CREATE ROLE $old LOGIN NOINHERIT NOBYPASSRLS CONNECTION LIMIT ${SCALER_CONNECTION_LIMIT:-4}"
        ;;
    esac
    echo "role $old: created"
  done
  # The runtime role steps up to the platform role per transaction, by asking.
  q -c "GRANT $(current_name grid_app_platform app_platform) TO $(current_name grid_app_rw app_rw)"
  set_rls_passwords
}

set_rls_passwords() {
  set_password "$(current_name grid_app_rw app_rw)" "${RUNTIME_PASSWORD:-}"
  set_password "$(current_name grid_keda_scaler keda_scaler)" "${SCALER_PASSWORD:-}"
}

rename_rls_roles() {
  for pair in $RLS_ROLES; do
    rename_role "${pair%%:*}" "${pair#*:}"
  done
  set_rls_passwords
}

wait_for_server
log_in
if [ "${1:-}" = after-migrate ]; then
  rename_rls_roles
  echo "rename of the row-level-security roles: done"
  exit 0
fi
rename_database aiq_jobs jobs
rename_database aiq_checkpoints checkpoints
rename_database grid_app app
rename_role aiq agent
set_password agent
[ -z "${ENSURE_RLS_ROLES:-}" ] || ensure_rls_roles
# Left behind only by a run that died between creating and dropping it.
q -c "DROP ROLE IF EXISTS rename_helper"
echo "rename of the legacy names: done"
