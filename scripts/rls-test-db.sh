#!/usr/bin/env bash
# Stand up a throwaway Postgres, apply the full drizzle migration chain, and run
# the row-level-security isolation suite against it as `grid_app_rw` (ADR-0041).
#
# The suite has to run as the RESTRICTED role. Connecting as the owner would
# pass every assertion while proving nothing, because row-level security does
# not apply to a table's owner — so this script is the difference between the
# tests meaning something and merely appearing to.
#
# Everything lives under a temporary directory and is torn down on exit; no
# existing cluster is touched.
set -euo pipefail

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../frontends/ui" && pwd)"
# A port nobody holds, unless the caller names one. Parallel runs in one
# container (two agents, two worktrees) each get their own: a fixed default made
# the second die at `pg_ctl: could not start server` before any migration ran.
# TCP on 127.0.0.1 rather than the unix socket alone, because the vitest suites
# below connect to 127.0.0.1:$PORT. The OS picks an ephemeral port and the
# probe releases it; the window before `pg_ctl` binds it again is milliseconds.
PORT="${RLS_TEST_PORT:-$(node -e '
  const server = require("net").createServer();
  server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
')}"
# `|| true` matters: under `set -e` a glob that matches nothing makes the
# substitution non-zero and kills the script here, so the friendly "install
# postgresql, or set PGBIN" message below would never be the thing an operator
# without server binaries actually sees.
PGBIN="${PGBIN:-$(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -1 || true)}"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/pgdata"
RUNTIME_PASSWORD="rls_test_pw"  # pragma: allowlist secret (throwaway cluster, destroyed on exit)

if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "error: no PostgreSQL server binaries found. Install postgresql, or set PGBIN." >&2
  exit 1
fi

cleanup() {
  # Through run_pg, not directly: pg_ctl refuses to run as root, and on a root
  # host the direct call failed under `|| true` while the rm -rf below deleted
  # the data directory out from under a server that kept running. (CI is
  # unprivileged, which is why it never showed there.) run_pg is defined after
  # this trap is armed, so the early exits above it fall back to the direct call.
  if declare -F run_pg >/dev/null; then
    run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true
  else
    "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# initdb refuses to run as root, which is normal in CI containers; fall back to
# the `postgres` system user when there is one.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then
    RUNAS="postgres"
    # The unix socket is created in WORKDIR (-k), so that directory has to be
    # writable by the dropped-to user too, not just PGDATA.
    mkdir -p "$PGDATA"
    chown "$RUNAS" "$WORKDIR" "$PGDATA"
    chmod 755 "$WORKDIR"
  else
    echo "error: running as root and no 'postgres' user exists to drop to." >&2
    exit 1
  fi
fi
run_pg() { if [ -n "$RUNAS" ]; then su "$RUNAS" -c "$1"; else sh -c "$1"; fi; }

echo "==> initialising a throwaway cluster on port $PORT"
run_pg "'$PGBIN/initdb' -D '$PGDATA' -U postgres --auth=trust" >/dev/null
run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -o '-p $PORT -k $WORKDIR' -l '$PGDATA/server.log' -w start" >/dev/null

# NOTICEs from the idempotent DROP ... IF EXISTS guards are expected noise.
export PGOPTIONS="-c client_min_messages=warning"
PSQL="$PGBIN/psql -h $WORKDIR -p $PORT -U postgres"

# `--exec <command…>`: the same throwaway cluster, without the migration chain or
# the suites below, for the Python suites whose Postgres branch would otherwise
# skip (`task be:test:postgres`). They create and drop their own tables, so they
# get an empty scratch database as the superuser, in AIQ_TEST_POSTGRES_URL.
if [ "${1:-}" = "--exec" ]; then
  shift
  $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE aiq_queues;"
  echo "==> running: $*"
  AIQ_TEST_POSTGRES_URL="postgresql://postgres@127.0.0.1:$PORT/aiq_queues" "$@"
  exit 0
fi

# Reproduce the DEPLOYMENT topology, not a convenient one. Migrations run as a
# plain non-superuser database owner with no CREATEROLE and no BYPASSRLS —
# exactly what CloudNativePG hands the app. Running this chain as `postgres`
# instead is why an earlier version of the migration shipped a CREATE ROLE that
# could never have executed on Kubernetes.
echo "==> provisioning roles (a deployment concern, not a migration one)"
$PSQL -q -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE grid_app_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB;" \
  -c "CREATE ROLE grid_app_platform NOLOGIN BYPASSRLS;" \
  -c "CREATE ROLE grid_app_rw LOGIN NOINHERIT PASSWORD '$RUNTIME_PASSWORD';" \
  -c "GRANT grid_app_platform TO grid_app_rw;" \
  -c "CREATE DATABASE grid_app OWNER grid_app_owner;"

echo "==> applying the migration chain as grid_app_owner (no CREATEROLE, no BYPASSRLS)"
cd "$UI_DIR"
MIGRATE="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_app"
node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  $MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "MIGRATION FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

# Every suite here needs the same cluster and the same restricted role. The BIM
# and memory ones are here rather than in the unit shards because every claim
# they make is a claim about SQL — jsonb property filters, grouped aggregates,
# the element-to-model tenancy join, "one fact, one live row" through a raw
# cosine query — and a mocked drizzle handle cannot disagree with the fixture
# that mocked it. (The memory suite is the one that found the semantic gate
# reading `.rows` off a postgres-js array, which every mock had agreed with.)
echo "==> running the isolation, BIM query, memory consolidation, profile-binding, legal-hold, chat-erasure, restricted-use, cross-project use, similar passages, project intake, run-reconciler, usage-ledger, answer-feedback, restricted memory, download-log, Papierkorb, closed-project, Steckbrief, Ausmisten, upload batches, quarantine decisions, restricted-feedback, revision-subject, the hold on a document, permit-record, push subscription, inbox paging, Anmerkungen and Offene Punkte suites as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run \
    src/lib/db/tenant-isolation.integration.spec.ts \
    src/lib/bim/query.integration.spec.ts \
    src/lib/bim/model-shelf.integration.spec.ts \
    src/lib/projects/memory-service.integration.spec.ts \
    src/lib/projects/memory-restricted.integration.spec.ts \
    src/lib/documents/document-versions.integration.spec.ts \
    src/lib/documents/list-page.integration.spec.ts \
    src/lib/documents/quarantine-listing.integration.spec.ts \
    src/lib/documents/visibility.integration.spec.ts \
    src/lib/upload-batches/upload-batches.integration.spec.ts \
    src/lib/authz/folder-access.integration.spec.ts \
    src/lib/projects/collection-placement.integration.spec.ts \
    src/lib/projects/folder-visibility.integration.spec.ts \
    src/lib/documents/shelf-folders.integration.spec.ts \
    src/lib/projects/folder-bin.integration.spec.ts \
    src/lib/documents/stuck-processing.integration.spec.ts \
    src/lib/documents/retry-policy.integration.spec.ts \
    src/lib/project-profile/profile-bindings.integration.spec.ts \
    src/lib/compliance/legal-hold.integration.spec.ts \
    src/lib/conversations/erasure-queue.integration.spec.ts \
    src/lib/conversations/restricted-use.integration.spec.ts \
    src/lib/feedback/restricted-feedback.integration.spec.ts \
    src/lib/tasks/subject-access.integration.spec.ts \
    src/lib/conversations/cross-project-use.integration.spec.ts \
    src/lib/cross-project/decisions-repository.integration.spec.ts \
    src/lib/similar-passages/service.integration.spec.ts \
    src/lib/permits/repository.integration.spec.ts \
    src/lib/annotations/repository.integration.spec.ts \
    src/lib/annotations/project-repository.integration.spec.ts \
    src/lib/proposals/repository.integration.spec.ts \
    src/lib/project-intake/repository.integration.spec.ts \
    src/lib/changes/repository.integration.spec.ts \
    src/lib/push/repository.integration.spec.ts \
    src/lib/inbox/repository.integration.spec.ts \
    src/lib/project-experience/readable-files.integration.spec.ts \
    src/lib/projects/memory-evidence.integration.spec.ts \
    src/lib/download-log/download-log.integration.spec.ts \
    src/lib/runs/reconcile.integration.spec.ts \
    src/lib/budgets/service.integration.spec.ts \
    src/lib/analytics/usage-export-repository.integration.spec.ts \
    src/lib/feedback/repository.integration.spec.ts \
    src/lib/citations/repository.integration.spec.ts \
    src/lib/profiler/repository.integration.spec.ts \
    src/lib/projects/project-status.integration.spec.ts \
    src/lib/projects/project-record.integration.spec.ts \
    src/lib/projects/cleanup.integration.spec.ts \
    src/lib/feedback/repository.integration.spec.ts

# The tenant suites above may leave queued jobs behind: Ausmisten bins a
# subfolder, and a Papierkorb delete queues its purge takeover and a refused
# one its restore. The job-queue suites claim from the whole table and expect
# only their own seeds, so they start from an empty one.
$MIGRATE -v ON_ERROR_STOP=1 -q -c "DELETE FROM bff_job_queue" >/dev/null

# The job-queue suites claim from ONE table, whichever lane a job is in, so run
# in parallel they claim each other's seeded jobs. One file at a time. The
# scheduler's due-scan is the same shape over task_definitions, every tenant's.
echo "==> running the job-queue and scheduler-claim suites one file at a time as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run --no-file-parallelism \
    src/lib/jobs-queue/queue.integration.spec.ts \
    src/lib/jobs-queue/repository.integration.spec.ts \
    workers/jobs/runner.integration.spec.mjs \
    scheduler/db.integration.spec.mjs

# Everything below re-proves one migration of the chain at a time: a database
# migrated to just before it, seeded with the old shapes, checked row by row,
# then taken down. Those claims read nothing but frontends/ui/drizzle/ and this
# script, and they are ~60% of this script's time. CI's Plan sets
# GRID_RLS_MIGRATION_CHECKS=0 when neither changed (the `migrations` tier in
# .github/filters.yml); unset, as locally, they run.
if [ "${GRID_RLS_MIGRATION_CHECKS:-1}" = "0" ]; then
  echo "==> per-migration backfill and down checks skipped: no migration and not this script changed"
  exit 0
fi

# ---------------------------------------------------------------------------
# The migration sections below each check one migration on a database of its
# own, migrated to exactly the point that migration follows.
#
# Replaying the journal into every one of them cost each section the whole
# chain again: about 90 of the run's 150 seconds, and growing with every
# migration twice over, once for the longer chain and once for its own section.
# Instead the chain is applied ONCE, into `grid_chain`, a template that only
# moves forward, and each section clones it (`CREATE DATABASE ... TEMPLATE`),
# which copies the files rather than re-running the SQL. A clone is the same
# database the replay produced: the migrations set nothing at database level,
# the one thing a template does not carry. A section that asks for an earlier
# point than the template holds gets a template rebuilt from scratch.
#
# `migrate_until <db> <tag>` gives <db> the journal up to and including <tag>,
# `migrate_before <db> <tag>` up to the migration before it.
# ---------------------------------------------------------------------------
JOURNAL=()
while read -r tag; do JOURNAL+=("$tag"); done < <(node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
')
CHAIN_AT=-1  # index in JOURNAL of the last migration grid_chain holds; -1 = no grid_chain

journal_index() {
  local i
  for i in "${!JOURNAL[@]}"; do
    if [ "${JOURNAL[$i]}" = "$1" ]; then echo "$i"; return; fi
  done
  echo "$1 is not in the journal" >&2
  exit 1
}
# Clone grid_chain, advanced to JOURNAL[<index>], as <db>.
clone_chain_at() {
  local db="$1" target="$2" i
  if [ "$target" -lt "$CHAIN_AT" ]; then
    $PSQL -q -v ON_ERROR_STOP=1 -c "DROP DATABASE grid_chain;"
    CHAIN_AT=-1
  fi
  if [ "$CHAIN_AT" -lt 0 ]; then
    $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_chain OWNER grid_app_owner;"
  fi
  for ((i = CHAIN_AT + 1; i <= target; i++)); do
    $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_chain -v ON_ERROR_STOP=1 -q \
      -f "drizzle/${JOURNAL[$i]}.sql" >/dev/null || {
      echo "SETUP OF $db FAILED at ${JOURNAL[$i]} — re-run without -q to see the error" >&2
      exit 1
    }
    CHAIN_AT=$i
  done
  $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db TEMPLATE grid_chain OWNER grid_app_owner;"
}
migrate_until() {
  local at
  at=$(journal_index "$2")
  clone_chain_at "$1" "$at"
}
migrate_before() {
  local at
  at=$(journal_index "$2")
  clone_chain_at "$1" "$((at - 1))"
}

# ---------------------------------------------------------------------------
# Migration 0086: the backfill, asserted per row shape, and its DOWN migration.
#
# A second database in the same cluster, migrated only as far as 0085, seeded
# with fixtures in the old tables, then handed 0086 and checked row by row.
# Doing it here rather than in a spec is the point: the spec suites run AFTER
# the whole chain, when the old shapes cannot be created any more.
# ---------------------------------------------------------------------------
echo "==> verifying the 0086 backfill and its down migration on grid_backfill"
migrate_before grid_backfill 0086_task_definitions
MIGRATE_B="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_backfill"

# Four old shapes: a scheduled run with its task (and a rejection), a skipped
# fire with no task, an errored fire with no task, and a delegated task. Plus a
# legacy job-spawned task with no `job_run_id` (pre-0076 rows).
$MIGRATE_B -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'Backfill', 'user_1', 'proj_backfill');

-- The job_runs and tasks below name these two threads, and the composite
-- conversation FK (`(conversation_id, organization_id) -> conversations`)
-- rejects a dangling id — which would abort the seed before 0086 ever runs.
-- `job_id` stays NULL: these are ordinary person-started chats, and it is the
-- old model's column until 0086 repoints it at task_definitions.
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES
  ('s_conv_a', 'org_backfill', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('s_conv_d', 'org_backfill', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000001');

INSERT INTO jobs (id, project_id, organization_id, name, prompt, skill_name, skill_snapshot, output, data_sources, enabled, schedule_cron, schedule_timezone, next_run_at, last_run_at, created_by, created_by_email)
VALUES
  ('bbbbbbbb-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'A', 'Prüfe A', NULL, NULL, 'chat', '["knowledge_layer"]'::jsonb, true, '0 8 * * 1', 'Europe/Vienna', now() + interval '1 day', NULL, 'user_1', 'u@grid.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'B', 'Prüfe B', NULL, NULL, 'chat', NULL, true, NULL, 'UTC', NULL, NULL, 'user_1', 'u@grid.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'C', 'Prüfe C', NULL, NULL, 'deep-research', NULL, true, '0 6 * * *', 'UTC', now() + interval '2 days', NULL, 'user_1', 'u@grid.test');

INSERT INTO job_runs (id, schedule_id, project_id, organization_id, job_id, trigger, status, detail, conversation_id, skill_snapshot, triggered_by)
VALUES
  ('dddddddd-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'backend-a', 'schedule', 'submitted', NULL, 's_conv_a', '{}'::jsonb, 'scheduler'),
  ('dddddddd-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-0000000000b2', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', NULL, 'manual', 'skipped', 'org cap', NULL, '{}'::jsonb, 'user_1'),
  ('dddddddd-0000-4000-8000-0000000000c3', 'bbbbbbbb-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', NULL, 'schedule', 'error', 'backend unreachable', NULL, '{}'::jsonb, 'scheduler');

INSERT INTO tasks (id, organization_id, project_id, kind, title, plan, requester_user_id, requester_email, status, error, deadline_at, job_id, job_run_id, backend_job_id, conversation_id, review, review_reason, reviewed_by, reviewed_at, started_at)
VALUES
  ('eeeeeeee-0000-4000-8000-0000000000a1', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'chat', 'A', '{"prompt":"Prüfe A","skill":{},"dataSources":["knowledge_layer"]}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-0000000000a1', 'backend-a', 's_conv_a', 'rejected', 'zu kurz', 'user_1', now(), now() - interval '1 hour'),
  ('eeeeeeee-0000-4000-8000-0000000000d4', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'document', 'Dokument: Aktenvermerk', '{"prompt":"Schreibe …","skill":{},"dataSources":null,"goal":"Schreib den Aktenvermerk"}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, now() + interval '1 day', NULL, NULL, 'backend-d', 's_conv_d', NULL, NULL, NULL, NULL, now() - interval '10 minutes'),
  ('eeeeeeee-0000-4000-8000-0000000000e5', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'chat', 'A', '{"prompt":"Prüfe A","skill":{},"dataSources":["knowledge_layer"]}'::jsonb, 'user_1', 'u@grid.test', 'succeeded', NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000a1', NULL, 'backend-e', NULL, NULL, NULL, NULL, NULL, now() - interval '2 hours'),
  -- `tasks.conversation_id` carried NO foreign key before 0086, so a task can
  -- name a thread that is gone. The new run table's composite FK would reject
  -- the copy; the backfill must drop the provenance instead of aborting.
  ('eeeeeeee-0000-4000-8000-0000000000f6', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'document', 'Dokument: ohne Thread', '{"prompt":"Schreibe …","skill":{},"dataSources":null,"goal":"Ohne Thread"}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, NULL, NULL, NULL, 'backend-f', 's_conv_missing', NULL, NULL, NULL, NULL, now() - interval '20 minutes');
SQL

$MIGRATE_B -v ON_ERROR_STOP=1 -q -f "drizzle/0086_task_definitions.sql" >/dev/null || {
  echo "MIGRATION 0086 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

check() {
  local got
  got=$($MIGRATE_B -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "BACKFILL ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

# Definitions: three jobs + the delegated once arms.
check "SELECT count(*) FROM task_definitions" "5" "one definition per job, plus one for each delegated task"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'schedule'" "2" "jobs with a cron became schedules"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'manual'" "1" "a job with no cron became manual"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'once'" "2" "the delegated tasks became once definitions"
check "SELECT next_run_at > now() FROM task_definitions WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000a1'" "t" "the schedule's next fire survived and is in the future"

# Runs: the merged job_run+task, two task-less fires, the delegated tasks, and
# the legacy task with no job_run link.
check "SELECT count(*) FROM task_runs" "6" "one run per attempt across all four shapes"
check "SELECT status FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000a1'" "running" "the merged run took the TASK's lifecycle"
check "SELECT review || ':' || review_reason FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000a1'" "rejected:zu kurz" "the rejection reached the next run's record"
check "SELECT status || ':' || error FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000b2'" "skipped:org cap" "a skipped fire is a visible run with its reason"
check "SELECT status || ':' || error FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000c3'" "error:backend unreachable" "an errored fire is a visible run with its reason"
check "SELECT trigger FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "delegated" "the delegated attempt names its trigger"
check "SELECT definition_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "eeeeeeee-0000-4000-8000-0000000000d4" "the delegated definition is the task's own row"
check "SELECT definition_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000e5'" "bbbbbbbb-0000-4000-8000-0000000000a1" "the legacy task joined its job's definition"
check "SELECT coalesce(conversation_id, 'NULL') FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000f6'" "NULL" "a dangling task conversation was dropped, not carried into the FK"
check "SELECT conversation_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "s_conv_d" "a live conversation survives the guard"
check "SELECT to_regclass('public.uniq_task_runs_backend_job_id') IS NOT NULL" "t" "the backend-id lookup index exists"

# The DOWN migration: new tables gone, every old row intact.
$MIGRATE_B -v ON_ERROR_STOP=1 -q -f "drizzle/0086_task_definitions.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0086 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check "SELECT to_regclass('public.task_definitions') IS NULL" "t" "down dropped task_definitions"
check "SELECT to_regclass('public.task_runs') IS NULL" "t" "down dropped task_runs"
check "SELECT count(*) FROM jobs" "3" "down left the jobs table untouched"
check "SELECT count(*) FROM job_runs" "3" "down left the job_runs table untouched"
check "SELECT count(*) FROM tasks" "4" "down left the tasks table untouched"
check "SELECT confrelid::regclass::text FROM pg_constraint WHERE conname = 'conversations_job_id_fkey'" "jobs" "down repointed conversations.job_id at jobs"

echo "==> 0086 backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0092: existing duplicate version numbers are moved, not dropped,
# before the UNIQUE constraint lands — and its DOWN migration.
#
# The same arrangement as 0086 above: a database migrated only as far as 0091,
# seeded with the duplicates the pre-0092 race could write, then handed 0092.
# Without the renumbering the ADD CONSTRAINT fails the deploy on the first pair.
# ---------------------------------------------------------------------------
echo "==> verifying the 0092 renumbering and its down migration on grid_versions"
migrate_before grid_versions 0092_document_version_number_unique
MIGRATE_V="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_versions"

$MIGRATE_V -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000092', 'org_v', 'Versions', 'user_1', 'proj_versions');

INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES
  ('d0000000-0000-4000-8000-00000000000a', 'org_v', 'user_1', 'a.pdf', 'org/org_v/doc/a/a.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092'),
  ('d0000000-0000-4000-8000-00000000000b', 'org_v', 'user_1', 'b.pdf', 'org/org_v/doc/b/b.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092'),
  ('d0000000-0000-4000-8000-00000000000c', 'org_v', 'user_1', 'c.pdf', 'org/org_v/doc/c/c.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092');

-- Each document's history by hand. Document a: one duplicated pair (v2).
-- Document c: a triple (v1). Document b: nothing ambiguous, and it must come
-- out untouched.
INSERT INTO document_versions (id, organization_id, document_id, project_id, version_number, state, storage_key, approved_by, approved_at, published_by, published_at, created_by, created_at)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/a/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 2, 'superseded', 'k/a/v2', NULL, NULL, NULL, NULL, 'user_1', '2026-09-02T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000003', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 2, 'superseded', 'k/a/v2', NULL, NULL, NULL, NULL, 'user_1', '2026-09-02T10:00:01Z'),
  ('a1000000-0000-4000-8000-000000000004', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 3, 'published', 'k/a/v3', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-03T10:00:00Z'),
  ('b1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'published', 'k/b/1', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-01T10:00:00Z'),
  ('c1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/c/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:00Z'),
  ('c1000000-0000-4000-8000-000000000002', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/c/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:01Z'),
  ('c1000000-0000-4000-8000-000000000003', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'published', 'k/c/1b', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-01T10:00:02Z');
SQL

$MIGRATE_V -v ON_ERROR_STOP=1 -q -f "drizzle/0092_document_version_number_unique.sql" >/dev/null || {
  echo "MIGRATION 0092 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

checkv() {
  local got
  got=$($MIGRATE_V -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0092 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

numbers() {
  echo "SELECT string_agg(version_number::text, ',' ORDER BY created_at, id) FROM document_versions WHERE document_id = '$1'"
}
checkv "$(numbers d0000000-0000-4000-8000-00000000000a)" "1,2,4,3" "the later of a duplicated pair moved past the document's highest number; nothing else moved"
checkv "$(numbers d0000000-0000-4000-8000-00000000000b)" "1" "a document with no duplicates was not touched"
checkv "$(numbers d0000000-0000-4000-8000-00000000000c)" "1,2,3" "a triple was moved in creation order"
checkv "SELECT storage_key || ':' || state FROM document_versions WHERE id = 'a1000000-0000-4000-8000-000000000003'" "k/a/v2:superseded" "a moved row kept its key and its state"
checkv "SELECT count(*) FROM pg_constraint WHERE conname = 'document_versions_document_id_version_number_key'" "1" "the unique constraint exists"
checkv "SELECT to_regclass('public.idx_document_versions_document') IS NULL" "t" "the redundant plain index is gone"

if $MIGRATE_V -q -c "INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by) VALUES ('org_v', 'd0000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/b/dup', 'user_1')" >/dev/null 2>&1; then
  echo "0092 ASSERTION FAILED: a second version 1 of document b was accepted" >&2
  exit 1
fi

$MIGRATE_V -v ON_ERROR_STOP=1 -q -f "drizzle/0092_document_version_number_unique.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0092 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkv "SELECT count(*) FROM pg_constraint WHERE conname = 'document_versions_document_id_version_number_key'" "0" "down dropped the constraint"
checkv "SELECT to_regclass('public.idx_document_versions_document') IS NOT NULL" "t" "down restored the plain index"
checkv "SELECT count(*) FROM document_versions" "8" "down left every version row in place"

echo "==> 0092 renumbering and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0097: stored Herleitung steps rewritten into the chat wire v2
# shape, and its DOWN migration.
#
# A database migrated only as far as 0096, because the pre-v2 rows cannot be
# written once the v2 build's sanitizer guards the column. The spec seeds a
# captured turn in the old shape, runs 0097 (twice), asserts the rows and that
# `sanitizeProvenance` accepts them unchanged, then runs the down and 0097
# again. It connects as the owner, which is what runs a migration.
# ---------------------------------------------------------------------------
echo "==> verifying the 0097 Herleitung step rewrite and its down migration on grid_steps"
migrate_before grid_steps 0097_herleitung_steps_v2
MIGRATE_S="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_steps"

GRID_TEST_MIGRATION_DATABASE_URL="postgres://grid_app_owner@127.0.0.1:$PORT/grid_steps" \
  npx vitest run src/lib/conversations/derivation-steps-v2.migration.spec.ts

echo "==> 0097 step rewrite and down migration verified"

# ---------------------------------------------------------------------------
# Migrations 0111 to 0115 and 0118 to 0124: each on a database of its own.
#
# `migrate_until` (above) gives each its own clone of the chain, so every section
# below starts from exactly the chain it follows and a later migration never
# changes what an earlier section sees. `check_in` and `refused_in` assert against that database as its owner, which
# is what runs a migration.
# ---------------------------------------------------------------------------
# Run a migration file (or its down) against <db>, failing loudly.
apply_in() {
  $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q -f "drizzle/$2" >/dev/null || {
    echo "MIGRATION $2 FAILED on $1 — re-run without -q to see the error" >&2
    exit 1
  }
}
sql_in() { $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q >/dev/null; }
check_in() {
  local got
  got=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -tAc "$2")
  if [ "$got" != "$3" ]; then
    echo "MIGRATION ASSERTION FAILED on $1: $4" >&2
    echo "  query: $2" >&2
    echo "  got:   $got" >&2
    echo "  want:  $3" >&2
    exit 1
  fi
}
# Run SQL that must be REFUSED on <db>, and check the refusal names the rule ($3).
refused_in() {
  local out
  if out=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q 2>&1 <<<"$2"); then
    echo "MIGRATION ASSERTION FAILED on $1: $4 (the statement was accepted)" >&2
    exit 1
  fi
  if ! grep -q -- "$3" <<<"$out"; then
    echo "MIGRATION ASSERTION FAILED on $1: $4 (refused for another reason)" >&2
    echo "  output: $out" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Migration 0111: read/write grants per folder (ADR-0088), and its DOWN.
#
# What the database itself holds: a custom list may not be emptied (the
# deferred trigger), may be REPLACED in one transaction, refuses a level or a
# slug it does not know, holds at most 20 entries; a folder cannot become
# custom without a grant; a tombstone keeps its list and frees its name. The
# down removes the tombstones, the grants table and the columns, and puts
# develop's non-partial name index back; 0110 then re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0111 grants, their constraints and the down migration on grid_grants"
migrate_until grid_grants 0111_project_folder_grants
sql_in grid_grants <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'Grants 0110', 'user_1', 'proj_0106');
BEGIN;
INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('a1a1a1a1-a1a1-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Verträge', 'Verträge', 'custom', 'user_1', now()),
  ('b2b2b2b2-b2b2-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal', 'custom', 'user_1', now());
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('c3c3c3c3-c3c3-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Pläne', 'Pläne');
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-gf', 'write'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'b2b2b2b2-b2b2-4000-8000-000000000106', 'org-gf', 'write');
COMMIT;
SQL
check_in grid_grants "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_folder_grants'" "t" "the grants table is inside the tenant boundary"
check_in grid_grants "SELECT string_agg(name || '=' || access_mode, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Personal=custom,Pläne=inherit,Verträge=custom" "a folder inherits unless it has its own list"
refused_in grid_grants "DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106';" "it needs 1 to 20" "a custom list may not be emptied"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-pl', 'admin');" "project_folder_grants_level_check" "a level is read or write"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', '*org', 'read');" "project_folder_grants_role_check" "a slug never starts with the reserved *"
refused_in grid_grants "UPDATE project_folders SET access_mode = 'custom', access_changed_by = 'user_1', access_changed_at = now() WHERE id = 'c3c3c3c3-c3c3-4000-8000-000000000106';" "it needs 1 to 20" "a folder cannot become custom without a grant"
refused_in grid_grants "UPDATE project_folders SET access_changed_by = NULL WHERE id = 'a1a1a1a1-a1a1-4000-8000-000000000106';" "project_folders_access_custom_check" "a custom folder says who set its list"
sql_in grid_grants <<'SQL'
BEGIN;
-- Replacing a list in one transaction: delete, then insert. Deferred, so allowed.
DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106';
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', '*', 'read'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-gf', 'write');
-- A new folder with its own list: read for one role, write for another.
INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('d4d4d4d4-d4d4-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Honorare', 'Honorare', 'custom', 'user_1', now());
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-pl', 'read'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-gf', 'write');
-- Deleting Personal leaves its tombstone with its list; the name is free again.
UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'b2b2b2b2-b2b2-4000-8000-000000000106';
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('e5e5e5e5-e5e5-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal');
COMMIT;
SQL
check_in grid_grants "SELECT string_agg(role_slug || ':' || level, ',' ORDER BY role_slug) FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106'" "*:read,org-gf:write" "a list was replaced in one transaction"
check_in grid_grants "SELECT count(*) FROM project_folder_grants WHERE folder_id = 'b2b2b2b2-b2b2-4000-8000-000000000106'" "1" "a tombstone keeps its list"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) SELECT 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-extra-' || n, 'read' FROM generate_series(1, 19) AS n;" "it needs 1 to 20" "a list holds at most 20 entries"
refused_in grid_grants "INSERT INTO project_folders (organization_id, project_id, name, path) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal');" "uniq_project_folders_parent_name" "two living folders still cannot share a name"
apply_in grid_grants 0111_project_folder_grants.down.sql
check_in grid_grants "SELECT string_agg(name, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Honorare,Personal,Pläne,Verträge" "down removed the tombstone and kept every living folder"
check_in grid_grants "SELECT to_regclass('public.project_folder_grants') IS NULL" "t" "down dropped the grants table"
check_in grid_grants "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('access_mode', 'access_changed_by', 'access_changed_at', 'deleted_at', 'deleted_by')" "0" "down dropped the new columns"
check_in grid_grants "SELECT indexdef LIKE '%WHERE%' FROM pg_indexes WHERE indexname = 'uniq_project_folders_parent_name'" "f" "down put develop's non-partial name index back"
apply_in grid_grants 0111_project_folder_grants.sql
check_in grid_grants "SELECT string_agg(name || '=' || access_mode, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Honorare=inherit,Personal=inherit,Pläne=inherit,Verträge=inherit" "0110 re-applies, every folder inheriting"

echo "==> 0111 grants, constraints and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0112: the per-folder chat record, and its DOWN.
#
# One row per (conversation, source folder): inside the tenant boundary, and
# `last_at` never before `first_at`. The down drops the table; 0111 re-applies.
# The admission and read paths are proved against the real chain by
# restricted-use.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0112 chat record and its down migration on grid_chat_folders"
migrate_until grid_chat_folders 0112_conversation_restricted_folders
check_in grid_chat_folders "SELECT relrowsecurity FROM pg_class WHERE relname = 'conversation_restricted_folders'" "t" "the table is inside the tenant boundary"
refused_in grid_chat_folders "INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id, first_at, last_at) VALUES ('org_0107', 's_1', gen_random_uuid(), now(), now() - interval '1 minute');" "conversation_restricted_folders_order" "last_at never comes before first_at"
sql_in grid_chat_folders <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id)
VALUES ('org_0107', 's_never_created', 'a1a1a1a1-a1a1-4000-8000-000000000107');
SQL
check_in grid_chat_folders "SELECT count(*) FROM conversation_restricted_folders" "1" "a row needs no conversation row yet and no folder row (no foreign keys)"
apply_in grid_chat_folders 0112_conversation_restricted_folders.down.sql
check_in grid_chat_folders "SELECT to_regclass('public.conversation_restricted_folders') IS NULL" "t" "down dropped the table"
apply_in grid_chat_folders 0112_conversation_restricted_folders.sql
check_in grid_chat_folders "SELECT count(*) FROM conversation_restricted_folders" "0" "0111 re-applies, empty"

echo "==> 0112 chat record and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0113: restricted memory by folder, and its DOWN.
#
# An open and a restricted note with the same text can both be live (the 0112
# index); an empty folder list and a restricted organization note are refused
# (the 0112 CHECK). The down is lossy on purpose and in the safe direction:
# restricted notes are DELETED, because dropping the column alone would serve
# them to everyone. It restores develop's dedup index; 0112 then re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0113 restricted memory and its down migration on grid_memory"
migrate_until grid_memory 0113_project_memory_restricted_folders
sql_in grid_memory <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'Memory 0112', 'user_1', 'proj_0108');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', NULL),
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);
SQL
check_in grid_memory "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0108' AND status = 'active'" "2" "an open and a restricted note with the same text are both live"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal');" "uniq_project_memory_project_content_active" "a second open note with the same text is still one too many"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'leer', '{}');" "project_memory_restricted_folders_check" "an empty folder list is not a restriction"
refused_in grid_memory "INSERT INTO project_memory (scope, organization_id, kind, content, restricted_folder_ids) VALUES ('organization', 'org_0108', 'decision', 'Büroweit', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);" "project_memory_restricted_folders_check" "organization memory is never restricted"
apply_in grid_memory 0113_project_memory_restricted_folders.down.sql
check_in grid_memory "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0108'" "1" "down deleted the restricted note and kept the open one"
check_in grid_memory "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "0" "down dropped the column"
check_in grid_memory "SELECT indexdef LIKE '%coalesce%' FROM pg_indexes WHERE indexname = 'uniq_project_memory_project_content_active'" "f" "down restored develop's dedup index"
apply_in grid_memory 0113_project_memory_restricted_folders.sql
check_in grid_memory "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "1" "0112 re-applies"

echo "==> 0113 restricted memory and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0114: the download log, and its DOWN.
#
# The table is inside the tenant boundary, the database refuses an open outside
# an own list, a shelf that disagrees with its project and any UPDATE, and the
# down drops the table and its guard function; 0113 then re-applies. The
# platform role's delete and the retention sweep are proved against the real
# chain by download-log.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0114 download log, its constraints and its down migration on grid_download_log"
migrate_until grid_download_log 0114_document_access_log
check_in grid_download_log "SELECT relrowsecurity FROM pg_class WHERE relname = 'document_access_log'" "t" "the download log is inside the tenant boundary"
check_in grid_download_log "SELECT count(*) FROM pg_indexes WHERE tablename = 'document_access_log'" "5" "the primary key and the four indexes (time, person, document, purge)"
refused_in grid_download_log "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name, own_list) VALUES ('org_0109', 'u', 'preview', 'archiv', gen_random_uuid(), 'x', false);" "document_access_log_open_needs_own_list" "an open outside an own list is refused"
refused_in grid_download_log "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0109', 'u', 'download', 'project', gen_random_uuid(), 'x');" "document_access_log_scope_project" "a project shelf needs a project"
sql_in grid_download_log <<<"INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0109', 'u', 'download', 'archiv', gen_random_uuid(), 'Plan.pdf');"
refused_in grid_download_log "UPDATE document_access_log SET user_id = 'v';" "never changed" "a row is never changed, not even by its owner"
refused_in grid_download_log "DELETE FROM document_access_log;" "deleted only by the retention sweep" "only the platform role deletes"
apply_in grid_download_log 0114_document_access_log.down.sql
check_in grid_download_log "SELECT to_regclass('public.document_access_log') IS NULL" "t" "down dropped the download log"
check_in grid_download_log "SELECT to_regprocedure('grid_document_access_log_guard()') IS NULL" "t" "down dropped the guard function"
apply_in grid_download_log 0114_document_access_log.sql
check_in grid_download_log "SELECT count(*) FROM document_access_log" "0" "0113 re-applies, empty"

echo "==> 0114 download log and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0115: the Papierkorb, and its DOWN.
#
# Seeded before 0114 runs: a tombstone the old delete left behind is
# backfilled as PURGED (its contents had been moved out), a living folder is
# not; the trigger refuses a document filed into a deleted folder and a folder
# created under one, and lets an Archiv folder (no project, no bin lock) take a
# document; an Archiv folder cannot be deleted in place, since the Archiv has no
# Papierkorb; the hold predicate covers a folder through a document in it. The
# down refuses while a folder is in the bin, runs once the bin is empty
# (columns, triggers and functions gone, the 0093 predicate back, which does not
# know folders), and 0114 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0115 Papierkorb backfill, triggers and down migration on grid_bin"
migrate_until grid_bin 0114_document_access_log
sql_in grid_bin <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000110', 'org_0110', 'Papierkorb 0114', 'user_1', 'proj_0110');
INSERT INTO project_folders (id, organization_id, project_id, name, path, deleted_at, deleted_by) VALUES
  ('e1e1e1e1-e1e1-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Ablage 0114', 'Ablage 0114', '2026-10-01T08:00:00Z', 'user_1');
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Plaene 0114', 'Plaene 0114');
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('e3e3e3e3-e3e3-4000-8000-000000000110', 'org_0110', 'archiv', 'Normen 0114', 'Normen 0114');
SQL
apply_in grid_bin 0115_folder_bin.sql
check_in grid_bin "SELECT (purged_at = deleted_at)::text || ',' || coalesce(bin_root_id::text, 'none') FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110'" "true,none" "an older tombstone is backfilled as purged, with no bin entry"
check_in grid_bin "SELECT count(*) FROM project_folders WHERE id IN ('e2e2e2e2-e2e2-4000-8000-000000000110', 'e3e3e3e3-e3e3-4000-8000-000000000110') AND purged_at IS NULL AND deleted_at IS NULL" "2" "a living project folder and an Archiv folder are untouched"
refused_in grid_bin "INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES ('org_0110', 'user_1', 'spaet.pdf', 'k/spaet', 'proj_0110', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110');" "is deleted; nothing may be filed into it" "a document cannot be filed into a deleted folder"
refused_in grid_bin "INSERT INTO project_folders (organization_id, project_id, parent_id, name, path) VALUES ('org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110', 'Neu', 'Ablage 0114/Neu');" "is deleted; nothing may be filed into it" "a folder cannot be created under a deleted folder"
refused_in grid_bin "UPDATE project_folders SET purged_at = now() WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';" "project_folders_bin_state_check" "a living folder cannot be purged"
refused_in grid_bin "UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'e3e3e3e3-e3e3-4000-8000-000000000110';" "project_folders_bin_state_check" "an Archiv folder has no Papierkorb and no tombstone"
sql_in grid_bin <<<"INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, folder_id) VALUES ('org_0110', 'user_1', 'norm.pdf', 'k/norm', 'archiv_org_0110', 'completed', 'archiv', 'e3e3e3e3-e3e3-4000-8000-000000000110');"
check_in grid_bin "SELECT count(*) FROM documents WHERE folder_id = 'e3e3e3e3-e3e3-4000-8000-000000000110'" "1" "an Archiv folder takes a document: the trigger takes no bin lock for it"
sql_in grid_bin <<'SQL'
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES
  ('d1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'user_1', 'Plan.pdf', 'k/plan', 'proj_0110', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000110', 'e2e2e2e2-e2e2-4000-8000-000000000110');
INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by) VALUES
  ('document', 'd1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'rls test', 'user_1');
SQL
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text" "true" "a hold on a document in a folder covers the folder"
sql_in grid_bin <<<"UPDATE legal_holds SET released_at = now() WHERE organization_id = 'org_0110';"
sql_in grid_bin <<<"UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1', bin_root_id = id WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';"
refused_in grid_bin "$(cat drizzle/0115_folder_bin.down.sql)" "the Papierkorb is not empty" "the down refuses while a folder is in the bin"
check_in grid_bin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('bin_root_id', 'purged_at')" "2" "the refused down changed nothing"
sql_in grid_bin <<<"UPDATE project_folders SET deleted_at = NULL, deleted_by = NULL, bin_root_id = NULL WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';"
apply_in grid_bin 0115_folder_bin.down.sql
check_in grid_bin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('bin_root_id', 'purged_at')" "0" "down dropped the bin columns"
check_in grid_bin "SELECT count(*) FROM pg_trigger WHERE tgname IN ('documents_deleted_folder_guard', 'project_folders_deleted_parent_guard')" "0" "down dropped the triggers"
check_in grid_bin "SELECT count(*) FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110' AND deleted_at IS NOT NULL" "1" "the tombstone stays a tombstone"
sql_in grid_bin <<<"INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by) VALUES ('document', 'd1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'rls test 2', 'user_1');"
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text" "false" "the 0093 predicate is back: it does not know folders"
apply_in grid_bin 0115_folder_bin.sql
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text || ',' || (SELECT (purged_at IS NOT NULL)::text FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110')" "true,true" "0114 re-applies"

echo "==> 0115 backfill, triggers and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0118: a restricted note records the memory judge's verdict
# (ADR-0087), and its DOWN. Only a restricted note carries one, and only a
# verdict the judge gives; the down drops the column and its CHECK, and 0117
# re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0118 restriction judge column, its CHECK and the down migration on grid_judge"
migrate_until grid_judge 0118_project_memory_restriction_judge
check_in grid_judge "SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "1" "the verdict is checked"
check_in grid_judge "SELECT pg_get_constraintdef(oid) LIKE '%restricted_folder_ids IS NOT NULL%' FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "t" "only a restricted note carries a verdict"
apply_in grid_judge 0118_project_memory_restriction_judge.down.sql
check_in grid_judge "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restriction_judge'" "0" "down dropped the column"
apply_in grid_judge 0118_project_memory_restriction_judge.sql
check_in grid_judge "SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "1" "0117 re-applies"

echo "==> 0118 restriction judge and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0119: the content gate's quarantine decisions, owed to the audit
# trail (ADR-0086), and its DOWN. The repository's claims (one decision per
# dispatch, owed until marked once, outliving the document, deleted once spent
# by the platform role alone) are proved through
# the runtime role by upload-batches.integration.spec.ts above; here, what the
# database itself refuses, and that the down and a re-apply run clean.
# ---------------------------------------------------------------------------
echo "==> verifying the 0119 quarantine decisions, their guard and the down migration on grid_quarantine"
migrate_until grid_quarantine 0119_document_quarantine_decisions
check_in grid_quarantine "SELECT relrowsecurity FROM pg_class WHERE relname = 'document_quarantine_decisions'" "t" "the decisions are inside the tenant boundary"
check_in grid_quarantine "SELECT count(*) FROM pg_indexes WHERE tablename = 'document_quarantine_decisions'" "3" "the primary key, the dispatch key and the partial index of what is owed"
sql_in grid_quarantine <<<"INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('f1f1f1f1-f1f1-4000-8000-000000000117', 'org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');" "document_quarantine_decisions_dispatch_key" "one dispatch is one decision"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', gen_random_uuid(), 'job-1', 'project', 'x', 'u');" "document_quarantine_decisions_scope_project" "a project shelf needs a project"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET reasons = 'iban' WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is never rewritten"
sql_in grid_quarantine <<<"UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is marked audited once"
refused_in grid_quarantine "DELETE FROM document_quarantine_decisions;" "deleted only by the platform role" "only the platform role deletes"
apply_in grid_quarantine 0119_document_quarantine_decisions.down.sql
check_in grid_quarantine "SELECT to_regclass('public.document_quarantine_decisions') IS NULL" "t" "down dropped the decisions"
check_in grid_quarantine "SELECT to_regprocedure('grid_document_quarantine_decisions_guard()') IS NULL" "t" "down dropped the guard function"
apply_in grid_quarantine 0119_document_quarantine_decisions.sql
check_in grid_quarantine "SELECT count(*) FROM document_quarantine_decisions" "0" "0118 re-applies, empty"

echo "==> 0119 quarantine decisions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0120: what the lessons pipeline took from a restricted
# conversation before OUTSIDE_RESTRICTED_USE, withdrawn, and its DOWN.
#
# On a database of its own (grid_lessons), migrated through 0118 and seeded
# as a sweep before the rule left it:
# an ACTIVE lesson created from a vote on a conversation with a
# conversation_restricted_folders row, a lesson created from an open vote with
# a restricted one LINKED to it, a restricted vote skipped with a summary, and
# a lesson created from a restricted vote that was already retired. Every
# restricted report loses its summary, the open one keeps it; the restricted
# lessons lose their text, and only the live one is retired, with one event;
# the open lesson stays active. The down changes nothing, and 0119 re-applies
# without a second event.
# ---------------------------------------------------------------------------
echo "==> verifying the 0120 lesson withdrawal and its down migration on grid_lessons"
migrate_until grid_lessons 0119_document_quarantine_decisions
sql_in grid_lessons <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id) VALUES
  ('org_0107', 's_0118_restricted', 'a1a1a1a1-a1a1-4000-8000-000000000107');
INSERT INTO answer_feedback (id, organization_id, conversation_id, message_id, user_id, verdict, reason, comment) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000118', 'org_0107', 's_0118_restricted', 'm_0118_1', 'user_1', 'down', 'inaccurate', 'Honorar Zimmerer falsch'),
  ('f2f2f2f2-0000-4000-8000-000000000118', 'org_0107', 's_0118_restricted', 'm_0118_2', 'user_1', 'down', 'inaccurate', 'Honorar Dachdecker falsch'),
  ('f3f3f3f3-0000-4000-8000-000000000118', 'org_0107', 's_0118_restricted', 'm_0118_3', 'user_1', 'down', 'other', 'Gehalt falsch'),
  ('f4f4f4f4-0000-4000-8000-000000000118', 'org_0107', 's_0118_open', 'm_0118_4', 'user_1', 'down', 'inaccurate', 'Brüstung falsch'),
  ('f5f5f5f5-0000-4000-8000-000000000118', 'org_0107', 's_0118_restricted', 'm_0118_5', 'user_1', 'down', 'inaccurate', 'Angebot falsch');
INSERT INTO platform_lessons (id, content, category, status, activated_at, activated_by, retired_at, retired_by, retired_reason) VALUES
  ('11111111-0000-4000-8000-000000000118', 'Honorare aus Angeboten nur mit Quelle nennen 0119', 'inaccurate', 'active', now(), 'system:distiller', NULL, NULL, NULL),
  ('22222222-0000-4000-8000-000000000118', 'Brüstungshöhen nach OIB-RL 4 prüfen 0119', 'inaccurate', 'active', now(), 'system:distiller', NULL, NULL, NULL),
  ('33333333-0000-4000-8000-000000000118', 'Angebotssummen nicht runden 0119', 'inaccurate', 'retired', now(), 'system:distiller', now(), 'system:distiller', 'evicted_capacity');
INSERT INTO platform_lesson_reports (feedback_id, lesson_id, outcome, skip_reason, org_hash, canonical_summary) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000118', '11111111-0000-4000-8000-000000000118', 'created', NULL, 'hash_0118', 'Zimmerer-Honorar 48.000 EUR falsch genannt'),
  ('f2f2f2f2-0000-4000-8000-000000000118', '22222222-0000-4000-8000-000000000118', 'linked', NULL, 'hash_0118', 'Dachdecker-Honorar falsch genannt'),
  ('f3f3f3f3-0000-4000-8000-000000000118', NULL, 'skipped', 'not_generalizable', 'hash_0118', 'Gehalt der Bauleiterin falsch'),
  ('f4f4f4f4-0000-4000-8000-000000000118', '22222222-0000-4000-8000-000000000118', 'created', NULL, 'hash_0118', 'Brüstungshöhe falsch genannt'),
  ('f5f5f5f5-0000-4000-8000-000000000118', '33333333-0000-4000-8000-000000000118', 'created', NULL, 'hash_0118', 'Angebotssumme gerundet');
SQL
apply_in grid_lessons 0120_withdraw_restricted_lesson_reports.sql
check_in grid_lessons "SELECT string_agg(feedback_id::text, ',' ORDER BY feedback_id) FROM platform_lesson_reports WHERE org_hash = 'hash_0118' AND canonical_summary IS NOT NULL" "f4f4f4f4-0000-4000-8000-000000000118" "only the open report keeps its summary, whatever the outcome"
check_in grid_lessons "SELECT status || ',' || retired_reason || ',' || retired_by || ',' || (content LIKE 'Zurückgezogen:%')::text FROM platform_lessons WHERE id = '11111111-0000-4000-8000-000000000118'" "retired,restricted_source,system:migration-0120,true" "a live lesson created from a restricted report is retired, its text replaced"
check_in grid_lessons "SELECT status || ',' || content FROM platform_lessons WHERE id = '22222222-0000-4000-8000-000000000118'" "active,Brüstungshöhen nach OIB-RL 4 prüfen 0119" "a lesson only LINKED to a restricted report stays as it was"
check_in grid_lessons "SELECT status || ',' || retired_reason || ',' || (content LIKE 'Zurückgezogen:%')::text FROM platform_lessons WHERE id = '33333333-0000-4000-8000-000000000118'" "retired,evicted_capacity,true" "an already retired one loses its text and keeps its retirement"
check_in grid_lessons "SELECT string_agg(lesson_id::text || ':' || action || ':' || (detail->>'reason'), ',') FROM platform_lesson_events WHERE actor = 'system:migration-0120'" "11111111-0000-4000-8000-000000000118:retired:restricted_source" "one retirement event, for the lesson that was live"
apply_in grid_lessons 0120_withdraw_restricted_lesson_reports.down.sql
check_in grid_lessons "SELECT status FROM platform_lessons WHERE id = '11111111-0000-4000-8000-000000000118'" "retired" "the down changes nothing"
apply_in grid_lessons 0120_withdraw_restricted_lesson_reports.sql
check_in grid_lessons "SELECT count(*) FROM platform_lesson_events WHERE actor = 'system:migration-0120'" "1" "0120 re-applies without a second event"

echo "==> 0120 lesson withdrawal and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0121: a vote keeps its conversation's restricted use after the
# record goes, and its DOWN.
#
# On grid_lessons, after 0119: the backfill marks the votes on the 0119
# restricted conversation (it has a record) and not the open one; a vote cast
# after 0120 on a conversation whose record is then deleted is marked by the
# trigger, and a vote on another conversation is not. The down drops the
# column, the trigger and the function; 0120 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0121 feedback marker, its trigger and its down migration on grid_lessons"
apply_in grid_lessons 0121_answer_feedback_restricted_source.sql
check_in grid_lessons "SELECT string_agg(conversation_id || ':' || restricted_source::text, ',' ORDER BY conversation_id) FROM (SELECT DISTINCT conversation_id, restricted_source FROM answer_feedback WHERE message_id LIKE 'm_0118_%') v" "s_0118_open:false,s_0118_restricted:true" "the backfill marks the votes on a recorded conversation only"
sql_in grid_lessons <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id) VALUES
  ('org_0107', 's_0119_deleted', 'a1a1a1a1-a1a1-4000-8000-000000000107');
INSERT INTO answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason, comment) VALUES
  ('org_0107', 's_0119_deleted', 'm_0119_1', 'user_1', 'down', 'inaccurate', 'Honorar Spengler falsch'),
  ('org_0107', 's_0119_other', 'm_0119_2', 'user_1', 'down', 'inaccurate', 'Brüstung falsch');
SQL
check_in grid_lessons "SELECT string_agg(restricted_source::text, ',' ORDER BY message_id) FROM answer_feedback WHERE message_id LIKE 'm_0119_%'" "false,false" "a new vote starts unmarked; the record holds it back while it exists"
sql_in grid_lessons <<<"DELETE FROM conversation_restricted_folders WHERE conversation_id = 's_0119_deleted';"
check_in grid_lessons "SELECT string_agg(conversation_id || ':' || restricted_source::text, ',' ORDER BY message_id) FROM answer_feedback WHERE message_id LIKE 'm_0119_%'" "s_0119_deleted:true,s_0119_other:false" "deleting the record marks the votes on that conversation, and only those"
apply_in grid_lessons 0121_answer_feedback_restricted_source.down.sql
check_in grid_lessons "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'answer_feedback' AND column_name = 'restricted_source') + (SELECT count(*) FROM pg_trigger WHERE tgname = 'conversation_restricted_folders_mark_feedback') + (SELECT count(*) FROM pg_proc WHERE proname = 'grid_feedback_keeps_restricted_source')" "0" "down dropped the column, the trigger and the function"
apply_in grid_lessons 0121_answer_feedback_restricted_source.sql
check_in grid_lessons "SELECT count(*) FILTER (WHERE restricted_source) FROM answer_feedback WHERE message_id LIKE 'm_0118_%' OR message_id LIKE 'm_0119_%'" "4" "0120 re-applies; the marker set by a delete before the down is gone with its column"

echo "==> 0121 feedback marker, trigger and down migration verified"

# ---------------------------------------------------------------------------
# Migrations 0122 and 0123: the one exit from quarantine, and a verdict bound
# to the bytes it judged (ADR-0086, amended 2026-10-08), and their DOWNs.
#
# On a database of its own, migrated to 0120 and seeded with a screened upload,
# a Piloti document and a quarantined upload. 0121: a quarantined row refuses
# every UPDATE out of quarantine but a release of the bytes it holds; its down
# lets one through. 0122: the backfill binds each person's verdict to the
# bytes the row holds now, Piloti's own documents get none; its down drops the
# column and 0122 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0122 quarantine exit, the 0123 screened hash and their down migrations on grid_hold"
migrate_until grid_hold 0121_answer_feedback_restricted_source
sql_in grid_hold <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000120', 'org_0120', 'Hold 0120', 'user_1', 'proj_0120');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash, screening_outcome) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000120', 'org_0120', 'user_1', 'plan.pdf', 'k/0120/plan', 'proj_0120', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000120', 'sha256:plan', 'clean'),
  ('d3d3d3d3-0000-4000-8000-000000000120', 'org_0120', 'user_1', 'lohn.pdf', 'k/0120/lohn', 'proj_0120', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000120', 'sha256:lohn', 'quarantined');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash,
                       authored_by, authored_by_producer, authored_by_ref, authored_by_ref_kind) VALUES
  ('d2d2d2d2-0000-4000-8000-000000000120', 'org_0120', 'user_1', 'piloti/d2/bericht.md', 'k/0120/bericht', 'proj_0120', 'stored', 'project', 'aaaaaaaa-0000-4000-8000-000000000120', 'sha256:bericht',
   'agent', 'deep_research', 'run-0120', 'backend_job');
SQL
apply_in grid_hold 0122_document_quarantine_exit.sql
refused_in grid_hold "UPDATE documents SET status = 'pending' WHERE id = 'd3d3d3d3-0000-4000-8000-000000000120';" "only a release takes it out of quarantine" "a re-dispatch cannot move a quarantined row"
refused_in grid_hold "UPDATE documents SET status = 'uploaded', screening_outcome = 'released', screening_released_hash = 'sha256:other', screening_released_by = 'user_2', screening_released_at = now() WHERE id = 'd3d3d3d3-0000-4000-8000-000000000120';" "only a release takes it out of quarantine" "a release of other bytes is refused"
sql_in grid_hold <<<"UPDATE documents SET error_message = 'noted' WHERE id = 'd3d3d3d3-0000-4000-8000-000000000120';"
check_in grid_hold "SELECT status FROM documents WHERE id = 'd3d3d3d3-0000-4000-8000-000000000120'" "quarantined" "a write that keeps it quarantined is not refused"
apply_in grid_hold 0122_document_quarantine_exit.down.sql
check_in grid_hold "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'documents_hold_quarantine') + (SELECT count(*) FROM pg_proc WHERE proname = 'grid_documents_hold_quarantine')" "0" "down dropped the trigger and its function"
apply_in grid_hold 0122_document_quarantine_exit.sql
refused_in grid_hold "UPDATE documents SET status = 'pending' WHERE id = 'd3d3d3d3-0000-4000-8000-000000000120';" "only a release takes it out of quarantine" "0121 re-applies"

apply_in grid_hold 0123_document_screened_hash.sql
check_in grid_hold "SELECT string_agg(filename || '=' || coalesce(screened_hash, '-'), ',' ORDER BY filename) FROM documents WHERE organization_id = 'org_0120'" "lohn.pdf=sha256:lohn,piloti/d2/bericht.md=-,plan.pdf=sha256:plan" "the backfill binds each person's verdict to the bytes the row holds, and no Piloti document"
apply_in grid_hold 0123_document_screened_hash.down.sql
check_in grid_hold "SELECT count(*) FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'screened_hash'" "0" "down dropped the column"
apply_in grid_hold 0123_document_screened_hash.sql
apply_in grid_hold 0123_document_screened_hash.sql
check_in grid_hold "SELECT count(*) FROM documents WHERE organization_id = 'org_0120' AND screened_hash = content_hash" "2" "0122 re-applies, twice, to the same binding"

echo "==> 0122 quarantine exit, 0123 screened hash and their down migrations verified"

# ---------------------------------------------------------------------------
# Migration 0124: the server marks the message, the votes and lessons from
# before are withdrawn by that mark, and its DOWN.
#
# On grid_lessons, after 0120 (and 0121, 0122, which touch nothing here),
# seeded with a recorded conversation whose answer was voted on with ANOTHER
# conversation's id, a lesson created from that vote with an owner's edit
# keeping the old text in `previousContent`, the same kind of edit on the
# lesson 0119 withdrew, and an open conversation with its own lesson and edit,
# a vote naming the recorded conversation whose message id names no row, and
# vectors on every lesson. The backfill marks every message of the recorded
# conversation, the fabricated id, and the messages 0120 had marked by vote;
# the lesson from the marked answer is retired with its text replaced and one
# event; every withdrawn lesson loses its vector and its events lose
# `previousContent`, the open one keeps both. The trigger marks a message
# written into the recorded conversation and not one written into the open
# one, and the mark outlives the conversation. A first admission marks the
# messages its conversation already holds and the votes naming it; a vote
# naming a recorded conversation marks its id. The runtime role may not delete
# or change a mark. A revision thread is not restricted while its document
# sits at the project's root; moving the document into a folder of a project
# with an access list marks the thread's messages and votes, and the marks
# keep the thread answering yes after the document moves back and after the
# thread is deleted. The down brings 0120's column back from the marks and
# drops the rule's functions, triggers and index; 0123 re-applies, twice,
# without a second event, and the column it reads back names no conversation.
# ---------------------------------------------------------------------------
echo "==> verifying the 0124 message mark, its withdrawal and its down migration on grid_lessons"
apply_in grid_lessons 0122_document_quarantine_exit.sql
apply_in grid_lessons 0123_document_screened_hash.sql
sql_in grid_lessons <<'SQL'
INSERT INTO conversations (id, organization_id, created_by) VALUES
  ('s_0122_restricted', 'org_0107', 'user_1'),
  ('s_0122_open', 'org_0107', 'user_1');
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id) VALUES
  ('org_0107', 's_0122_restricted', 'a1a1a1a1-a1a1-4000-8000-000000000107');
INSERT INTO messages (id, conversation_id, organization_id, role, content) VALUES
  ('c1c1c1c1-0000-4000-8000-000000000122', 's_0122_restricted', 'org_0107', 'user', 'Was kostet der Zimmerer?'),
  ('c2c2c2c2-0000-4000-8000-000000000122', 's_0122_restricted', 'org_0107', 'assistant', 'Laut Angebot 48.000 EUR.'),
  ('c3c3c3c3-0000-4000-8000-000000000122', 's_0122_open', 'org_0107', 'assistant', 'Die Brüstung ist 1,00 m hoch.');
INSERT INTO answer_feedback (id, organization_id, conversation_id, message_id, user_id, verdict, reason, comment) VALUES
  ('f6f6f6f6-0000-4000-8000-000000000122', 'org_0107', 's_0122_open', 'c2c2c2c2-0000-4000-8000-000000000122', 'user_1', 'down', 'inaccurate', 'Zimmerer falsch'),
  ('f7f7f7f7-0000-4000-8000-000000000122', 'org_0107', 's_0122_open', 'c3c3c3c3-0000-4000-8000-000000000122', 'user_1', 'down', 'inaccurate', 'Brüstung falsch'),
  ('f8f8f8f8-0000-4000-8000-000000000122', 'org_0107', 's_0122_restricted', 'd8d8d8d8-0000-4000-8000-000000000122', 'user_1', 'down', 'inaccurate', 'Erwartet Spengler 31.000 EUR');
INSERT INTO platform_lessons (id, content, category, status, activated_at, activated_by, embedding, embedding_model, embedded_at) VALUES
  ('44444444-0000-4000-8000-000000000122', 'Honorare nur mit Angebotsdatum nennen 0123', 'inaccurate', 'active', now(), 'system:distiller', '{0.1,0.2}', 'model_0122', now()),
  ('55555555-0000-4000-8000-000000000122', 'Brüstungshöhen mit Quelle nennen 0123', 'inaccurate', 'active', now(), 'system:distiller', '{0.3,0.4}', 'model_0122', now());
UPDATE platform_lessons SET embedding = '{0.5,0.6}', embedding_model = 'model_0122', embedded_at = now()
WHERE id = '11111111-0000-4000-8000-000000000118';
INSERT INTO platform_lesson_reports (feedback_id, lesson_id, outcome, org_hash, canonical_summary) VALUES
  ('f6f6f6f6-0000-4000-8000-000000000122', '44444444-0000-4000-8000-000000000122', 'created', 'hash_0122', 'Zimmerer-Honorar falsch genannt'),
  ('f7f7f7f7-0000-4000-8000-000000000122', '55555555-0000-4000-8000-000000000122', 'created', 'hash_0122', 'Brüstungshöhe falsch genannt');
INSERT INTO platform_lesson_events (lesson_id, action, actor, detail) VALUES
  ('44444444-0000-4000-8000-000000000122', 'edited', 'user_owner', '{"previousContent": "Zimmerer 48.000 EUR nennen"}'),
  ('11111111-0000-4000-8000-000000000118', 'edited', 'user_owner', '{"previousContent": "Zimmerer-Honorar 48.000 EUR"}'),
  ('55555555-0000-4000-8000-000000000122', 'edited', 'user_owner', '{"previousContent": "Brüstung 1,00 m"}');
SQL
apply_in grid_lessons 0124_message_restricted_use.sql
check_in grid_lessons "SELECT string_agg(message_id, ',' ORDER BY message_id) FROM message_restricted_use WHERE conversation_id LIKE 's_0122_%'" "c1c1c1c1-0000-4000-8000-000000000122,c2c2c2c2-0000-4000-8000-000000000122,d8d8d8d8-0000-4000-8000-000000000122" "the backfill marks every message of a recorded conversation and the id of a vote naming it, and none of an open one"
check_in grid_lessons "SELECT string_agg(id::text || '=' || (embedding IS NULL)::text || '/' || coalesce(embedding_model, '-') || '/' || (embedded_at IS NULL)::text, ',' ORDER BY id) FROM platform_lessons WHERE id IN ('11111111-0000-4000-8000-000000000118', '44444444-0000-4000-8000-000000000122', '55555555-0000-4000-8000-000000000122')" "11111111-0000-4000-8000-000000000118=true/-/true,44444444-0000-4000-8000-000000000122=true/-/true,55555555-0000-4000-8000-000000000122=false/model_0122/false" "every withdrawn lesson, 0119's included, loses the vector of its old text; the open one keeps it"
check_in grid_lessons "SELECT string_agg(message_id, ',' ORDER BY message_id) FROM message_restricted_use WHERE message_id LIKE 'm_01%'" "m_0118_1,m_0118_2,m_0118_3,m_0118_5" "every vote 0120 marked marks its message"
check_in grid_lessons "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'answer_feedback' AND column_name = 'restricted_source') + (SELECT count(*) FROM pg_trigger WHERE tgname = 'conversation_restricted_folders_mark_feedback') + (SELECT count(*) FROM pg_proc WHERE proname = 'grid_feedback_keeps_restricted_source')" "0" "0120's column, trigger and function are folded into marks and gone"
check_in grid_lessons "SELECT status || ',' || retired_reason || ',' || retired_by || ',' || (content LIKE 'Zurückgezogen:%')::text FROM platform_lessons WHERE id = '44444444-0000-4000-8000-000000000122'" "retired,restricted_source,system:migration-0124,true" "a lesson created from a vote on a marked answer is retired, its text replaced, whatever conversation the vote named"
check_in grid_lessons "SELECT status || ',' || content FROM platform_lessons WHERE id = '55555555-0000-4000-8000-000000000122'" "active,Brüstungshöhen mit Quelle nennen 0123" "the open lesson stays as it was"
check_in grid_lessons "SELECT string_agg(feedback_id::text || '=' || coalesce(canonical_summary, '-'), ',' ORDER BY feedback_id) FROM platform_lesson_reports WHERE org_hash = 'hash_0122'" "f6f6f6f6-0000-4000-8000-000000000122=-,f7f7f7f7-0000-4000-8000-000000000122=Brüstungshöhe falsch genannt" "the marked report loses its summary, the open one keeps it"
check_in grid_lessons "SELECT string_agg(lesson_id::text || '=' || coalesce(detail->>'previousContent', '-') || '/' || coalesce(detail->>'previousContentWithdrawn', '-'), ',' ORDER BY lesson_id) FROM platform_lesson_events WHERE action = 'edited'" "11111111-0000-4000-8000-000000000118=-/true,44444444-0000-4000-8000-000000000122=-/true,55555555-0000-4000-8000-000000000122=Brüstung 1,00 m/-" "every withdrawn lesson's edits lose previousContent, 0119's included; the open one keeps it"
check_in grid_lessons "SELECT count(*) FROM platform_lesson_events WHERE actor = 'system:migration-0124'" "1" "one retirement event, for the lesson that was live"
sql_in grid_lessons <<'SQL'
INSERT INTO messages (id, conversation_id, organization_id, role, content) VALUES
  ('c4c4c4c4-0000-4000-8000-000000000122', 's_0122_restricted', 'org_0107', 'assistant', 'Und der Dachdecker 31.000 EUR.'),
  ('c5c5c5c5-0000-4000-8000-000000000122', 's_0122_open', 'org_0107', 'assistant', 'Die Treppe hat 18 Stufen.');
DELETE FROM conversations WHERE id = 's_0122_restricted';
SQL
check_in grid_lessons "SELECT string_agg(message_id, ',' ORDER BY message_id) FROM message_restricted_use WHERE conversation_id LIKE 's_0122_%'" "c1c1c1c1-0000-4000-8000-000000000122,c2c2c2c2-0000-4000-8000-000000000122,c4c4c4c4-0000-4000-8000-000000000122,d8d8d8d8-0000-4000-8000-000000000122" "the trigger marks a message written into a recorded conversation only, and the marks outlive it"
sql_in grid_lessons <<'SQL'
INSERT INTO conversations (id, organization_id, created_by) VALUES ('s_0122_late', 'org_0107', 'user_1');
INSERT INTO messages (id, conversation_id, organization_id, role, content) VALUES
  ('e1e1e1e1-0000-4000-8000-000000000122', 's_0122_late', 'org_0107', 'assistant', 'Die Fluchtweglänge beträgt 40 m.');
INSERT INTO answer_feedback (id, organization_id, conversation_id, message_id, user_id, verdict) VALUES
  ('fafafafa-0000-4000-8000-000000000122', 'org_0107', 's_0122_late', 'e2e2e2e2-0000-4000-8000-000000000122', 'user_1', 'down');
SQL
check_in grid_lessons "SELECT count(*) FROM message_restricted_use WHERE conversation_id = 's_0122_late'" "0" "nothing in a conversation before its first admission is marked"
sql_in grid_lessons <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id) VALUES
  ('org_0107', 's_0122_late', 'a1a1a1a1-a1a1-4000-8000-000000000107');
INSERT INTO answer_feedback (id, organization_id, conversation_id, message_id, user_id, verdict, comment) VALUES
  ('fbfbfbfb-0000-4000-8000-000000000122', 'org_0107', 's_0122_open', 'e1e1e1e1-0000-4000-8000-000000000122', 'user_2', 'down', 'Falsch, laut Angebot 48.000 EUR'),
  ('fcfcfcfc-0000-4000-8000-000000000122', 'org_0107', 's_0122_late', 'e3e3e3e3-0000-4000-8000-000000000122', 'user_1', 'down', 'Erwartet Spengler 31.000 EUR');
SQL
check_in grid_lessons "SELECT string_agg(message_id, ',' ORDER BY message_id) FROM message_restricted_use WHERE conversation_id = 's_0122_late'" "e1e1e1e1-0000-4000-8000-000000000122,e2e2e2e2-0000-4000-8000-000000000122,e3e3e3e3-0000-4000-8000-000000000122" "a first admission marks the messages and the votes already there, and a vote naming the conversation, or on its message, marks its id"
check_in grid_lessons "SELECT count(*) FROM message_restricted_use WHERE conversation_id = 's_0122_open'" "0" "a vote naming an open conversation on a recorded one's message does not make the open one read as restricted"
check_in grid_lessons "SELECT has_table_privilege('grid_app_rw', 'message_restricted_use', 'INSERT')::text || ',' || has_table_privilege('grid_app_rw', 'message_restricted_use', 'UPDATE')::text || ',' || has_table_privilege('grid_app_rw', 'message_restricted_use', 'DELETE')::text" "true,false,false" "the runtime role may add a mark and may neither change nor delete one"
sql_in grid_lessons <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('b0b0b0b0-0000-4000-8000-000000000123', 'org_0107', 'Revision', 'user_1', 'proj_rev_0123');
WITH folder AS (
  INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
  VALUES ('b1b1b1b1-0000-4000-8000-000000000123', 'org_0107', 'b0b0b0b0-0000-4000-8000-000000000123', 'Honorare', 'Honorare', 'custom', 'user_1', now())
  RETURNING id, project_id
), grants AS (
  INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
  SELECT 'org_0107', project_id, id, 'org-buchhaltung', 'read' FROM folder
)
SELECT 1 FROM folder;
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES
  ('b2b2b2b2-0000-4000-8000-000000000123', 'org_0107', 'user_1', 'angebot.md', 'k/rev/0123', 'proj_rev_0123', 'completed', 'project', 'b0b0b0b0-0000-4000-8000-000000000123', NULL);
INSERT INTO conversations (id, organization_id, created_by) VALUES ('s_0123_thread', 'org_0107', 'user_1');
INSERT INTO task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot, conversation_id) VALUES
  ('org_0107', 'b0b0b0b0-0000-4000-8000-000000000123', 'revision', 'Überarbeitung',
   '{"prompt": "x", "skill": {}, "dataSources": null, "subject": {"documentId": "b2b2b2b2-0000-4000-8000-000000000123", "versionId": "b2b2b2b2-0000-4000-8000-000000000123"}}',
   'user_1', 'delegated', 'succeeded', '{}', 's_0123_thread');
INSERT INTO messages (id, conversation_id, organization_id, role, content) VALUES
  ('b3b3b3b3-0000-4000-8000-000000000123', 's_0123_thread', 'org_0107', 'assistant', 'Entwurf: Zimmerer 48.000 EUR');
INSERT INTO answer_feedback (id, organization_id, conversation_id, message_id, user_id, verdict, comment) VALUES
  ('b4b4b4b4-0000-4000-8000-000000000123', 'org_0107', NULL, 'b3b3b3b3-0000-4000-8000-000000000123', 'user_1', 'down', 'Zimmerer falsch');
SQL
check_in grid_lessons "SELECT grid_feedback_restricted_use('org_0107', 'b3b3b3b3-0000-4000-8000-000000000123', NULL)::text || ',' || (SELECT count(*) FROM message_restricted_use WHERE conversation_id = 's_0123_thread')" "false,0" "a revision thread whose document sits at the project's root is not restricted, and nothing is marked"
sql_in grid_lessons <<'SQL'
UPDATE documents SET folder_id = 'b1b1b1b1-0000-4000-8000-000000000123' WHERE id = 'b2b2b2b2-0000-4000-8000-000000000123';
SQL
check_in grid_lessons "SELECT string_agg(message_id, ',') FROM message_restricted_use WHERE conversation_id = 's_0123_thread'" "b3b3b3b3-0000-4000-8000-000000000123" "moving the document into a folder of a project with an access list marks the thread's messages and votes"
sql_in grid_lessons <<'SQL'
UPDATE documents SET folder_id = NULL WHERE id = 'b2b2b2b2-0000-4000-8000-000000000123';
SQL
check_in grid_lessons "SELECT grid_conversation_restricted_use('org_0107', 's_0123_thread')::text" "true" "the marks keep the thread restricted after the document moves back"
sql_in grid_lessons <<'SQL'
DELETE FROM conversations WHERE id = 's_0123_thread';
SQL
check_in grid_lessons "SELECT grid_feedback_restricted_use('org_0107', 'b3b3b3b3-0000-4000-8000-000000000123', NULL)::text || ',' || grid_conversation_restricted_use('org_0107', 's_0123_thread')::text || ',' || (SELECT count(*) FROM task_runs WHERE conversation_id = 's_0123_thread')" "true,true,0" "the vote stays out after the thread is deleted, though its task no longer names it"
apply_in grid_lessons 0124_message_restricted_use.down.sql
check_in grid_lessons "SELECT to_regclass('public.message_restricted_use') IS NULL" "t" "down dropped the marks"
check_in grid_lessons "SELECT string_agg(message_id || ':' || restricted_source::text, ',' ORDER BY message_id) FROM answer_feedback WHERE id IN ('f6f6f6f6-0000-4000-8000-000000000122', 'f7f7f7f7-0000-4000-8000-000000000122')" "c2c2c2c2-0000-4000-8000-000000000122:true,c3c3c3c3-0000-4000-8000-000000000122:false" "down brings 0120's column back from the marks"
check_in grid_lessons "SELECT count(*) FROM pg_trigger WHERE tgname = 'conversation_restricted_folders_mark_feedback'" "1" "down restores 0120's trigger"
check_in grid_lessons "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('grid_uuid_or_null', 'grid_conversation_restricted_use', 'grid_feedback_restricted_use', 'grid_mark_conversation_restricted_use', 'grid_mark_conversation_messages', 'grid_mark_feedback_restricted_use', 'grid_mark_revision_thread', 'grid_mark_revision_thread_of_task', 'grid_mark_revision_threads_of_document', 'grid_mark_revision_threads_of_folder')) + (SELECT count(*) FROM pg_trigger WHERE tgname IN ('conversation_restricted_folders_mark_messages', 'answer_feedback_mark_restricted_use', 'task_runs_mark_revision_thread', 'documents_mark_revision_threads', 'project_folders_mark_revision_threads')) + (SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_task_runs_revision_conversation', 'idx_task_runs_revision_subject'))" "0" "down drops the rule's functions, triggers and indexes"
apply_in grid_lessons 0124_message_restricted_use.sql
apply_in grid_lessons 0124_message_restricted_use.sql
check_in grid_lessons "SELECT count(*) FROM platform_lesson_events WHERE actor = 'system:migration-0124'" "1" "0124 re-applies, twice, without a second event"
check_in grid_lessons "SELECT count(*) FROM message_restricted_use WHERE message_id IN ('c2c2c2c2-0000-4000-8000-000000000122', 'm_0118_1')" "2" "the re-applied backfill marks again from the restored column"
check_in grid_lessons "SELECT conversation_id = '' FROM message_restricted_use WHERE message_id = 'c2c2c2c2-0000-4000-8000-000000000122'" "t" "a mark read back from the restored column names no conversation: the column names the chat a vote claimed"
check_in grid_lessons "SELECT (SELECT count(*) FROM message_restricted_use WHERE message_id = 'c3c3c3c3-0000-4000-8000-000000000122')::text || ',' || (SELECT status FROM platform_lessons WHERE id = '55555555-0000-4000-8000-000000000122')" "0,active" "so the open chat a vote claimed does not read as restricted, and its answer and lesson stay as they were"

echo "==> 0124 message mark, withdrawal and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0125: the cross-project record, and its DOWN.
#
# On a database of its own, migrated to 0125: a conversation that drew on
# another project. The down must not make it shareable: it leaves a nil-folder
# row in conversation_restricted_folders, which the older build reads as a
# folder nobody may read. 0125 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0125 cross-project record and its down migration on grid_cross_project"
migrate_until grid_cross_project 0125_conversation_source_projects
sql_in grid_cross_project <<'SQL'
INSERT INTO conversation_source_projects (organization_id, conversation_id, project_id)
VALUES ('org_0125', 's_xp_0125', 'aaaaaaaa-0000-4000-8000-000000000125');
SQL
refused_in grid_cross_project "UPDATE conversation_source_projects SET last_at = first_at - interval '1 day' WHERE conversation_id = 's_xp_0125';" "conversation_source_projects_order" "a record cannot end before it began"
apply_in grid_cross_project 0125_conversation_source_projects.down.sql
check_in grid_cross_project "SELECT to_regclass('public.conversation_source_projects') IS NULL" "t" "down dropped the table"
check_in grid_cross_project "SELECT folder_id::text FROM conversation_restricted_folders WHERE conversation_id = 's_xp_0125'" "00000000-0000-0000-0000-000000000000" "down leaves the chat recorded on a folder nobody may read"
apply_in grid_cross_project 0125_conversation_source_projects.sql
check_in grid_cross_project "SELECT count(*) FROM conversation_source_projects" "0" "0125 re-applies, empty"
check_in grid_cross_project "SELECT relrowsecurity FROM pg_class WHERE relname = 'conversation_source_projects'" "t" "0125 re-applies under row-level security"

echo "==> 0125 cross-project record and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0126: permitting memory, and its DOWN.
#
# On grid_cross_project, after 0125: both tables come up under row-level
# security, the down drops them (they are derived, re-read from the
# documents), and 0126 re-applies empty.
# ---------------------------------------------------------------------------
echo "==> verifying the 0126 permit records and their down migration on grid_cross_project"
apply_in grid_cross_project 0126_permit_records.sql
check_in grid_cross_project "SELECT string_agg(relrowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('permit_records', 'permit_requirements')" "true,true" "0126 brings both tables up under row-level security"
apply_in grid_cross_project 0126_permit_records.down.sql
check_in grid_cross_project "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('permit_records', 'permit_requirements')" "0" "down dropped both tables"
apply_in grid_cross_project 0126_permit_records.sql
check_in grid_cross_project "SELECT count(*) FROM permit_records" "0" "0126 re-applies, empty"
echo "==> 0126 permit records and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0127: the evidence a drafted decision was read from (ADR-0096),
# and its DOWN.
#
# On grid_cross_project, after 0126: project_memory is already secured, so the
# column adds nothing to the boundary; what 0127 owns is its CHECK (an array
# when set). The down drops the column and its CHECK and keeps the note, and
# 0127 re-applies with the evidence gone (NULL), the lossy direction.
# ---------------------------------------------------------------------------
echo "==> verifying the 0127 memory evidence, its CHECK and the down migration on grid_cross_project"
apply_in grid_cross_project 0127_project_memory_evidence.sql
sql_in grid_cross_project <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000127', 'org_0127', 'Evidenz', 'user_1', 'proj_0127');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, provenance_type, verification, evidence)
VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000127', 'org_0127', 'decision', 'Fassade hinterlüftet 0127', 'distillation', 'source_grounded',
        '[{"fileName": "Baubeschreibung.pdf", "page": "4"}]');
SQL
refused_in grid_cross_project "UPDATE project_memory SET evidence = '{\"fileName\": \"a.pdf\"}' WHERE organization_id = 'org_0127';" "project_memory_evidence_check" "evidence is an array when it is set"
check_in grid_cross_project "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_memory'" "t" "the column sits on a table under row-level security"
apply_in grid_cross_project 0127_project_memory_evidence.down.sql
check_in grid_cross_project "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'evidence')::text || ',' || (SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_evidence_check')::text || ',' || (SELECT count(*) FROM project_memory WHERE organization_id = 'org_0127')::text" "0,0,1" "down drops the column and its CHECK, and keeps the note"
apply_in grid_cross_project 0127_project_memory_evidence.sql
check_in grid_cross_project "SELECT (evidence IS NULL)::text || ',' || (SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_evidence_check')::text FROM project_memory WHERE organization_id = 'org_0127'" "true,1" "0127 re-applies, the evidence gone"
echo "==> 0127 memory evidence and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0128: who holds a folder's own list moves to WorkOS (ADR-0097),
# and its DOWN.
#
# On a database of its own migrated through 0127, the spec plants folders with
# `*` and role grants and checks what 0128 carries over: `*`/read becomes
# `everyone_reads`, `*`/write goes back to inherit, a role-only list stays
# custom, the grant rows are kept for the conversion script, the 1–20 trigger
# is gone, a re-run is idempotent and the down round-trips.
# ---------------------------------------------------------------------------
echo "==> verifying the 0128 folder-role carry-over and its down migration on grid_folder_roles"
migrate_until grid_folder_roles 0127_project_memory_evidence
GRID_TEST_MIGRATION_0128_DATABASE_URL="postgres://grid_app_owner@127.0.0.1:$PORT/grid_folder_roles" \
  npx vitest run src/lib/projects/folder-access-in-workos.migration.spec.ts
echo "==> 0128 folder-role carry-over and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0102: project_folders become folders of a SHELF (project | archiv),
# and its DOWN migration.
#
# A database migrated only as far as 0101 and seeded with project folders and the
# documents filed in them, then handed 0102. Asserted here rather than in a spec
# because the backfill (`organization_id` from `projects`) can only be proved on
# rows that predate the column, and the spec suites run AFTER the whole chain.
# Connects as the owner, which is what runs a migration.
# ---------------------------------------------------------------------------
echo "==> verifying the 0102 folder backfill, its constraints and its down migration on grid_folders"
migrate_before grid_folders 0102_archiv_folders
MIGRATE_F="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_folders"

# Two tenants, a nested project folder in each, a document filed in the nested
# one, a root document and an Archiv document (which cannot be filed yet).
$MIGRATE_F -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'org_f_a', 'A', 'user_1', 'proj_f_a'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'org_f_b', 'B', 'user_1', 'proj_f_b');
INSERT INTO project_folders (id, project_id, parent_id, name, path) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', NULL, 'Plaene', 'Plaene'),
  ('f0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'EG', 'Plaene/EG'),
  ('f0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', NULL, 'Plaene', 'Plaene');
INSERT INTO documents (id, organization_id, project_id, scope, folder_id, filename, storage_key, collection_name, created_by, status) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'org_f_a', 'aaaaaaaa-0000-4000-8000-000000000001', 'project', 'f0000000-0000-4000-8000-000000000002', 'a.pdf', 'k/a', 'proj_f_a', 'user_1', 'uploaded'),
  ('d0000000-0000-4000-8000-000000000002', 'org_f_a', 'aaaaaaaa-0000-4000-8000-000000000001', 'project', NULL, 'root.pdf', 'k/root', 'proj_f_a', 'user_1', 'uploaded'),
  ('d0000000-0000-4000-8000-000000000003', 'org_f_a', NULL, 'archiv', NULL, 'arch.pdf', 'k/arch', 'archiv_org_f_a', 'user_1', 'uploaded');
SQL

$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.sql" >/dev/null || {
  echo "MIGRATION 0102 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

checkf() {
  local got
  got=$($MIGRATE_F -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0102 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

# Writes that must be REFUSED, each by the constraint named in the message.
refusedf() {
  local out
  if out=$($MIGRATE_F -v ON_ERROR_STOP=1 -q -c "$1" 2>&1); then
    echo "0102 ASSERTION FAILED: accepted — $3" >&2
    exit 1
  fi
  if ! grep -q "$2" <<<"$out"; then
    echo "0102 ASSERTION FAILED: refused, but not by $2 — $3" >&2
    echo "  $out" >&2
    exit 1
  fi
}

checkf "SELECT string_agg(organization_id || ':' || scope, ',' ORDER BY path, organization_id) FROM project_folders" \
  "org_f_a:project,org_f_b:project,org_f_a:project" "the backfill gave every folder its project's tenant and the project scope"
checkf "SELECT folder_id FROM documents WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "f0000000-0000-4000-8000-000000000002" "a document kept its folder across the migration"
checkf "SELECT count(*) FROM pg_constraint WHERE conname IN ('project_folders_scope_check','project_folders_scope_owner_check','project_folders_id_organization_id_scope_key','project_folders_parent_id_organization_id_scope_fkey','documents_folder_id_organization_id_scope_fkey')" \
  "5" "the new constraints exist"
checkf "SELECT qual FROM pg_policies WHERE tablename = 'project_folders' AND policyname = 'grid_tenant_isolation'" \
  "(organization_id = grid_current_org())" "the policy reads the tenant column, not a join through projects"

$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES ('ac000000-0000-4000-8000-000000000001', 'org_f_a', 'archiv', 'Normen', 'Normen')"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'archiv', 'Normen', 'Normen')" \
  "uniq_project_folders_parent_name" "a second root Archiv folder of the same name"
refusedf "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_f_b', 'archiv', 'ac000000-0000-4000-8000-000000000001', 'x', 'x')" \
  "project_folders_parent_id_organization_id_scope_fkey" "another tenant's folder as a parent"
refusedf "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_f_a', 'archiv', 'f0000000-0000-4000-8000-000000000001', 'x', 'x')" \
  "project_folders_parent_id_organization_id_scope_fkey" "a project folder as the parent of an Archiv folder"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'session', 'x', 'x')" \
  "project_folders_scope_check" "a folder on the session shelf"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'project', 'x', 'x')" \
  "project_folders_scope_owner_check" "a project folder with no project"
refusedf "UPDATE documents SET folder_id = 'f0000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000003'" \
  "documents_folder_id_organization_id_scope_fkey" "an Archiv document in a project folder"
refusedf "UPDATE documents SET folder_id = 'ac000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "documents_folder_id_project_id_fkey" "a project document in an Archiv folder"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "UPDATE documents SET folder_id = 'ac000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000003'"

# The down migration refuses while an Archiv folder exists, and says why.
refusedf "$(cat drizzle/0102_archiv_folders.down.sql)" "Cannot reverse migration 0102" "the down migration with an Archiv folder standing"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "UPDATE documents SET folder_id = NULL WHERE scope = 'archiv'; DELETE FROM project_folders WHERE scope = 'archiv'"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0102 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkf "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('organization_id','scope')" \
  "0" "down dropped the two columns"
checkf "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name = 'project_id'" \
  "NO" "down made project_id required again"
checkf "SELECT count(*) FROM project_folders" "3" "down left every project folder in place"
checkf "SELECT folder_id FROM documents WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "f0000000-0000-4000-8000-000000000002" "down left a project document in its folder"
checkf "SELECT count(*) FROM pg_policies WHERE tablename = 'project_folders' AND qual LIKE '%projects%'" \
  "1" "down restored the projects-join policy"
# And it can be applied again on the restored shape.
$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.sql" >/dev/null || {
  echo "MIGRATION 0102 FAILED when re-applied after its down migration" >&2
  exit 1
}

echo "==> 0102 backfill, constraints and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0116: project status, its CHECKs, the closed-project insert guard,
# and its DOWN migration, on the fully migrated database as the owner. The down
# refuses while a project is closed (an older build would let every write in);
# once every project is active it goes, and 0115 applies again.
# ---------------------------------------------------------------------------
echo "==> verifying the 0116 project status and its down migration on grid_app"
# Down migrations run newest first: 0129 constrains 0116's status and 0117's
# period, and 0117's trigger uses 0116's function. 0129 is re-applied and
# checked after the 0117 block below.
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0129_project_lifecycle.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0129 FAILED before the 0116 check — re-run without -q to see the error" >&2
  exit 1
}
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0117_project_steckbrief.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0117 FAILED before the 0116 check — re-run without -q to see the error" >&2
  exit 1
}
check14() {
  local got
  got=$($MIGRATE -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0115 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}
$MIGRATE -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000114', 'org_0114', 'Status 0115', 'user_1', 'proj_0114');
SQL
check14 "SELECT status FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'" "active" "a new project is active"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'closed', closed_at = now(), closed_by = 'user_1' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
if $MIGRATE -q -c "INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES ('org_0114', 'user_1', 'x.pdf', 'k/0114/x', 'proj_0114', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000114')" >/dev/null 2>&1; then
  echo "0115 ASSERTION FAILED: a document was inserted into a closed project" >&2
  exit 1
fi
if $MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_status.down.sql" >/dev/null 2>&1; then
  echo "0116 ASSERTION FAILED: the down migration ran with a closed project standing" >&2
  exit 1
fi
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "4" "the refused down migration changed nothing"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'active', closed_at = NULL, closed_by = NULL WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_status.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0116 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check14 "SELECT count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('status','closed_at','closed_by')" "0" "down dropped the three columns"
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "0" "down dropped the four triggers"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_status.sql" >/dev/null || {
  echo "MIGRATION 0116 FAILED when re-applied after its down migration" >&2
  exit 1
}
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "4" "0115 applies again"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0117_project_steckbrief.sql" >/dev/null || {
  echo "MIGRATION 0117 FAILED when re-applied after the 0116 check" >&2
  exit 1
}
echo "==> 0116 project status and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0117: the Steckbrief's period and people, and its DOWN migration
# (lossy on purpose: the people go with the table), then 0116 again.
# ---------------------------------------------------------------------------
echo "==> verifying the 0117 Steckbrief down migration on grid_app"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0117_project_steckbrief.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0116 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check14 "SELECT to_regclass('public.project_people') IS NULL" "t" "down dropped project_people"
check14 "SELECT count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('started_on','ended_on')" "0" "down dropped the period"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0117_project_steckbrief.sql" >/dev/null || {
  echo "MIGRATION 0116 FAILED when re-applied after its down migration" >&2
  exit 1
}
check14 "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_people'" "t" "0116 applies again, with row-level security"
echo "==> 0117 Steckbrief and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0129: the lifecycle state machine (ADR-0098). Paused carries its
# date, closed carries its outcome and always an Abschluss; the backfill gives
# a closed row of before 0129 both; the down turns a paused project active.
# ---------------------------------------------------------------------------
echo "==> verifying the 0129 project lifecycle and its down migration on grid_app"
check129() {
  local got
  got=$($MIGRATE -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0129 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}
refused129() {
  if $MIGRATE -v ON_ERROR_STOP=1 -q -c "$1" >/dev/null 2>&1; then
    echo "0129 ASSERTION FAILED: $2" >&2
    exit 1
  fi
}
$MIGRATE -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name, started_on)
VALUES ('aaaaaaaa-0000-4000-8000-000000000129', 'org_0129', 'Lifecycle 0129', 'user_1', 'proj_0129', '2031-03-01');
UPDATE projects SET status = 'closed', closed_at = '2030-06-15T10:00:00Z', closed_by = 'user_1'
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000129';
SQL
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0129_project_lifecycle.sql" >/dev/null || {
  echo "MIGRATION 0129 FAILED — re-run without -q to see the error" >&2
  exit 1
}
P129="id = 'aaaaaaaa-0000-4000-8000-000000000129'"
check129 "SELECT closed_outcome FROM projects WHERE $P129" "completed" "a closed project of before 0129 is completed"
check129 "SELECT ended_on FROM projects WHERE $P129" "2031-03-01" "its missing Abschluss is the close month, never before the Beginn"
refused129 "UPDATE projects SET ended_on = NULL WHERE $P129" "a closed project lost its Abschluss"
refused129 "UPDATE projects SET closed_outcome = 'abandoned' WHERE $P129" "an unknown outcome was accepted"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'active', closed_at = NULL, closed_by = NULL WHERE $P129"
check129 "SELECT ended_on || ' ' || closed_outcome FROM projects WHERE $P129" "2031-03-01 completed" "a reopen keeps the Abschluss and the outcome for the next close"
refused129 "UPDATE projects SET status = 'paused' WHERE $P129" "a paused project without a date"
refused129 "UPDATE projects SET status = 'archived' WHERE $P129" "an unknown status was accepted"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'paused', paused_at = now() WHERE $P129"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "INSERT INTO project_folders (organization_id, project_id, name, path) VALUES ('org_0129', 'aaaaaaaa-0000-4000-8000-000000000129', 'Plaene', 'Plaene')" >/dev/null || {
  echo "0129 ASSERTION FAILED: a paused project refused an insert; only a closed one may" >&2
  exit 1
}
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0129_project_lifecycle.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0129 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check129 "SELECT status FROM projects WHERE $P129" "active" "the down turned the paused project active"
check129 "SELECT count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('paused_at','closed_outcome')" "0" "the down dropped both columns"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0129_project_lifecycle.sql" >/dev/null || {
  echo "MIGRATION 0129 FAILED when re-applied after its down migration" >&2
  exit 1
}
$MIGRATE -v ON_ERROR_STOP=1 -q -c "DELETE FROM projects WHERE $P129"
echo "==> 0129 project lifecycle and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0131: a version records the verdict on its own bytes (ADR-0086),
# its backfill per row shape, and its DOWN.
#
# On a database of its own, migrated to 0130. The backfill sets a version's
# verdict only where the rows prove a pass about exactly its bytes: the item's
# passing verdict about them, or a reviewer's release of them that no current
# quarantine of the same bytes overrides. A superseded upload whose verdict a
# re-upload reset, a quarantined or in-flight upload, stays NULL.
# ---------------------------------------------------------------------------
echo "==> verifying the 0131 version verdict backfill and its down migration on grid_vhash"
migrate_until grid_vhash 0130_document_fassung_announcements
sql_in grid_vhash <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000131', 'org_0131', 'Fassungen 0131', 'user_1', 'proj_0131');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
                       content_hash, screening_outcome, screened_hash,
                       screening_released_hash, screening_released_by, screening_released_at) VALUES
  -- screened now; its first upload's verdict was reset by the re-upload
  ('d1d1d1d1-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'a.pdf', 'k/0131/a2', 'proj_0131', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:a2', 'clean', 'sha256:a2', NULL, NULL, NULL),
  -- the first upload was released by a reviewer, the second screened clean
  ('d2d2d2d2-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'b.pdf', 'k/0131/b2', 'proj_0131', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:b2', 'clean', 'sha256:b2', 'sha256:b1', 'user_2', now()),
  -- the re-upload is quarantined
  ('d3d3d3d3-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'c.pdf', 'k/0131/c2', 'proj_0131', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:c2', 'quarantined', NULL, NULL, NULL, NULL),
  -- the re-upload is still being read
  ('d4d4d4d4-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'd.pdf', 'k/0131/d2', 'proj_0131', 'pending', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:d2', NULL, NULL, NULL, NULL, NULL),
  -- released once, quarantined again on the same bytes
  ('d5d5d5d5-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'e.pdf', 'k/0131/e1', 'proj_0131', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:e1', 'quarantined', NULL, 'sha256:e1', 'user_2', now()),
  -- read with screening off: no outcome, a settled read
  ('d6d6d6d6-0000-4000-8000-000000000131', 'org_0131', 'user_1', 'f.pdf', 'k/0131/f1', 'proj_0131', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000131',
   'sha256:f1', NULL, 'sha256:f1', NULL, NULL, NULL);
INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, content_hash, created_by, approved_by, approved_at) VALUES
  ('org_0131', 'd1d1d1d1-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'superseded', 'k/0131/a1', 'sha256:a1', 'user_1', 'user_1', now()),
  ('org_0131', 'd1d1d1d1-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 2, 'published',  'k/0131/a2', 'sha256:a2', 'user_1', 'user_1', now()),
  ('org_0131', 'd2d2d2d2-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'superseded', 'k/0131/b1', 'sha256:b1', 'user_1', 'user_1', now()),
  ('org_0131', 'd2d2d2d2-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 2, 'published',  'k/0131/b2', 'sha256:b2', 'user_1', 'user_1', now()),
  ('org_0131', 'd3d3d3d3-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'superseded', 'k/0131/c1', 'sha256:c1', 'user_1', 'user_1', now()),
  ('org_0131', 'd3d3d3d3-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 2, 'published',  'k/0131/c2', 'sha256:c2', 'user_1', 'user_1', now()),
  ('org_0131', 'd4d4d4d4-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'superseded', 'k/0131/d1', 'sha256:d1', 'user_1', 'user_1', now()),
  ('org_0131', 'd4d4d4d4-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 2, 'published',  'k/0131/d2', 'sha256:d2', 'user_1', 'user_1', now()),
  ('org_0131', 'd5d5d5d5-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'published',  'k/0131/e1', 'sha256:e1', 'user_1', 'user_1', now()),
  ('org_0131', 'd6d6d6d6-0000-4000-8000-000000000131', 'aaaaaaaa-0000-4000-8000-000000000131', 1, 'published',  'k/0131/f1', 'sha256:f1', 'user_1', 'user_1', now());
SQL
V131="SELECT string_agg(d.filename || ':' || v.version_number || '=' || coalesce(v.screened_hash, '-'), ',' ORDER BY d.filename, v.version_number) FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.organization_id = 'org_0131'"
apply_in grid_vhash 0131_document_version_screened_hash.sql
check_in grid_vhash "$V131" "a.pdf:1=-,a.pdf:2=sha256:a2,b.pdf:1=sha256:b1,b.pdf:2=sha256:b2,c.pdf:1=-,c.pdf:2=-,d.pdf:1=-,d.pdf:2=-,e.pdf:1=-,f.pdf:1=sha256:f1" \
  "the backfill passes the item's passing verdict and a standing release, and nothing a re-upload reset, a quarantine holds or a read has not finished"
apply_in grid_vhash 0131_document_version_screened_hash.down.sql
check_in grid_vhash "SELECT count(*) FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'screened_hash'" "0" "down dropped the column"
apply_in grid_vhash 0131_document_version_screened_hash.sql
apply_in grid_vhash 0131_document_version_screened_hash.sql
check_in grid_vhash "SELECT count(*) FROM document_versions WHERE organization_id = 'org_0131' AND screened_hash = content_hash" "4" "0131 re-applies, twice, to the same verdicts"
echo "==> 0131 version verdict backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0133: a project's profile always has its four parts, and its DOWN.
#
# On a database of its own, migrated to 0132, where a project that never saved
# its intake still stores `{}` (the old default) and the close dialog's debrief
# crashed on `profile.facts`. The backfill gives every row the shape and keeps
# what is well-formed; the default is the empty profile; a hand-written `{}`
# or a part of the wrong type is refused. The down leaves the data.
# ---------------------------------------------------------------------------
echo "==> verifying the 0133 project profile shape and its down migration on grid_pshape"
migrate_until grid_pshape 0132_documents_folder_level_listing_idx
sql_in grid_pshape <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000133', 'org_0133', 'Nie erfasst', 'user_1', 'proj_0133a');
INSERT INTO projects (id, organization_id, name, created_by, collection_name, profile, profile_version) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000133', 'org_0133', 'Teilweise', 'user_1', 'proj_0133b',
   '{"facts":{"bundesland":{"value":"tirol"}},"unknowns":"kaputt","extra":1}', 4),
  ('cccccccc-0000-4000-8000-000000000133', 'org_0133', 'Kein Objekt', 'user_1', 'proj_0133c', '[]', 2);
SQL
check_in grid_pshape "SELECT profile::text FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000133'" "{}" \
  "before 0133 a project that never saved its intake stores {}"
apply_in grid_pshape 0133_project_profile_shape.sql
P133="SELECT profile::text || ' v' || profile_version FROM projects WHERE id ="
check_in grid_pshape "$P133 'aaaaaaaa-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v1' "the backfill gives a {} row the empty profile, version unchanged"
check_in grid_pshape "$P133 'bbbbbbbb-0000-4000-8000-000000000133'" \
  '{"extra": 1, "facts": {"bundesland": {"value": "tirol"}}, "goals": {}, "unknowns": [], "assumptions": {}} v4' \
  "the backfill keeps a well-formed part and another key, and replaces a part of the wrong type"
check_in grid_pshape "$P133 'cccccccc-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v2' "the backfill turns a non-object into the empty profile"
sql_in grid_pshape <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('dddddddd-0000-4000-8000-000000000133', 'org_0133', 'Neu', 'user_1', 'proj_0133d');
SQL
check_in grid_pshape "$P133 'dddddddd-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v1' "a new project gets the empty profile by default"
refused_in grid_pshape "UPDATE projects SET profile = '{}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "a hand-written {} was accepted"
refused_in grid_pshape "UPDATE projects SET profile = profile || '{\"unknowns\": {}}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "unknowns as an object was accepted"
refused_in grid_pshape "UPDATE projects SET profile = profile - 'goals' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "a profile without goals was accepted"
apply_in grid_pshape 0133_project_profile_shape.down.sql
check_in grid_pshape "SELECT count(*) FROM pg_constraint WHERE conname = 'projects_profile_shape_check'" "0" "down dropped the check"
check_in grid_pshape "SELECT column_default FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'profile'" \
  "'{}'::jsonb" "down restored the old default"
check_in grid_pshape "$P133 'bbbbbbbb-0000-4000-8000-000000000133'" \
  '{"extra": 1, "facts": {"bundesland": {"value": "tirol"}}, "goals": {}, "unknowns": [], "assumptions": {}} v4' "down left the data"
sql_in grid_pshape <<<"UPDATE projects SET profile = '{}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'"
apply_in grid_pshape 0133_project_profile_shape.sql
apply_in grid_pshape 0133_project_profile_shape.sql
check_in grid_pshape "SELECT count(*) FROM projects WHERE organization_id = 'org_0133' AND profile ? 'facts'" "4" \
  "0133 re-applies, twice, and backfills a {} written while it was down"
echo "==> 0133 project profile shape and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0137: a version knows how it began, and an upload carries no
# approval nobody gave (ADR-0104 rules 5 and 6), and its DOWN.
#
# On a database of its own, migrated to 0136. A version never submitted that is
# or was the published one is an upload and loses its stand-in approver; one
# that went through review keeps the reviewer's. Afterwards a published draft
# without an approver and an unknown origin are refused, and an upload is
# published with none. The down restores the stand-in approvals.
# ---------------------------------------------------------------------------
echo "==> verifying the 0137 version origin backfill and its down migration on grid_vorigin"
migrate_until grid_vorigin 0136_document_version_reviews
sql_in grid_vorigin <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000137', 'org_0137', 'Herkunft 0137', 'user_1', 'proj_0137');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'a.pdf', 'k/0137/a2', 'proj_0137', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000137'),
  ('d2d2d2d2-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'piloti/b.md', 'k/0137/b1', 'proj_0137', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000137'),
  ('d3d3d3d3-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'piloti/c.md', 'k/0137/c1', 'proj_0137', 'stored', 'project', 'aaaaaaaa-0000-4000-8000-000000000137');
INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by,
                               submitted_by, submitted_at, approved_by, approved_at) VALUES
  -- a re-uploaded file: both versions carry the uploader as stand-in approver
  ('org_0137', 'd1d1d1d1-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'superseded', 'k/0137/a1', 'user_1', NULL, NULL, 'user_1', now()),
  ('org_0137', 'd1d1d1d1-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 2, 'published',  'k/0137/a2', 'user_1', NULL, NULL, 'user_1', now()),
  -- a Piloti document a reviewer approved
  ('org_0137', 'd2d2d2d2-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'published',  'k/0137/b1', 'user_1', 'user_1', now(), 'user_2', now()),
  -- a draft
  ('org_0137', 'd3d3d3d3-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'draft',      'k/0137/c1', 'user_1', NULL, NULL, NULL, NULL);
SQL
V137="SELECT string_agg(d.filename || ':' || v.version_number || '=' || v.origin || '/' || coalesce(v.approved_by, '-'), ',' ORDER BY d.filename, v.version_number) FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.organization_id = 'org_0137'"
apply_in grid_vorigin 0137_document_version_origin.sql
check_in grid_vorigin "$V137" "a.pdf:1=upload/-,a.pdf:2=upload/-,piloti/b.md:1=draft/user_2,piloti/c.md:1=draft/-" \
  "the backfill calls a never-submitted published version an upload and drops its stand-in approver, and keeps a reviewer's"
refused_in grid_vorigin "UPDATE document_versions SET state = 'published' WHERE document_id = 'd3d3d3d3-0000-4000-8000-000000000137'" \
  "document_versions_published_is_approved" "a draft was published without an approver"
refused_in grid_vorigin "UPDATE document_versions SET origin = 'import' WHERE document_id = 'd3d3d3d3-0000-4000-8000-000000000137'" \
  "document_versions_origin_known" "an unknown origin was accepted"
check_in grid_vorigin "SELECT column_default FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'origin'" \
  "'draft'::text" "a writer that names no origin gets the one that demands an approver"
apply_in grid_vorigin 0137_document_version_origin.down.sql
check_in grid_vorigin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'origin'" "0" "down dropped the column"
check_in grid_vorigin "SELECT count(*) FROM document_versions WHERE organization_id = 'org_0137' AND approved_by = created_by AND submitted_by IS NULL" "2" \
  "down restored the stand-in approvals the old CHECK demands"
apply_in grid_vorigin 0137_document_version_origin.sql
apply_in grid_vorigin 0137_document_version_origin.sql
check_in grid_vorigin "$V137" "a.pdf:1=upload/-,a.pdf:2=upload/-,piloti/b.md:1=draft/user_2,piloti/c.md:1=draft/-" "0137 re-applies, twice, to the same origins"
echo "==> 0137 version origin backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0138: document_annotations and their replies, the CHECKs, and the
# DOWN.
#
# On a database of its own, migrated to 0137. A point is a share of the page
# and a region stays on it; only Piloti proposes, and only a person takes a
# proposal over; a closing is by somebody at some time; a number is unique per
# document; a discarded version leaves the mark standing; a thread goes with
# its mark.
# ---------------------------------------------------------------------------
echo "==> verifying the 0138 Anmerkungen tables and their down migration on grid_annot"
migrate_until grid_annot 0137_document_version_origin
apply_in grid_annot 0138_document_annotations.sql
check_in grid_annot "SELECT string_agg(relrowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('document_annotations', 'document_annotation_replies')" "true,true" "0138 brings both tables up under row-level security"
sql_in grid_annot <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000135', 'org_0135', 'Anmerkungen 0138', 'user_1', 'proj_0135');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000135', 'org_0135', 'user_1', 'a.pdf', 'k/0138/a', 'proj_0135', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000135');
INSERT INTO document_versions (id, organization_id, document_id, project_id, version_number, state, storage_key, content_hash, created_by, approved_by, approved_at)
VALUES ('e1e1e1e1-0000-4000-8000-000000000135', 'org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 'aaaaaaaa-0000-4000-8000-000000000135', 1, 'superseded', 'k/0138/a1', 'sha256:a1', 'user_1', 'user_1', now());
INSERT INTO document_annotations (id, organization_id, document_id, version_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000135', 'org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 'e1e1e1e1-0000-4000-8000-000000000135', 1, 2, 'point', 0.25, 0.75, 'defect', 'Brandschutztür fehlt', 'person', 'open', 'user_1');
INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, w, h, kind, body, basis, author_kind, status, created_by)
VALUES ('org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 2, 1, 'region', 0.1, 0.1, 0.5, 0.5, 'question', 'Laufbreite?', 'OIB-RL 4, Pkt. 2.2', 'piloti', 'proposed', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0135', 'f1f1f1f1-0000-4000-8000-000000000135', 'person', 'Erledige ich', 'user_2');
SQL
A135="INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, w, h, kind, body, author_kind, status, created_by) VALUES ('org_0135', 'd1d1d1d1-0000-4000-8000-000000000135'"
refused_in grid_annot "$A135, 3, 1, 'point', 1.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_point_on_page" "a point off the page was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, 0.1, 0.1, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_region_on_page" "a point with a size was accepted"
refused_in grid_annot "$A135, 3, 1, 'region', 0.8, 0.5, 0.3, 0.1, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_region_on_page" "a region off its page was accepted"
refused_in grid_annot "$A135, 3, 0, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_page_positive" "page 0 was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'todo', 'x', 'person', 'open', 'user_1')" "document_annotations_kind_known" "an unknown kind was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', '   ', 'person', 'open', 'user_1')" "document_annotations_body_length" "a blank body was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'proposed', 'user_1')" "document_annotations_only_piloti_proposes" "a person's proposal was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'piloti', 'open', 'user_1')" "document_annotations_piloti_needs_a_person" "Piloti's mark was born open"
refused_in grid_annot "$A135, 1, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "uniq_document_annotations_number" "a second number 1 was accepted"
refused_in grid_annot "UPDATE document_annotations SET status = 'resolved' WHERE number = 1" "document_annotations_closing_complete" "a closing by nobody was accepted"
refused_in grid_annot "UPDATE document_annotations SET status = 'open' WHERE number = 2" "document_annotations_piloti_needs_a_person" "a proposal was opened without a person taking it over"
sql_in grid_annot <<<"UPDATE document_annotations SET status = 'open', accepted_by = 'user_2', accepted_at = now() WHERE number = 2"
sql_in grid_annot <<<"UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now() WHERE number = 1"
sql_in grid_annot <<<"DELETE FROM document_versions WHERE id = 'e1e1e1e1-0000-4000-8000-000000000135'"
check_in grid_annot "SELECT string_agg(number || ':' || coalesce(version_id::text, 'null') || ':' || status, ',' ORDER BY number) FROM document_annotations" "1:null:resolved,2:null:open" "a discarded version leaves the mark standing, and a taken-over proposal is open"
sql_in grid_annot <<<"DELETE FROM document_annotations WHERE number = 1"
check_in grid_annot "SELECT count(*) FROM document_annotation_replies" "0" "a thread goes with its mark"
apply_in grid_annot 0138_document_annotations.down.sql
check_in grid_annot "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('document_annotations', 'document_annotation_replies')" "0" "down dropped both tables"
apply_in grid_annot 0138_document_annotations.sql
apply_in grid_annot 0138_document_annotations.sql
check_in grid_annot "SELECT count(*) FROM document_annotations" "0" "0138 re-applies, twice, empty"
echo "==> 0138 Anmerkungen tables and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0139: what wakes Piloti on an Anmerkung, the delegation to Piloti,
# the record of each wake, and the DOWN.
#
# On a database of its own, migrated to 0138. A reply says whether it
# addressed Piloti (false for every older reply); a delegation is both columns
# or neither, and only on an open mark; a wake record says why it started no
# turn exactly when it did not, and is settled exactly when it left `queued`;
# a wake goes with its mark.
# ---------------------------------------------------------------------------
echo "==> verifying the 0139 wake record, the delegation and their down migration on grid_wake"
migrate_until grid_wake 0138_document_annotations
sql_in grid_wake <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000136', 'org_0136', 'Wecken 0139', 'user_1', 'proj_0136');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000136', 'org_0136', 'user_1', 'a.pdf', 'k/0139/a', 'proj_0136', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000136');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000136', 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f2f2f2f2-0000-4000-8000-000000000136', 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 2, 1, 'point', 0.2, 0.2, 'question', 'Laufbreite?', 'piloti', 'proposed', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0136', 'f1f1f1f1-0000-4000-8000-000000000136', 'person', 'Vor 0139 geschrieben', 'user_2');
SQL
apply_in grid_wake 0139_piloti_wakes.sql
check_in grid_wake "SELECT relrowsecurity FROM pg_class WHERE relname = 'piloti_wakes'" "t" "0139 brings the wake record up under row-level security"
check_in grid_wake "SELECT string_agg(addresses_agent::text, ',') FROM document_annotation_replies" "false" "a reply written before 0139 addressed nobody but people"
refused_in grid_wake "UPDATE document_annotations SET delegated_by = 'user_1' WHERE number = 1" "document_annotations_delegation_complete" "a delegation without its time was accepted"
refused_in grid_wake "UPDATE document_annotations SET delegated_at = now() WHERE number = 1" "document_annotations_delegation_complete" "a delegation without its person was accepted"
refused_in grid_wake "UPDATE document_annotations SET delegated_by = 'user_1', delegated_at = now() WHERE number = 2" "document_annotations_delegated_while_open" "a proposal was delegated to Piloti"
sql_in grid_wake <<<"UPDATE document_annotations SET delegated_by = 'user_1', delegated_at = now() WHERE number = 1"
refused_in grid_wake "UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now() WHERE number = 1" "document_annotations_delegated_while_open" "a mark closed with Piloti still working it"
sql_in grid_wake <<<"UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now(), delegated_by = NULL, delegated_at = NULL WHERE number = 1"
W136="INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at) VALUES (gen_random_uuid(), 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 'f2f2f2f2-0000-4000-8000-000000000136'"
refused_in grid_wake "$W136, 'shouted', 'e1', 'user_1', 'queued', NULL, NULL)" "piloti_wakes_trigger_known" "an unknown trigger was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'snoozed', NULL, now())" "piloti_wakes_status_known" "an unknown status was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'refused', NULL, now())" "piloti_wakes_reason_when_not_started" "a refused wake without its reason was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'started', 'weil', now())" "piloti_wakes_reason_when_not_started" "a started wake with a reason was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'started', NULL, NULL)" "piloti_wakes_settled_when_not_queued" "a started wake without its settling time was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'queued', NULL, now())" "piloti_wakes_settled_when_not_queued" "a queued wake with a settling time was accepted"
sql_in grid_wake <<<"$W136, 'thread_reply', 'e1', 'user_1', 'queued', NULL, NULL)"
sql_in grid_wake <<<"$W136, 'assigned', 'e2', 'user_1', 'suppressed', 'cap:mark-hour', now())"
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "2" "a queued wake and a suppressed one with its reason are kept"
sql_in grid_wake <<<"DELETE FROM document_annotations WHERE number = 2"
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "0" "a wake goes with its mark"
apply_in grid_wake 0139_piloti_wakes.down.sql
check_in grid_wake "SELECT count(*) FROM information_schema.tables WHERE table_name = 'piloti_wakes'" "0" "down dropped the wake record"
check_in grid_wake "SELECT count(*) FROM information_schema.columns WHERE (table_name, column_name) IN (('document_annotations', 'delegated_by'), ('document_annotations', 'delegated_at'), ('document_annotation_replies', 'addresses_agent'))" "0" "down dropped the three columns"
check_in grid_wake "SELECT count(*) FROM document_annotation_replies" "1" "down left the threads"
apply_in grid_wake 0139_piloti_wakes.sql
apply_in grid_wake 0139_piloti_wakes.sql
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "0" "0139 re-applies, twice, empty"
echo "==> 0139 wake record, delegation and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0140: proposed_changes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0139. A proposal is decided by
# somebody at some time exactly when it left `proposed`; it carries results
# exactly when it was applied, as an array; the apply claim is both columns or
# neither, and only while it is still `proposed`; the project and the
# conversation are this organization's; it goes with either.
# ---------------------------------------------------------------------------
echo "==> verifying the 0140 proposed changes and their down migration on grid_prop"
migrate_until grid_prop 0139_piloti_wakes
apply_in grid_prop 0140_proposed_changes.sql
check_in grid_prop "SELECT relrowsecurity FROM pg_class WHERE relname = 'proposed_changes'" "t" "0140 brings proposed_changes up under row-level security"
sql_in grid_prop <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000137', 'org_0137', 'Vorschläge 0140', 'user_1', 'proj_0137'),
       ('bbbbbbbb-0000-4000-8000-000000000137', 'org_other', 'Fremd 0140', 'user_9', 'proj_other_0137');
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES ('conv_0137', 'org_0137', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000137'),
       ('conv_other_0137', 'org_other', 'user_9', 'bbbbbbbb-0000-4000-8000-000000000137');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id)
VALUES ('c1c1c1c1-0000-4000-8000-000000000137', 'org_0137', 'aaaaaaaa-0000-4000-8000-000000000137', 'file_operation',
        '{"operation":"move","operations":[{"document":"a.pdf","target_folder":"Einreichung"}]}', 'piloti', 'user_1', 'conv_0137'),
       ('c2c2c2c2-0000-4000-8000-000000000137', 'org_0137', 'aaaaaaaa-0000-4000-8000-000000000137', 'file_operation',
        '{"operation":"create_folder","operations":[{"folder_name":"Statik"}]}', 'piloti', 'user_1', NULL);
SQL
check_in grid_prop "SELECT string_agg(status, ',') FROM proposed_changes" "proposed,proposed" "a proposal is born proposed"
P137="INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id, status, decided_by, decided_at, results, applying_by, applying_since) VALUES ('org_0137', 'aaaaaaaa-0000-4000-8000-000000000137'"
refused_in grid_prop "$P137, 'delete_all', '{}', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_kind_known" "an unknown kind was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'withdrawn', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_status_known" "an unknown status was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'robot', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_proposer_known" "an unknown proposer was accepted"
refused_in grid_prop "$P137, 'file_operation', '[]', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_payload_object" "a payload that is not an object was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_decision_complete" "a decision by nobody was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', NULL, NULL, NULL, NULL)" "proposed_changes_decision_complete" "a decision at no time was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'proposed', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_decision_complete" "an undecided proposal with a decider was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'applied', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_results_when_applied" "an applied proposal without results was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', now(), '[]', NULL, NULL)" "proposed_changes_results_when_applied" "a dismissed proposal with results was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'failed', 'user_1', now(), '{}', NULL, NULL)" "proposed_changes_results_array" "results that are not a list were accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, 'user_1', NULL)" "proposed_changes_claim_complete" "a claim at no time was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', now(), NULL, 'user_1', now())" "proposed_changes_claim_while_proposed" "a claim on a decided proposal was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', 'conv_other_0137', 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_conversation_fkey" "another organization's conversation was accepted"
refused_in grid_prop "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0137', 'bbbbbbbb-0000-4000-8000-000000000137', 'file_operation', '{}', 'piloti', 'user_1')" "proposed_changes_project_fkey" "another organization's project was accepted"
sql_in grid_prop <<<"UPDATE proposed_changes SET applying_by = 'user_2', applying_since = now() WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'"
refused_in grid_prop "UPDATE proposed_changes SET status = 'partially_applied', decided_by = 'user_2', decided_at = now(), results = '[{\"label\":\"a.pdf\",\"ok\":true}]' WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'" "proposed_changes_claim_while_proposed" "a settle that kept its claim was accepted"
sql_in grid_prop <<<"UPDATE proposed_changes SET status = 'partially_applied', decided_by = 'user_2', decided_at = now(), results = '[{\"label\":\"a.pdf\",\"ok\":true}]', applying_by = NULL, applying_since = NULL WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'"
sql_in grid_prop <<<"DELETE FROM conversations WHERE id = 'conv_0137'"
check_in grid_prop "SELECT count(*) FROM proposed_changes" "1" "a proposal goes with its conversation"
sql_in grid_prop <<<"DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000137'"
check_in grid_prop "SELECT count(*) FROM proposed_changes" "0" "a proposal goes with its project"
apply_in grid_prop 0140_proposed_changes.down.sql
check_in grid_prop "SELECT count(*) FROM information_schema.tables WHERE table_name = 'proposed_changes'" "0" "down dropped proposed_changes"
check_in grid_prop "SELECT count(*) FROM conversations" "1" "down left the conversations"
apply_in grid_prop 0140_proposed_changes.sql
apply_in grid_prop 0140_proposed_changes.sql
check_in grid_prop "SELECT count(*) FROM proposed_changes" "0" "0140 re-applies, twice, empty"
echo "==> 0140 proposed changes and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0141: a wake's END, and the DOWN.
#
# On a database of its own, migrated to 0140. A wake has an end exactly when it
# has its final word (not `queued`, not `started`); the rows 0139 settled
# already ended when they settled; `answered` and `stopped` carry no reason,
# `failed` does.
# ---------------------------------------------------------------------------
echo "==> verifying the 0141 wake ends and their down migration on grid_wend"
migrate_until grid_wend 0140_proposed_changes
sql_in grid_wend <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000138', 'org_0138', 'Enden 0141', 'user_1', 'proj_0138');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000138', 'org_0138', 'user_1', 'a.pdf', 'k/0141/a', 'proj_0138', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000138');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at)
VALUES ('a1a1a1a1-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e1', 'user_1', 'queued', NULL, NULL),
       ('a2a2a2a2-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e2', 'user_1', 'started', NULL, now()),
       ('a3a3a3a3-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'assigned', 'e3', 'user_1', 'suppressed', 'cap:mark-hour', now());
SQL
apply_in grid_wend 0141_wake_ends.sql
check_in grid_wend "SELECT string_agg(status || ':' || (ended_at IS NOT NULL)::text, ',' ORDER BY event_id) FROM piloti_wakes" "queued:false,started:false,suppressed:true" "a wake 0139 settled without a turn ended when it settled; the others have not ended"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'answered' WHERE event_id = 'e2'" "piloti_wakes_ended_when_final" "an answered wake without its end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_ended_when_final" "a running wake with an end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'snoozed', ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_status_known" "an unknown end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'answered', ended_at = now(), reason = 'weil' WHERE event_id = 'e2'" "piloti_wakes_reason_when_not_started" "an answered wake with a reason was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'failed', ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_reason_when_not_started" "a failed turn without its reason was accepted"
sql_in grid_wend <<<"UPDATE piloti_wakes SET status = 'failed', reason = 'turn error', ended_at = settled_at + interval '1 minute' WHERE event_id = 'e2'"
sql_in grid_wend <<'SQL'
INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at, ended_at)
VALUES ('a4a4a4a4-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e4', 'user_1', 'answered', NULL, now(), now() + interval '1 minute'),
       ('a5a5a5a5-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'assigned', 'e5', 'user_1', 'stopped', NULL, now(), now() + interval '1 minute');
SQL
check_in grid_wend "SELECT count(*) FROM piloti_wakes WHERE ended_at IS NOT NULL" "4" "an answered, a stopped and a failed turn keep their ends"
apply_in grid_wend 0141_wake_ends.down.sql
check_in grid_wend "SELECT string_agg(status, ',' ORDER BY event_id) FROM piloti_wakes" "queued,started,suppressed,started,started" "down folds every end of a turn that ran back into started"
check_in grid_wend "SELECT count(*) FROM information_schema.columns WHERE table_name = 'piloti_wakes' AND column_name = 'ended_at'" "0" "down dropped ended_at"
apply_in grid_wend 0141_wake_ends.sql
apply_in grid_wend 0141_wake_ends.sql
check_in grid_wend "SELECT count(*) FROM piloti_wakes WHERE ended_at IS NOT NULL" "1" "0141 re-applies, twice: only the suppressed wake has ended"
echo "==> 0141 wake ends and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0142: piloti_changes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0141. A change names a known object
# and op; a create has no before, a delete no after, an update both; a reply
# is only ever created; a mark's change names the mark as its object; states
# are objects; an undo is by somebody at some time; the document and the
# conversation are this organization's; it goes with either, and outlives the
# mark it deleted.
# ---------------------------------------------------------------------------
echo "==> verifying the 0142 change record and its down migration on grid_chg"
migrate_until grid_chg 0141_wake_ends
apply_in grid_chg 0142_piloti_changes.sql
check_in grid_chg "SELECT relrowsecurity FROM pg_class WHERE relname = 'piloti_changes'" "t" "0142 brings piloti_changes up under row-level security"
sql_in grid_chg <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000139', 'org_0139', 'Änderungen 0142', 'user_1', 'proj_0139'),
       ('bbbbbbbb-0000-4000-8000-000000000139', 'org_other', 'Fremd 0142', 'user_9', 'proj_other_0139');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000139', 'org_0139', 'user_1', 'a.pdf', 'k/0142/a', 'proj_0139', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000139'),
       ('d2d2d2d2-0000-4000-8000-000000000139', 'org_0139', 'user_1', 'b.pdf', 'k/0142/b', 'proj_0139', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000139');
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES ('conv_0139', 'org_0139', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000139'),
       ('conv_other_0139', 'org_other', 'user_9', 'bbbbbbbb-0000-4000-8000-000000000139');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000139', 'org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of)
VALUES ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{"status":"open"}', '{"status":"resolved"}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1'),
       ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation_reply', 'e1e1e1e1-0000-4000-8000-000000000139', 'create', NULL, '{"body":"Ja."}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1'),
       ('org_0139', 'd2d2d2d2-0000-4000-8000-000000000139', 'f2f2f2f2-0000-4000-8000-000000000139', 'annotation', 'f2f2f2f2-0000-4000-8000-000000000139', 'delete', '{"status":"open","body":"weg"}', NULL, 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1');
SQL
check_in grid_chg "SELECT count(*) FROM piloti_changes WHERE undone_at IS NULL AND undone_by IS NULL" "3" "an update, a reply and a delete of a mark that no longer exists are recorded, undone by nobody"
C139="INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of) VALUES ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139'"
refused_in grid_chg "$C139, 'document', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_object_known" "an unknown object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'move', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_op_known" "an unknown op was accepted"
refused_in grid_chg "$C139, 'annotation_reply', 'e1e1e1e1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_reply_is_created" "a reply changed by Piloti was accepted"
refused_in grid_chg "$C139, 'annotation', 'e1e1e1e1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_annotation_is_object" "a mark's change naming another object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'create', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "a create with a before was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', NULL, '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "an update without a before was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'delete', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "a delete with an after was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '[]', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_are_objects" "a state that is not an object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_other_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_conversation_fkey" "another organization's conversation was accepted"
refused_in grid_chg "INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of) VALUES ('org_0139', '00000000-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_document_fkey" "a change on no document was accepted"
refused_in grid_chg "UPDATE piloti_changes SET undone_at = now() WHERE op = 'update'" "piloti_changes_undo_complete" "an undo by nobody was accepted"
refused_in grid_chg "UPDATE piloti_changes SET undone_by = 'user_2' WHERE op = 'update'" "piloti_changes_undo_complete" "an undo at no time was accepted"
sql_in grid_chg <<<"UPDATE piloti_changes SET undone_at = now(), undone_by = 'user_2' WHERE op = 'update'"
sql_in grid_chg <<<"DELETE FROM document_annotations WHERE id = 'f1f1f1f1-0000-4000-8000-000000000139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "3" "the record outlives the mark (no foreign key on the mark)"
sql_in grid_chg <<<"DELETE FROM documents WHERE id = 'd2d2d2d2-0000-4000-8000-000000000139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "2" "a change goes with its document"
sql_in grid_chg <<<"DELETE FROM conversations WHERE id = 'conv_0139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "0" "a change goes with the conversation of its turn"
apply_in grid_chg 0142_piloti_changes.down.sql
check_in grid_chg "SELECT count(*) FROM information_schema.tables WHERE table_name = 'piloti_changes'" "0" "down dropped piloti_changes"
check_in grid_chg "SELECT count(*) FROM documents" "1" "down left the documents"
apply_in grid_chg 0142_piloti_changes.sql
apply_in grid_chg 0142_piloti_changes.sql
check_in grid_chg "SELECT count(*) FROM piloti_changes" "0" "0142 re-applies, twice, empty"
echo "==> 0142 change record and down migration verified"


# ---------------------------------------------------------------------------
# Migration 0143: two more proposal kinds, the card index, and the DOWN.
#
# On a database of its own, migrated to 0142. A memory note and a profile
# change are stored, an unknown kind is not; a card index is never negative and
# names a card of an answer, so it needs the answer; one card of one answer is
# one proposal per organization, while another card, another answer, another
# organization or no card at all is its own. The down deletes the new kinds,
# forgets the card index, and the up re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0143 proposal kinds and their down migration on grid_kinds"
migrate_until grid_kinds 0142_piloti_changes
apply_in grid_kinds 0143_proposal_kinds.sql
sql_in grid_kinds <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000140', 'org_0140', 'Vorschläge 0143', 'user_1', 'proj_0140'),
       ('bbbbbbbb-0000-4000-8000-000000000140', 'org_other', 'Fremd 0143', 'user_9', 'proj_other_0140');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_message_id, origin_card_index)
VALUES ('c1c1c1c1-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'file_operation',
        '{"operation":"create_folder","operations":[{"folder_name":"Statik"}]}', 'piloti', 'user_1', NULL, NULL),
       ('c2c2c2c2-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Flachdach","confidence":"high"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', 0),
       ('c3c3c3c3-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'project_profile',
        '{"title":"Bundesland","patch":[{"op":"replace","path":"/facts/bundesland/value","value":"tirol"}]}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', 1),
       ('c4c4c4c4-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"organization","kind":"preference","content":"1:100","confidence":"medium"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', NULL),
       ('c5c5c5c5-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"organization","kind":"preference","content":"1:50","confidence":"medium"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', NULL),
       ('c6c6c6c6-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Holzbau","confidence":"high"}', 'piloti', 'user_1',
        'eeeeeeee-0000-4000-8000-000000000140', 0),
       ('c7c7c7c7-0000-4000-8000-000000000140', 'org_other', 'bbbbbbbb-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Fremd","confidence":"low"}', 'piloti', 'user_9',
        'dddddddd-0000-4000-8000-000000000140', 0);
SQL
check_in grid_kinds "SELECT string_agg(kind, ',' ORDER BY id) FROM proposed_changes" "file_operation,memory,project_profile,memory,memory,memory,memory" "0143 stores both new kinds, a card on another answer, two without a card, and the same card in another organization"
P140="INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_message_id, origin_card_index) VALUES ('org_0140', 'aaaaaaaa-0000-4000-8000-000000000140'"
refused_in grid_kinds "$P140, 'steckbrief', '{}', 'piloti', 'user_1', NULL, NULL)" "proposed_changes_kind_known" "an unknown kind was accepted"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', -1)" "proposed_changes_card_index_nonnegative" "a negative card index was accepted"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', NULL, 2)" "proposed_changes_card_index_needs_message" "a card index without its answer was accepted"
refused_in grid_kinds "$P140, 'project_profile', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)" "uniq_proposed_changes_origin_card" "the same card of the same answer was accepted twice"
refused_in grid_kinds "UPDATE proposed_changes SET origin_card_index = 1 WHERE id = 'c2c2c2c2-0000-4000-8000-000000000140'" "uniq_proposed_changes_origin_card" "a proposal was moved onto another proposal's card"
# The service's idempotent insert: the same card is no row, and the first one reads back.
sql_in grid_kinds <<<"$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0) ON CONFLICT (organization_id, origin_message_id, origin_card_index) WHERE origin_card_index IS NOT NULL DO NOTHING"
check_in grid_kinds "SELECT count(*) FROM proposed_changes WHERE organization_id = 'org_0140'" "6" "an insert of a card already proposed added a row"
apply_in grid_kinds 0143_proposal_kinds.down.sql
check_in grid_kinds "SELECT string_agg(kind, ',') FROM proposed_changes" "file_operation" "down deleted the proposals of the new kinds, and only those"
check_in grid_kinds "SELECT count(*) FROM information_schema.columns WHERE table_name = 'proposed_changes' AND column_name = 'origin_card_index'" "0" "down dropped the card index"
check_in grid_kinds "SELECT count(*) FROM pg_indexes WHERE indexname = 'uniq_proposed_changes_origin_card'" "0" "down dropped the card's unique index"
refused_in grid_kinds "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_kind_known" "down left the new kinds allowed"
apply_in grid_kinds 0143_proposal_kinds.sql
apply_in grid_kinds 0143_proposal_kinds.sql
check_in grid_kinds "SELECT count(*) FROM proposed_changes" "1" "0143 re-applies, twice, keeping the file operation"
sql_in grid_kinds <<<"$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)" "uniq_proposed_changes_origin_card" "the re-applied 0143 lost the card's unique index"
echo "==> 0143 proposal kinds and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0144: project_intakes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0143. One intake per project, of this
# organization's project, gone with it. A closing intent exactly in `closing`
# mode, and an object; a reading always names its job, and one job is one
# intake's; the completion is by somebody at some time exactly when
# `completed`; the read list and the dismissed values are arrays, born empty;
# the description is at most 500 characters.
# ---------------------------------------------------------------------------
echo "==> verifying the 0144 project intakes and their down migration on grid_intake"
migrate_until grid_intake 0143_proposal_kinds
apply_in grid_intake 0144_project_intakes.sql
check_in grid_intake "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_intakes'" "t" "0144 brings project_intakes up under row-level security"
sql_in grid_intake <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000144', 'org_0144', 'Erfassung 0144', 'user_1', 'proj_0144'),
       ('cccccccc-0000-4000-8000-000000000144', 'org_0144', 'Abgeschlossen 0144', 'user_1', 'proj_closed_0144'),
       ('dddddddd-0000-4000-8000-000000000144', 'org_0144', 'Frei 0144', 'user_1', 'proj_free_0144'),
       ('bbbbbbbb-0000-4000-8000-000000000144', 'org_other', 'Fremd 0144', 'user_9', 'proj_other_0144');
INSERT INTO project_intakes (organization_id, project_id, created_by)
VALUES ('org_0144', 'aaaaaaaa-0000-4000-8000-000000000144', 'user_1');
INSERT INTO project_intakes (organization_id, project_id, created_by, mode, closing, status, job_id, requested_by)
VALUES ('org_0144', 'cccccccc-0000-4000-8000-000000000144', 'user_1', 'closing',
        '{"outcome":"completed","endedOn":"2024-06"}', 'reading', 'job_0144', 'user_1');
SQL
check_in grid_intake "SELECT string_agg(mode || ':' || status || ':' || documents_read::text || ':' || dismissed::text || ':' || rerun_requested::text, ',' ORDER BY mode) FROM project_intakes" "active:waiting:[]:[]:false,closing:reading:[]:[]:false" "an intake is born waiting and active, with nothing read or dismissed"
I144="INSERT INTO project_intakes (organization_id, project_id, created_by, mode, closing, status, job_id, completed_at, completed_by) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1'"
refused_in grid_intake "$I144, 'active', NULL, 'paused', NULL, NULL, NULL)" "project_intakes_status_known" "an unknown status was accepted"
refused_in grid_intake "$I144, 'archive', NULL, 'waiting', NULL, NULL, NULL)" "project_intakes_mode_known" "an unknown mode was accepted"
refused_in grid_intake "$I144, 'closing', NULL, 'waiting', NULL, NULL, NULL)" "project_intakes_closing_when_closing" "a closing intake without its intent was accepted"
refused_in grid_intake "$I144, 'active', '{\"outcome\":\"completed\",\"endedOn\":\"2024-06\"}', 'waiting', NULL, NULL, NULL)" "project_intakes_closing_when_closing" "an active intake with a closing intent was accepted"
refused_in grid_intake "$I144, 'closing', '[]', 'waiting', NULL, NULL, NULL)" "project_intakes_closing_object" "a closing intent that is not an object was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'reading', NULL, NULL, NULL)" "project_intakes_job_when_reading" "a reading without its job was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'completed', NULL, NULL, NULL)" "project_intakes_completion_complete" "a completion by nobody at no time was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'completed', NULL, now(), NULL)" "project_intakes_completion_complete" "a completion by nobody was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'ready', NULL, now(), 'user_1')" "project_intakes_completion_complete" "a completion on an intake still under review was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'reading', 'job_0144', NULL, NULL)" "uniq_project_intakes_job" "one job reading for two intakes was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by) VALUES ('org_0144', 'aaaaaaaa-0000-4000-8000-000000000144', 'user_1')" "uniq_project_intakes_project" "a second intake for one project was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by) VALUES ('org_0144', 'bbbbbbbb-0000-4000-8000-000000000144', 'user_1')" "project_intakes_project_fkey" "another organization's project was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, documents_read) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '{}')" "project_intakes_documents_read_array" "a read list that is not a list was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, dismissed) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', 'null')" "project_intakes_dismissed_array" "dismissed values that are not a list were accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, location) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '\"Wien\"')" "project_intakes_location_object" "a location that is not an object was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, counts) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '[]')" "project_intakes_counts_object" "counts that are not an object were accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, description) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', repeat('x', 501))" "project_intakes_description_length" "a description over 500 characters was accepted"
# A finished review: a reading that ends and is completed by somebody at some time.
sql_in grid_intake <<<"UPDATE project_intakes SET status = 'completed', completed_at = now(), completed_by = 'user_1' WHERE project_id = 'cccccccc-0000-4000-8000-000000000144'"
check_in grid_intake "SELECT status FROM project_intakes WHERE project_id = 'cccccccc-0000-4000-8000-000000000144'" "completed" "a review completes, keeping its last job"
sql_in grid_intake <<<"DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000144'"
check_in grid_intake "SELECT count(*) FROM project_intakes" "1" "an intake goes with its project"
apply_in grid_intake 0144_project_intakes.down.sql
check_in grid_intake "SELECT count(*) FROM information_schema.tables WHERE table_name = 'project_intakes'" "0" "down dropped project_intakes"
check_in grid_intake "SELECT count(*) FROM projects WHERE organization_id = 'org_0144'" "2" "down left the projects"
apply_in grid_intake 0144_project_intakes.sql
apply_in grid_intake 0144_project_intakes.sql
check_in grid_intake "SELECT count(*) FROM project_intakes" "0" "0144 re-applies, twice, empty"
echo "==> 0144 project intakes and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0145: a folder's description, and the DOWN.
#
# On a database of its own, migrated to 0144. A folder on either shelf may say
# what belongs in it; a description is never blank and at most 500 characters.
# ---------------------------------------------------------------------------
echo "==> verifying the 0145 folder descriptions and their down migration on grid_fdesc"
migrate_until grid_fdesc 0144_project_intakes
sql_in grid_fdesc <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000145', 'org_0145', 'Ablage 0145', 'user_1', 'proj_0145');
INSERT INTO project_folders (id, organization_id, project_id, scope, name, path)
VALUES ('f1f1f1f1-0000-4000-8000-000000000145', 'org_0145', 'aaaaaaaa-0000-4000-8000-000000000145', 'project', 'Bescheide', 'Bescheide'),
       ('f2f2f2f2-0000-4000-8000-000000000145', 'org_0145', NULL, 'archiv', 'Normen', 'Normen');
SQL
apply_in grid_fdesc 0145_folder_descriptions.sql
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NULL" "2" "0145 leaves every folder undescribed"
sql_in grid_fdesc <<<"UPDATE project_folders SET description = 'Bescheide und Stellungnahmen der Behörden' WHERE name = 'Bescheide'"
sql_in grid_fdesc <<<"UPDATE project_folders SET description = 'ÖNORMEN, die das Büro gekauft hat' WHERE name = 'Normen'"
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NOT NULL" "2" "a project folder and a Büroablage folder each take a description"
refused_in grid_fdesc "UPDATE project_folders SET description = '   ' WHERE name = 'Bescheide'" "project_folders_description_length" "a blank description was accepted"
refused_in grid_fdesc "UPDATE project_folders SET description = '' WHERE name = 'Bescheide'" "project_folders_description_length" "an empty description was accepted"
refused_in grid_fdesc "UPDATE project_folders SET description = repeat('x', 501) WHERE name = 'Bescheide'" "project_folders_description_length" "a description over 500 characters was accepted"
apply_in grid_fdesc 0145_folder_descriptions.down.sql
check_in grid_fdesc "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name = 'description'" "0" "down dropped the description"
check_in grid_fdesc "SELECT count(*) FROM project_folders" "2" "down kept the folders"
apply_in grid_fdesc 0145_folder_descriptions.sql
apply_in grid_fdesc 0145_folder_descriptions.sql
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NULL" "2" "0145 re-applies, twice"
echo "==> 0145 folder descriptions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0146: proposals on the Büroablage, the trace, the CHECKs, the
# re-secured policy, and the DOWN.
#
# On a database of its own, migrated to 0145. A proposal is on a project
# exactly when it has one; a Büroablage proposal only moves Büroablage
# documents; the runtime role sees its own organization's Büroablage proposals
# and no other's.
# ---------------------------------------------------------------------------
echo "==> verifying the 0146 proposal shelves and their down migration on grid_pshelf"
migrate_until grid_pshelf 0145_folder_descriptions
sql_in grid_pshelf <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000146', 'org_0146', 'Ablage 0146', 'user_1', 'proj_0146');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000146', 'org_0146', 'aaaaaaaa-0000-4000-8000-000000000146', 'file_operation',
        '{"operation":"move","operations":[{"document":"a.pdf","target_folder":"Bescheide"}]}', 'piloti', 'user_1');
SQL
apply_in grid_pshelf 0146_proposal_shelves.sql
check_in grid_pshelf "SELECT scope || ':' || (origin_trace_id IS NULL)::text FROM proposed_changes" "project:true" "0146 puts every existing proposal on its project's shelf"
sql_in grid_pshelf <<'SQL'
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of, origin_trace_id)
VALUES ('c2c2c2c2-0000-4000-8000-000000000146', 'org_0146', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Norm.pdf","source":"buero","target_folder":"Normen"}],"basis":"name"}', 'piloti', 'user_1', 'abcdef0123456789abcdef0123456789'),
       ('c3c3c3c3-0000-4000-8000-000000000146', 'org_other', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Fremd.pdf","source":"buero","target_folder":"Fremd"}]}', 'piloti', 'user_9', NULL);
SQL
check_in grid_pshelf "SELECT count(*) FROM proposed_changes WHERE scope = 'archiv'" "2" "a Büroablage move is stored without a project"
P146="INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0146'"
refused_in grid_pshelf "$P146, NULL, 'regal', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_scope_known" "an unknown shelf was accepted"
refused_in grid_pshelf "$P146, NULL, 'project', 'file_operation', '{\"operation\":\"move\",\"operations\":[]}', 'piloti', 'user_1')" "proposed_changes_scope_owner" "a project proposal without its project was accepted"
refused_in grid_pshelf "$P146, 'aaaaaaaa-0000-4000-8000-000000000146', 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_scope_owner" "a Büroablage proposal naming a project was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage proposal of another kind was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"create_folder\",\"operations\":[{\"folder_name\":\"X\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage proposal that is not a move was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"projekt\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of a project document was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of an item without its shelf was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"},{\"document\":\"b.pdf\",\"source\":\"projekt\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move with one project item was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\"}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move without items was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of no items was accepted"
check_in grid_pshelf "SELECT pg_get_expr(polqual, polrelid) LIKE '%project_id IS NULL%' FROM pg_policy WHERE polname = 'grid_tenant_isolation' AND polrelid = 'proposed_changes'::regclass" "t" "0146 re-secures proposed_changes with the Büroablage arm"
check_in grid_pshelf "SELECT count(*) FROM pg_policy WHERE polrelid = 'proposed_changes'::regclass" "1" "proposed_changes keeps exactly one policy"
# The runtime role, inside one tenant: its own Büroablage proposal, not the other organization's.
RW146=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_pshelf -qtA \
  -c "SET grid.organization_id = 'org_0146'" \
  -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM proposed_changes WHERE scope = 'archiv'")
if [ "$RW146" != "c2c2c2c2-0000-4000-8000-000000000146" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_pshelf: the runtime role saw another organization's Büroablage proposal, or not its own (got: $RW146)" >&2
  exit 1
fi
apply_in grid_pshelf 0146_proposal_shelves.down.sql
check_in grid_pshelf "SELECT string_agg(id::text, ',') FROM proposed_changes" "c1c1c1c1-0000-4000-8000-000000000146" "down deleted the Büroablage proposals, and only those"
check_in grid_pshelf "SELECT count(*) FROM information_schema.columns WHERE table_name = 'proposed_changes' AND column_name IN ('scope', 'origin_trace_id')" "0" "down dropped the shelf and the trace"
refused_in grid_pshelf "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0146', NULL, 'file_operation', '{}', 'piloti', 'user_1')" "null value" "down left the project optional"
apply_in grid_pshelf 0146_proposal_shelves.sql
apply_in grid_pshelf 0146_proposal_shelves.sql
check_in grid_pshelf "SELECT count(*) FROM proposed_changes" "1" "0146 re-applies, twice"
echo "==> 0146 proposal shelves and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0148: a held document's reason as a typed verdict (ADR-0113), and
# its DOWN. The backfill converts each quarantined row's `quarantined:` message
# row by row and leaves a row whose message does not parse NULL without
# stopping; the CHECKs hold the column to an object with a `reasons` array and
# to quarantined rows, so the release that ends a quarantine must clear it; a
# decision records how many reasons the job left out.
# ---------------------------------------------------------------------------
echo "==> verifying the 0148 quarantine verdict, its backfill and the down migration on grid_qverdict"
migrate_until grid_qverdict 0147_push_subscriptions
sql_in grid_qverdict <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000148', 'org_0148', 'Verdict 0148', 'user_1', 'proj_0148');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash, screening_outcome, error_message) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'lohn.pdf', 'k/0148/lohn', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:lohn', 'quarantined',
   'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":2,"pages":[1,3]},{"kind":"iban","count":1,"pages":[2],"sample":"AT61 •••• •••• •••• 3201"}],"checked":"full","omitted":3}'),
  ('d2d2d2d2-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'kaputt.pdf', 'k/0148/kaputt', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:kaputt', 'quarantined',
   'quarantined:{not json'),
  ('d3d3d3d3-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'form.pdf', 'k/0148/form', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:form', 'quarantined',
   'quarantined:{"reasons":"none"}'),
  ('d4d4d4d4-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'plan.pdf', 'k/0148/plan', 'proj_0148', 'failed', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:plan', NULL,
   'quarantined:{"reasons":[],"checked":"full"}'),
  ('d5d5d5d5-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'brief.pdf', 'k/0148/brief', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:brief', 'quarantined',
   NULL);
INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, project_id, filename, reasons, uploaded_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000148', 'org_0148', 'd1d1d1d1-0000-4000-8000-000000000148', 'job-0148', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'lohn.pdf', 'term:Lohnzettel,iban', 'user_1');
SQL
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT quarantine->'reasons'->0->>'term' || ',' || (quarantine->>'omitted') || ',' || (quarantine->'reasons'->1->>'sample') FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148'" "Lohnzettel,3,AT61 •••• •••• •••• 3201" "the backfill stores a quarantined row's verdict as data"
check_in grid_qverdict "SELECT string_agg(filename, ',' ORDER BY filename) FROM documents WHERE organization_id = 'org_0148' AND quarantine IS NULL" "brief.pdf,form.pdf,kaputt.pdf,plan.pdf" "a message that is not JSON, a verdict of the wrong shape, a row that is not held and one with no message stay NULL"
check_in grid_qverdict "SELECT count(*) FROM documents WHERE organization_id = 'org_0148' AND error_message LIKE 'quarantined:%'" "4" "the backfill leaves every message for the builds that still read it"
check_in grid_qverdict "SELECT reasons_omitted FROM document_quarantine_decisions WHERE id = 'f1f1f1f1-0000-4000-8000-000000000148'" "0" "an existing decision left nothing out that it knew of"
refused_in grid_qverdict "UPDATE documents SET quarantine = '[]'::jsonb WHERE id = 'd5d5d5d5-0000-4000-8000-000000000148';" "documents_quarantine_shape_check" "a verdict that is not an object was accepted"
refused_in grid_qverdict "UPDATE documents SET quarantine = '{\"checked\":\"full\"}'::jsonb WHERE id = 'd5d5d5d5-0000-4000-8000-000000000148';" "documents_quarantine_shape_check" "a verdict without reasons was accepted"
refused_in grid_qverdict "UPDATE documents SET quarantine = '{\"reasons\":[]}'::jsonb WHERE id = 'd4d4d4d4-0000-4000-8000-000000000148';" "documents_quarantine_held_check" "a verdict on a row that is not quarantined was accepted"
refused_in grid_qverdict "UPDATE documents SET status = 'uploaded', screening_outcome = 'released', screening_released_hash = 'sha256:lohn', screening_released_by = 'user_2', screening_released_at = now() WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148';" "documents_quarantine_held_check" "a release that keeps the verdict was accepted"
sql_in grid_qverdict <<<"UPDATE documents SET status = 'uploaded', error_message = NULL, quarantine = NULL, screening_outcome = 'released', screening_released_hash = 'sha256:lohn', screening_released_by = 'user_2', screening_released_at = now() WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148';"
check_in grid_qverdict "SELECT status FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148'" "uploaded" "the release that clears the verdict passes the hold"
refused_in grid_qverdict "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by, reasons_omitted) VALUES ('org_0148', gen_random_uuid(), 'job-x', 'archiv', 'x.pdf', 'u', -1);" "document_quarantine_decisions_reasons_omitted_check" "a negative count of left-out reasons was accepted"
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT count(*) FROM documents WHERE organization_id = 'org_0148' AND quarantine IS NOT NULL" "0" "0148 re-applies and backfills no released row"
apply_in grid_qverdict 0148_document_quarantine_verdict.down.sql
check_in grid_qverdict "SELECT count(*) FROM information_schema.columns WHERE (table_name = 'documents' AND column_name = 'quarantine') OR (table_name = 'document_quarantine_decisions' AND column_name = 'reasons_omitted')" "0" "down dropped both columns"
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT count(*) FROM pg_constraint WHERE conname IN ('documents_quarantine_shape_check', 'documents_quarantine_held_check', 'document_quarantine_decisions_reasons_omitted_check')" "3" "0148 re-applies, twice"
echo "==> 0148 quarantine verdict and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0150: whom an Anmerkung or a reply mentions, the CHECKs, and the
# DOWN.
#
# On a database of its own, migrated to 0149. Every mark and reply written
# before mentions nobody; a mention list is an array of at most ten, on both
# tables; the down drops both columns and leaves the marks and their threads.
# ---------------------------------------------------------------------------
echo "==> verifying the 0150 mentions on marks and replies and their down migration on grid_mention"
migrate_until grid_mention 0149_piloti_wakes_document_idx
sql_in grid_mention <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000150', 'org_0150', 'Erwähnen 0150', 'user_1', 'proj_0150');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000150', 'org_0150', 'user_1', 'a.pdf', 'k/0150/a', 'proj_0150', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000150');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000150', 'org_0150', 'd1d1d1d1-0000-4000-8000-000000000150', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0150', 'f1f1f1f1-0000-4000-8000-000000000150', 'person', 'Vor 0150 geschrieben', 'user_2');
SQL
apply_in grid_mention 0150_annotation_mentions.sql
check_in grid_mention "SELECT (SELECT string_agg(mentions::text, ',') FROM document_annotations) || '|' || (SELECT string_agg(mentions::text, ',') FROM document_annotation_replies)" "[]|[]" "a mark and a reply written before 0150 mention nobody"
sql_in grid_mention <<<"UPDATE document_annotations SET mentions = '[{\"targetId\":\"user_2\",\"display\":\"Anna Berger\"}]' WHERE number = 1"
sql_in grid_mention <<<"UPDATE document_annotation_replies SET mentions = '[{\"targetId\":\"agent:piloti\",\"display\":\"Piloti\"}]'"
check_in grid_mention "SELECT mentions->0->>'display' FROM document_annotations WHERE number = 1" "Anna Berger" "a mark keeps whom it mentions"
refused_in grid_mention "UPDATE document_annotations SET mentions = '{\"targetId\":\"user_2\"}' WHERE number = 1" "document_annotations_mentions_bounded" "a mark's mentions that are not an array were accepted"
refused_in grid_mention "UPDATE document_annotations SET mentions = (SELECT jsonb_agg(jsonb_build_object('targetId', 'user_' || n, 'display', 'P' || n)) FROM generate_series(1, 11) AS n) WHERE number = 1" "document_annotations_mentions_bounded" "a mark mentioning eleven people was accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = '\"user_2\"'" "document_annotation_replies_mentions_bounded" "a reply's mentions that are not an array were accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = (SELECT jsonb_agg(jsonb_build_object('targetId', 'user_' || n, 'display', 'P' || n)) FROM generate_series(1, 11) AS n)" "document_annotation_replies_mentions_bounded" "a reply mentioning eleven people was accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = NULL" "null value" "a reply without a mention list was accepted"
apply_in grid_mention 0150_annotation_mentions.down.sql
check_in grid_mention "SELECT count(*) FROM information_schema.columns WHERE column_name = 'mentions' AND table_name IN ('document_annotations', 'document_annotation_replies')" "0" "down dropped both columns"
check_in grid_mention "SELECT (SELECT count(*) FROM document_annotations) || ':' || (SELECT count(*) FROM document_annotation_replies)" "1:1" "down left the marks and their threads"
apply_in grid_mention 0150_annotation_mentions.sql
apply_in grid_mention 0150_annotation_mentions.sql
check_in grid_mention "SELECT string_agg(mentions::text, ',') FROM document_annotation_replies" "[]" "0150 re-applies, twice"
echo "==> 0150 mentions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0151: a mark carried on to the document that replaced its own, the
# index the daily due reminder reads by, and the DOWN.
#
# On a database of its own, migrated to 0150. A mark written before carries
# from nothing; a carried mark points back at its source, never at itself;
# one source is carried once, whatever raced; deleting the source leaves the
# carried mark standing without its link; the down drops the column and the
# indexes and leaves both marks.
# ---------------------------------------------------------------------------
echo "==> verifying the 0151 carried marks and their down migration on grid_carry"
migrate_until grid_carry 0150_annotation_mentions
sql_in grid_carry <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000151', 'org_0151', 'Weitertragen 0151', 'user_1', 'proj_0151');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000151', 'org_0151', 'user_1', 'Index B.pdf', 'k/0151/b', 'proj_0151', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000151'),
       ('d2d2d2d2-0000-4000-8000-000000000151', 'org_0151', 'user_1', 'Index C.pdf', 'k/0151/c', 'proj_0151', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000151');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, assignee_user_id, due_on)
VALUES ('f1f1f1f1-0000-4000-8000-000000000151', 'org_0151', 'd1d1d1d1-0000-4000-8000-000000000151', 4, 1, 'point', 0.5, 0.5, 'defect', 'Brüstung', 'person', 'open', 'user_1', 'user_2', '2026-10-24');
SQL
apply_in grid_carry 0151_annotation_carry_and_due.sql
check_in grid_carry "SELECT coalesce(carried_from_id::text, 'null') FROM document_annotations" "null" "a mark written before 0151 carries from nothing"
sql_in grid_carry <<'SQL'
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, carried_from_id)
VALUES ('f2f2f2f2-0000-4000-8000-000000000151', 'org_0151', 'd2d2d2d2-0000-4000-8000-000000000151', 1, 1, 'point', 0.5, 0.5, 'defect', 'Brüstung', 'person', 'open', 'user_1', 'f1f1f1f1-0000-4000-8000-000000000151');
SQL
C150="INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, carried_from_id) VALUES ('org_0151', 'd2d2d2d2-0000-4000-8000-000000000151'"
refused_in grid_carry "$C150, 2, 1, 'point', 0.5, 0.5, 'defect', 'x', 'person', 'open', 'user_1', 'f1f1f1f1-0000-4000-8000-000000000151')" "uniq_document_annotations_carried_from" "a mark was carried twice"
refused_in grid_carry "UPDATE document_annotations SET carried_from_id = id WHERE number = 1" "document_annotations_carried_from_other" "a mark was carried from itself"
refused_in grid_carry "$C150, 3, 1, 'point', 0.5, 0.5, 'defect', 'x', 'person', 'open', 'user_1', 'f9f9f9f9-0000-4000-8000-000000000151')" "document_annotations_carried_from_fkey" "a mark was carried from a mark that does not exist"
check_in grid_carry "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_document_annotations_due'" "1" "0151 builds the due index"
sql_in grid_carry <<<"DELETE FROM document_annotations WHERE id = 'f1f1f1f1-0000-4000-8000-000000000151'"
check_in grid_carry "SELECT number || ':' || coalesce(carried_from_id::text, 'null') FROM document_annotations" "1:null" "deleting the source leaves the carried mark without its link"
apply_in grid_carry 0151_annotation_carry_and_due.down.sql
check_in grid_carry "SELECT count(*) FROM information_schema.columns WHERE column_name = 'carried_from_id' AND table_name = 'document_annotations'" "0" "down dropped the column"
check_in grid_carry "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_document_annotations_due', 'uniq_document_annotations_carried_from')" "0" "down dropped both indexes"
check_in grid_carry "SELECT count(*) FROM document_annotations" "1" "down left the marks"
apply_in grid_carry 0151_annotation_carry_and_due.sql
apply_in grid_carry 0151_annotation_carry_and_due.sql
check_in grid_carry "SELECT coalesce(carried_from_id::text, 'null') FROM document_annotations" "null" "0151 re-applies, twice"
echo "==> 0151 carried marks and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0152: when a reply was last changed by its author, its CHECK, and
# the DOWN.
#
# On a database of its own, migrated to 0151. A reply written before was never
# edited; an edit stamped by the database's clock passes; an edit before the
# reply was written is refused; the down drops the column and leaves the
# reply with its words.
# ---------------------------------------------------------------------------
echo "==> verifying the 0152 reply edits and their down migration on grid_reply_edit"
migrate_until grid_reply_edit 0151_annotation_carry_and_due
sql_in grid_reply_edit <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000152', 'org_0152', 'Bearbeiten 0152', 'user_1', 'proj_0152');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000152', 'org_0152', 'user_1', 'a.pdf', 'k/0152/a', 'proj_0152', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000152');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000152', 'org_0152', 'd1d1d1d1-0000-4000-8000-000000000152', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotation_replies (id, organization_id, annotation_id, author_kind, body, created_by)
VALUES ('e1e1e1e1-0000-4000-8000-000000000152', 'org_0152', 'f1f1f1f1-0000-4000-8000-000000000152', 'person', 'Vor 0152 geschrieben', 'user_2');
SQL
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
check_in grid_reply_edit "SELECT coalesce(edited_at::text, 'null') FROM document_annotation_replies" "null" "a reply written before 0152 was never edited"
sql_in grid_reply_edit <<<"UPDATE document_annotation_replies SET body = 'Nachher', edited_at = now()"
check_in grid_reply_edit "SELECT body || ':' || (edited_at IS NOT NULL)::text FROM document_annotation_replies" "Nachher:true" "an edit stamped by the database's clock passes"
refused_in grid_reply_edit "UPDATE document_annotation_replies SET edited_at = created_at - interval '1 second'" "document_annotation_replies_edited_after_created" "an edit before the reply was written was accepted"
apply_in grid_reply_edit 0152_annotation_reply_edits.down.sql
check_in grid_reply_edit "SELECT count(*) FROM information_schema.columns WHERE column_name = 'edited_at' AND table_name = 'document_annotation_replies'" "0" "down dropped the column"
check_in grid_reply_edit "SELECT body FROM document_annotation_replies" "Nachher" "down left the reply with its words"
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
check_in grid_reply_edit "SELECT coalesce(edited_at::text, 'null') FROM document_annotation_replies" "null" "0152 re-applies, twice"
echo "==> 0152 reply edits and down migration verified"

# ---------------------------------------------------------------------------
# On a database of its own, migrated to 0156. An intake written before 0157
# has opened nothing; a reading's files are an array and nothing else; the
# down drops the column and leaves the intake; the up re-applies, twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0157 reading files and their down migration on grid_rfiles"
migrate_until grid_rfiles 0156_organization_default_locale_unset
sql_in grid_rfiles <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000156', 'org_0156', 'Erfassung 0156', 'user_1', 'proj_0156');
INSERT INTO project_intakes (organization_id, project_id, created_by, status, job_id, requested_by)
VALUES ('org_0156', 'aaaaaaaa-0000-4000-8000-000000000156', 'user_1', 'reading', 'job_0156', 'user_1');
SQL
apply_in grid_rfiles 0157_intake_reading_files.sql
check_in grid_rfiles "SELECT reading_files::text FROM project_intakes" "[]" "an intake written before 0156 has opened nothing"
sql_in grid_rfiles <<<"UPDATE project_intakes SET reading_files = '[\"Einreichplan.pdf\"]'::jsonb"
check_in grid_rfiles "SELECT reading_files->>0 FROM project_intakes" "Einreichplan.pdf" "a reading's opened files are stored"
refused_in grid_rfiles "UPDATE project_intakes SET reading_files = '{\"a\":1}'::jsonb" "project_intakes_reading_files_array" "reading files that are not an array were accepted"
apply_in grid_rfiles 0157_intake_reading_files.down.sql
check_in grid_rfiles "SELECT count(*) FROM information_schema.columns WHERE column_name = 'reading_files' AND table_name = 'project_intakes'" "0" "down dropped the column"
check_in grid_rfiles "SELECT status FROM project_intakes" "reading" "down left the intake"
apply_in grid_rfiles 0157_intake_reading_files.sql
apply_in grid_rfiles 0157_intake_reading_files.sql
check_in grid_rfiles "SELECT reading_files::text FROM project_intakes" "[]" "0156 re-applies, twice"
echo "==> 0157 reading files and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0163: the names stored in a message's metadata become English, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0163, seeded with one
# assistant message that holds every family the migration rewrites in its OLD
# spelling (findings, a callout, the run ledger, citations, the Herleitung's
# lanes and locator event, quote stamps, cards and a surface), one that is
# already English, and one with an old-looking word on a path the migration does
# not own. The up rewrites exactly the first, a second run changes nothing, the
# down restores the old spellings byte for byte on those paths, and the up
# re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0163 message metadata names and their down migration on grid_msgnames"
migrate_before grid_msgnames 0163_message_metadata_english
sql_in grid_msgnames <<'SQL'
INSERT INTO conversations (id, organization_id, created_by) VALUES ('s_0162', 'org_0162', 'user_1');
INSERT INTO messages (id, conversation_id, organization_id, role, content, metadata) VALUES
  ('a0000000-0000-4000-8000-000000000162', 's_0162', 'org_0162', 'assistant', 'Bericht', '{
    "findings": {"v": 1, "items": [
      {"requirement": "R", "status": "nicht_erfuellt", "grounding": "abgeleitet"},
      {"requirement": "S", "status": "offen", "grounding": "offen"},
      {"requirement": "T", "grounding": "belegt"}]},
    "answerMeta": {"v": 1, "callout": {"kind": "frist", "text": "Binnen sechs Wochen."}},
    "run_ledger": {"runId": "r1", "status": "laeuft",
      "phases": [{"phase": "planen", "startedAt": "2026-01-01T00:00:00.000Z", "endedAt": "2026-01-01T00:01:00.000Z"},
                 {"phase": "recherchieren", "startedAt": "2026-01-01T00:01:00.000Z"}],
      "steps": [{"id": "runde-1", "phase": "recherchieren", "intent": "x", "startedAt": "2026-01-01T00:01:00.000Z", "docs": []}],
      "error": {"reason": "x", "completedBefore": ["planen"]},
      "grundlage": [{"name": "a.pdf", "loci": []}],
      "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:01:00.000Z"},
    "citations": {"v": 1, "sources": [
      {"content": "c", "kind": "baurecht", "lane": "baurecht_oib_leitfaden", "binding_status": "verbindlich_erklaert", "rank": "landesgesetz", "punkt": "3.5.2", "shelf": "archiv"},
      {"content": "d", "kind": "projekt", "lane": "projekt", "binding_status": "unbekannt"}]},
    "provenance": {"degradedReasons": ["grundlage_unread", "no_report_file"],
      "thinkingSteps": [
        {"id": "s1", "userMessageId": "u", "kind": "sources", "traceLanes": [{"key": "buero_piloti", "label": "x", "kind": "buero", "hitCount": 1, "sources": [], "signal": "office"}]},
        {"id": "s2", "userMessageId": "u", "kind": "retrieval", "turnEvent": {"key": "status.retrieval.punkt", "values": {"document": "D", "punkt": "3.1"}}},
        {"id": "s3", "userMessageId": "u", "kind": "retrieval", "turnEvent": {"key": "status.retrieval.plain", "values": {"punkt": "kept"}}}],
      "retrievalLedger": [{"index": 0, "key": "status.retrieval.punkt"}],
      "quoteStamps": [{"text": "q", "status": "verbatim", "punkt": "3.1"}]},
    "cards": [
      {"type": "fire_access_plan", "aufstellflaeche": {"width": 1}, "gebaeudeklasse": "GK 4"},
      {"type": "guardrail_check", "context": "dachterrasse"},
      {"type": "building_section", "markers": [{"label": "F", "height_m": 1, "kind": "fluchtniveau"}, {"label": "G", "height_m": 2, "kind": "threshold"}]},
      {"type": "document_draft", "path": "/entwuerfe/a.md"},
      {"type": "document_grid", "documents": [{"file_name": "a", "source": "buero"}]},
      {"type": "surface", "components": [{"id": "root", "component": "Column", "children": ["g"]}, {"id": "g", "component": "guardrail_check", "context": "balkon"}, {"id": "t", "component": "Text", "text": "x"}]},
      {"type": "calculation", "title": "bleibt", "status": "offen"}]
  }'),
  ('a0000000-0000-4000-8000-000000000163', 's_0162', 'org_0162', 'assistant', 'Neu', '{
    "findings": {"v": 1, "items": [{"requirement": "R", "status": "open", "grounding": "open"}]},
    "run_ledger": {"runId": "r2", "status": "done", "phases": [{"phase": "filed", "startedAt": "2026-01-01T00:00:00.000Z"}], "steps": [], "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"},
    "citations": {"v": 1, "sources": [{"content": "c", "kind": "building_law", "lane": "building_law_oib", "clause": "3.5.2"}]}
  }'),
  ('a0000000-0000-4000-8000-000000000164', 's_0162', 'org_0162', 'assistant', 'Fremd', '{
    "note": {"status": "offen", "kind": "baurecht"},
    "cards": [{"type": "calculation", "title": "Rechenweg", "kind": "projekt", "status": "erfuellt"}]
  }'),
  ('a0000000-0000-4000-8000-000000000165', 's_0162', 'org_0162', 'user', 'Frage', NULL);
INSERT INTO citation_events (organization_id, conversation_id, turn_id, agent, kind, severity, detail) VALUES
  ('org_0162', 's_0162', 't1', 'shallow', 'turn_verified', 'info', '{"lanes": {"baurecht_oib": 2, "projekt": 1, "web": 3}, "origins": {"kb": 3}}');
SQL
OLD_0162=$(cat <<'SQL'
SELECT md5(string_agg(coalesce(metadata::text, '-'), '|' ORDER BY id)) FROM messages WHERE id <> 'a0000000-0000-4000-8000-000000000163'
SQL
)
BEFORE_0162=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_msgnames -tAc "$OLD_0162")
apply_in grid_msgnames 0163_message_metadata_english.sql
M_0162="SELECT metadata FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'"
check_in grid_msgnames "SELECT (metadata @> '{\"findings\": {\"items\": [{\"status\": \"not_met\", \"grounding\": \"derived\"}, {\"status\": \"open\", \"grounding\": \"open\"}, {\"grounding\": \"sourced\"}]}}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "true" "0163 rewrites a finding's status and grounding"
check_in grid_msgnames "SELECT metadata #>> '{answerMeta,callout,kind}' FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "deadline" "0163 rewrites a callout kind"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{run_ledger,phases,0,phase}') || ',' || (metadata #>> '{run_ledger,phases,1,phase}') || ',' || (metadata #>> '{run_ledger,steps,0,phase}') || ',' || (metadata #>> '{run_ledger,error,completedBefore,0}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "running,planning,researching,researching,planning" "0163 rewrites the run ledger's status and phases"
check_in grid_msgnames "SELECT ((metadata -> 'run_ledger') ? 'grundlage')::text || ',' || (metadata #>> '{run_ledger,basis,0,name}') || ',' || (metadata #>> '{run_ledger,steps,0,id}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "false,a.pdf,runde-1" "0163 renames the ledger's basis key and leaves the step id"
check_in grid_msgnames "SELECT (metadata #>> '{citations,sources,0,kind}') || ',' || (metadata #>> '{citations,sources,0,lane}') || ',' || (metadata #>> '{citations,sources,0,binding_status}') || ',' || (metadata #>> '{citations,sources,0,rank}') || ',' || (metadata #>> '{citations,sources,0,clause}') || ',' || ((metadata #> '{citations,sources,0}') ? 'punkt')::text || ',' || (metadata #>> '{citations,sources,0,shelf}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "building_law,building_law_oib_guide,declared_binding,state_law,3.5.2,false,archiv" "0163 rewrites a citation's kind, lane, binding status, rank and Punkt, and leaves its shelf"
check_in grid_msgnames "SELECT (metadata #>> '{citations,sources,1,kind}') || ',' || (metadata #>> '{citations,sources,1,lane}') || ',' || (metadata #>> '{citations,sources,1,binding_status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "project,project,unknown" "0163 rewrites a project citation"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,degradedReasons}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '["basis_unread", "no_report_file"]' "0163 rewrites a degraded reason and keeps the others"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,thinkingSteps,0,traceLanes,0,key}') || ',' || (metadata #>> '{provenance,thinkingSteps,0,traceLanes,0,kind}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "office_piloti,office" "0163 rewrites a trace lane's key and kind"
check_in grid_msgnames "SELECT (metadata #> '{provenance,thinkingSteps,1,turnEvent}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '{"key": "status.retrieval.clause", "values": {"clause": "3.1", "document": "D"}}' "0163 renames the locator event's key and its value"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,thinkingSteps,2,turnEvent,values,punkt}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "kept" "0163 leaves a value named punkt on another event"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,retrievalLedger,0,key}') || ',' || (metadata #>> '{provenance,quoteStamps,0,clause}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "status.retrieval.clause,3.1" "0163 rewrites the ledger's key and a quote stamp's Punkt"
check_in grid_msgnames "SELECT (metadata #>> '{cards,0,staging_area,width}') || ',' || (metadata #>> '{cards,0,building_class}') || ',' || ((metadata #> '{cards,0}') ? 'aufstellflaeche')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "1,GK 4,false" "0163 renames a fire access card's fields"
check_in grid_msgnames "SELECT (metadata #>> '{cards,1,context}') || ',' || (metadata #>> '{cards,2,markers,0,kind}') || ',' || (metadata #>> '{cards,2,markers,1,kind}') || ',' || (metadata #>> '{cards,3,path}') || ',' || (metadata #>> '{cards,4,documents,0,source}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "roof_terrace,escape_level,threshold,/drafts/a.md,office" "0163 rewrites a railing context, a section marker, a draft path and a document source"
check_in grid_msgnames "SELECT (metadata #>> '{cards,5,components,1,context}') || ',' || (metadata #>> '{cards,5,components,2,text}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "balcony,x" "0163 rewrites a card inside a surface"
check_in grid_msgnames "SELECT (metadata #> '{cards,6}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '{"type": "calculation", "title": "bleibt", "status": "offen"}' "0163 leaves a card it has no rule for"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{findings,items,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000163'" "done,open" "0163 leaves English metadata alone"
check_in grid_msgnames "SELECT (metadata #> '{note}')::text || (metadata #>> '{cards,0,kind}') || (metadata #>> '{cards,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000164'" '{"kind": "baurecht", "status": "offen"}projekterfuellt' "0163 leaves an old-looking word on a path it does not own"
check_in grid_msgnames "SELECT count(*) FROM messages WHERE metadata IS NULL" "1" "0163 leaves a message without metadata alone"
check_in grid_msgnames "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(detail -> 'lanes') k) FROM citation_events WHERE conversation_id = 's_0162'" "building_law_oib,project,web" "0163 renames the lane keys of a citation event and keeps their counts"
AFTER_ONCE_0162=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_msgnames -tAc "$OLD_0162")
apply_in grid_msgnames 0163_message_metadata_english.sql
check_in grid_msgnames "$OLD_0162" "$AFTER_ONCE_0162" "0163 changes nothing the second time"
apply_in grid_msgnames 0163_message_metadata_english.down.sql
check_in grid_msgnames "$OLD_0162" "$BEFORE_0162" "down restores every stored byte of the metadata the migration took"
check_in grid_msgnames "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(detail -> 'lanes') k) FROM citation_events WHERE conversation_id = 's_0162'" "baurecht_oib,projekt,web" "down restores a citation event's lane keys"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{findings,items,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000163'" "fertig,offen" "down turns a message the new build wrote back into German too"
apply_in grid_msgnames 0163_message_metadata_english.sql
apply_in grid_msgnames 0163_message_metadata_english.sql
check_in grid_msgnames "$OLD_0162" "$AFTER_ONCE_0162" "0163 re-applies, twice"
echo "==> 0163 message metadata names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0164: the research plan's stored keys and values become English, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0164. A plan preview
# whose fence holds the old keys and values (and prose OUTSIDE the fence that
# mentions the same words), the reader's `approve {…}` reply as a user message
# and as the card's stored answer, a task, a standing task and a run that froze
# the reader's documents, and a Büroablage proposal whose payload names its
# shelf. The up rewrites the fence and the reply as text (nothing else in the
# message), the documents' keys, the payloads and the CHECK that reads them; a
# second run changes nothing; the down restores the bytes; the up re-applies
# twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0164 plan names and their down migration on grid_plannames"
migrate_before grid_plannames 0164_plan_documents_english
sql_in grid_plannames <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000163', 'org_0163', 'Plan 0164', 'user_1', 'proj_0163');
INSERT INTO conversations (id, organization_id, created_by, project_id) VALUES ('s_0163', 'org_0163', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000163');
INSERT INTO messages (id, conversation_id, organization_id, role, content, metadata) VALUES
  ('a0000000-0000-4000-8000-000000000263', 's_0163', 'org_0163', 'assistant',
   E'**Research Plan Preview**\n\nDie grundlage ist unklar: "grundlage": kein Schluessel hier.\n\n```plan_json\n{"title": "Pruefung \\"grundlage\\": x", "sections": ["A"], "genre": "pruefbericht", "depth": "kurzpruefung", "grundlage": ["Einreichplan.pdf"], "ausgeschlossen": [], "unterlagen": [{"name": "Einreichplan.pdf"}]}\n```\n\n---\nReply **approve**',
   NULL),
  ('a0000000-0000-4000-8000-000000000264', 's_0163', 'org_0163', 'user',
   'approve {"sections":["A"],"genre":"aktenvermerk","depth":"gutachten","grundlage":["a.pdf"],"ausgeschlossen":["b.pdf"],"data_sources":["knowledge_base"]}', NULL),
  ('a0000000-0000-4000-8000-000000000265', 's_0163', 'org_0163', 'assistant', 'Plan', '{"promptState": {"response": "approve {\"genre\":\"vergleich\",\"grundlage\":[]}", "respondedAt": "2026-01-01T00:00:00.000Z"}}'),
  ('a0000000-0000-4000-8000-000000000266', 's_0163', 'org_0163', 'assistant', E'Ein ```plan_json\n{"genre": "report", "basis": []}\n```', NULL),
  ('a0000000-0000-4000-8000-000000000267', 's_0163', 'org_0163', 'user', 'Bitte "grundlage": pruefen, genre pruefbericht', NULL);
INSERT INTO tasks (id, organization_id, project_id, kind, title, plan, requester_user_id) VALUES
  ('eeeeeeee-0000-4000-8000-000000000163', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [{"name": "a.pdf", "shelf": "project"}], "ausgeschlossen": [{"name": "b.pdf"}]}}', 'user_1'),
  ('eeeeeeee-0000-4000-8000-000000000164', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Ohne',
   '{"prompt": "x", "skill": {}, "dataSources": null}', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [{"name": "a.pdf"}], "ausgeschlossen": []}}', 'user_1', 'manual');
INSERT INTO task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot) VALUES
  ('org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [], "ausgeschlossen": [{"name": "c.pdf"}]}}', 'user_1', 'delegated', 'succeeded', '{}');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('c1c1c1c1-0000-4000-8000-000000000163', 'org_0163', NULL, 'archiv', 'file_operation',
   '{"operation": "move", "operations": [{"document": "a.pdf", "source": "buero", "target_folder": "x"}, {"document": "b.pdf", "source": "buero"}]}', 'piloti', 'user_1'),
  ('c1c1c1c1-0000-4000-8000-000000000164', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'project', 'file_operation',
   '{"operation": "move", "operations": [{"document": "c.pdf", "source": "projekt", "target_folder": "x"}]}', 'piloti', 'user_1');
SQL
PLAN_0163="SELECT md5(coalesce((SELECT string_agg(content, '|' ORDER BY id) FROM messages WHERE id <> 'a0000000-0000-4000-8000-000000000266'), '') || (SELECT string_agg(coalesce(metadata::text, '-'), '|' ORDER BY id) FROM messages) || (SELECT string_agg(plan::text, '|' ORDER BY title, id) FROM tasks) || (SELECT string_agg(plan::text, '|') FROM task_definitions) || (SELECT string_agg(plan::text, '|') FROM task_runs) || (SELECT string_agg(payload::text, '|' ORDER BY id) FROM proposed_changes))"
BEFORE_0163=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_plannames -tAc "$PLAN_0163")
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000263'" $'**Research Plan Preview**\n\nDie grundlage ist unklar: "grundlage": kein Schluessel hier.\n\n```plan_json\n{"title": "Pruefung \\"grundlage\\": x", "sections": ["A"], "genre": "inspection_report", "depth": "quick_check", "basis": ["Einreichplan.pdf"], "excluded": [], "documents": [{"name": "Einreichplan.pdf"}]}\n```\n\n---\nReply **approve**' "0164 rewrites the keys and values inside the fence and nothing outside it, nor an escaped quote inside a title"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000264'" 'approve {"sections":["A"],"genre":"file_note","depth":"expert_report","basis":["a.pdf"],"excluded":["b.pdf"],"data_sources":["knowledge_base"]}' "0164 rewrites an approval reply"
check_in grid_plannames "SELECT metadata #>> '{promptState,response}' FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000265'" 'approve {"genre":"comparison","basis":[]}' "0164 rewrites the answered card's reply"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000266'" $'Ein ```plan_json\n{"genre": "report", "basis": []}\n```' "0164 leaves a plan that is already English"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000267'" 'Bitte "grundlage": pruefen, genre pruefbericht' "0164 leaves a message that has neither a fence nor an approval"
check_in grid_plannames "SELECT (plan -> 'documents')::text FROM tasks WHERE id = 'eeeeeeee-0000-4000-8000-000000000163'" '{"basis": [{"name": "a.pdf", "shelf": "project"}], "excluded": [{"name": "b.pdf"}]}' "0164 renames the keys of a task's documents"
check_in grid_plannames "SELECT (plan ? 'documents')::text FROM tasks WHERE id = 'eeeeeeee-0000-4000-8000-000000000164'" "false" "0164 does not invent documents on a task that named none"
check_in grid_plannames "SELECT ((SELECT plan -> 'documents' FROM task_definitions)::text) || ((SELECT plan -> 'documents' FROM task_runs)::text)" '{"basis": [{"name": "a.pdf"}], "excluded": []}{"basis": [], "excluded": [{"name": "c.pdf"}]}' "0164 renames the keys on a standing task and on a run"
check_in grid_plannames "SELECT (payload #>> '{operations,0,source}') || ',' || (payload #>> '{operations,1,source}') FROM proposed_changes WHERE id = 'c1c1c1c1-0000-4000-8000-000000000163'" "office,office" "0164 rewrites a Büroablage proposal's sources"
check_in grid_plannames "SELECT payload #>> '{operations,0,source}' FROM proposed_changes WHERE id = 'c1c1c1c1-0000-4000-8000-000000000164'" "project" "0164 rewrites a project proposal's source"
refused_in grid_plannames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0163', NULL, 'archiv', 'file_operation', '{\"operation\": \"move\", \"operations\": [{\"document\": \"x.pdf\", \"source\": \"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "the CHECK still accepts the old source"
check_in grid_plannames "SELECT convalidated::text FROM pg_constraint WHERE conname = 'proposed_changes_archiv_move' AND conrelid = 'proposed_changes'::regclass" "true" "the CHECK is validated"
sql_in grid_plannames <<'SQL'
INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('org_0163', NULL, 'archiv', 'file_operation', '{"operation": "move", "operations": [{"document": "x.pdf", "source": "office"}]}', 'piloti', 'user_1');
SQL
sql_in grid_plannames <<'SQL'
DELETE FROM proposed_changes WHERE payload #>> '{operations,0,document}' = 'x.pdf';
SQL
AFTER_ONCE_0163=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_plannames -tAc "$PLAN_0163")
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "$PLAN_0163" "$AFTER_ONCE_0163" "0164 changes nothing the second time"
apply_in grid_plannames 0164_plan_documents_english.down.sql
check_in grid_plannames "$PLAN_0163" "$BEFORE_0163" "down restores every stored byte of what the migration took"
refused_in grid_plannames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0163', NULL, 'archiv', 'file_operation', '{\"operation\": \"move\", \"operations\": [{\"document\": \"x.pdf\", \"source\": \"office\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "down put the CHECK back on the old source"
apply_in grid_plannames 0164_plan_documents_english.sql
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "$PLAN_0163" "$AFTER_ONCE_0163" "0164 re-applies, twice"
echo "==> 0164 plan names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0165: the Fassung table, a constraint and an inbox type take English
# names, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0165. The announcement
# table is renamed with its key and its policy (still one, still tenant-scoped);
# the Büroablage CHECK keeps refusing what it refused under its new name; an
# inbox row of the old type moves to the new one together with its group key,
# and a row of another type is left alone. The down puts every name back, and
# the up re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0165 revision names and their down migration on grid_revnames"
migrate_before grid_revnames 0165_revision_names
sql_in grid_revnames <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000164', 'org_0165', 'Namen 0165', 'user_1', 'proj_0165');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000164', 'org_0165', 'user_1', 'neu.pdf', 'k/0165/neu', 'proj_0165', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000164');
INSERT INTO document_fassung_announcements (organization_id, document_id, anchor_id) VALUES
  ('org_0165', 'd1d1d1d1-0000-4000-8000-000000000164', 'd2d2d2d2-0000-4000-8000-000000000164'),
  ('org_other', 'd1d1d1d1-0000-4000-8000-000000000164', 'd3d3d3d3-0000-4000-8000-000000000164');
INSERT INTO inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id, anchor_id, group_key, actionable) VALUES
  ('org_0165', 'user_1', 'document.new_fassung', 'document', 'd1d1d1d1-0000-4000-8000-000000000164', 'd2d2d2d2-0000-4000-8000-000000000164',
   'document.new_fassung:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164', false),
  ('org_0165', 'user_1', 'job.completed', 'document', 'd1d1d1d1-0000-4000-8000-000000000164', NULL,
   'job.completed:document:d1d1d1d1-0000-4000-8000-000000000164', false);
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000164', 'org_0165', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Norm.pdf","source":"office","target_folder":"Normen"}]}', 'piloti', 'user_1');
SQL
apply_in grid_revnames 0165_revision_names.sql
check_in grid_revnames "SELECT (to_regclass('document_revision_announcements') IS NOT NULL AND to_regclass('document_fassung_announcements') IS NULL)::text" "true" "0165 renames the announcement table"
check_in grid_revnames "SELECT count(*) FROM document_revision_announcements" "2" "0165 keeps the announcements"
check_in grid_revnames "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'document_revision_announcements'::regclass" "document_revision_announcements_document_fkey,document_revision_announcements_pk" "0165 renames the key and the foreign key"
check_in grid_revnames "SELECT relrowsecurity::text || ':' || (SELECT count(*) FROM pg_policy WHERE polrelid = 'document_revision_announcements'::regclass)::text FROM pg_class WHERE relname = 'document_revision_announcements'" "true:1" "the renamed table is secured by exactly one policy"
RW164=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_revnames -qtA \
  -c "SET grid.organization_id = 'org_0165'" \
  -c "SELECT count(*) FROM document_revision_announcements")
if [ "$RW164" != "1" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_revnames: the runtime role saw another organization's announcements, or not its own (got: $RW164)" >&2
  exit 1
fi
check_in grid_revnames "SELECT string_agg(type, ',' ORDER BY type) FROM inbox_items" "document.new_revision,job.completed" "0165 gives the inbox row the new type and leaves the others"
check_in grid_revnames "SELECT group_key FROM inbox_items WHERE type = 'document.new_revision'" "document.new_revision:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164" "0165 moves the group key with the type"
check_in grid_revnames "SELECT (count(*) FILTER (WHERE conname = 'proposed_changes_office_shelf_move') - count(*) FILTER (WHERE conname = 'proposed_changes_archiv_move'))::text FROM pg_constraint WHERE conrelid = 'proposed_changes'::regclass" "1" "0165 renames the Büroablage constraint"
refused_in grid_revnames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0165', NULL, 'archiv', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_office_shelf_move" "the renamed constraint still refuses a Büroablage proposal that is not a move"
apply_in grid_revnames 0165_revision_names.down.sql
check_in grid_revnames "SELECT (to_regclass('document_fassung_announcements') IS NOT NULL AND to_regclass('document_revision_announcements') IS NULL)::text" "true" "down gives the announcement table its name back"
check_in grid_revnames "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'document_fassung_announcements'::regclass" "document_fassung_announcements_document_fkey,document_fassung_announcements_pk" "down restores the key names"
check_in grid_revnames "SELECT string_agg(type, ',' ORDER BY type) FROM inbox_items" "document.new_fassung,job.completed" "down restores the inbox type"
check_in grid_revnames "SELECT group_key FROM inbox_items WHERE type = 'document.new_fassung'" "document.new_fassung:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164" "down restores the group key"
check_in grid_revnames "SELECT count(*) FROM pg_constraint WHERE conname = 'proposed_changes_archiv_move' AND conrelid = 'proposed_changes'::regclass" "1" "down restores the Büroablage constraint name"
apply_in grid_revnames 0165_revision_names.sql
apply_in grid_revnames 0165_revision_names.sql
check_in grid_revnames "SELECT count(*) FROM document_revision_announcements" "2" "0165 re-applies, twice"
echo "==> 0165 revision names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0166: English kinds on permit records and their requirements, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0166. Every German kind
# is rewritten and the new CHECK refuses the old spelling; `nachforderung` is
# the one word both tables share and becomes `information_request` in both.
# ---------------------------------------------------------------------------
echo "==> verifying the 0166 permit kinds and their down migration on grid_permit_kinds"
migrate_before grid_permit_kinds 0166_permit_kinds
sql_in grid_permit_kinds <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000165', 'org_0166', 'Bescheide 0166', 'user_1', 'proj_0166');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'a.pdf', 'k/0166/a', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d2d2d2d2-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'b.pdf', 'k/0166/b', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d3d3d3d3-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'c.pdf', 'k/0166/c', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d4d4d4d4-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'd.pdf', 'k/0166/d', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165');
INSERT INTO permit_records (id, organization_id, project_id, document_id, collection_name, file_name, kind, model) VALUES
  ('e1e1e1e1-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd1d1d1d1-0000-4000-8000-000000000165', 'proj_0166', 'a.pdf', 'bewilligung', 'm'),
  ('e2e2e2e2-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd2d2d2d2-0000-4000-8000-000000000165', 'proj_0166', 'b.pdf', 'nachforderung', 'm'),
  ('e3e3e3e3-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd3d3d3d3-0000-4000-8000-000000000165', 'proj_0166', 'c.pdf', 'ablehnung', 'm'),
  ('e4e4e4e4-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd4d4d4d4-0000-4000-8000-000000000165', 'proj_0166', 'd.pdf', 'sonstiges', 'm');
INSERT INTO permit_requirements (organization_id, record_id, project_id, position, kind, content) VALUES
  ('org_0166', 'e1e1e1e1-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 1, 'auflage', 'Brandschutzkonzept vorlegen.'),
  ('org_0166', 'e2e2e2e2-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 1, 'nachforderung', 'Statischen Nachweis ergänzen.'),
  ('org_0166', 'e2e2e2e2-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 2, 'hinweis', 'Frist beachten.');
SQL
apply_in grid_permit_kinds 0166_permit_kinds.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "approval,information_request,refusal,other" "0166 rewrites every record kind"
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY position, kind) FROM permit_requirements" "condition,information_request,note" "0166 rewrites every requirement kind"
refused_in grid_permit_kinds "UPDATE permit_records SET kind = 'bewilligung' WHERE file_name = 'a.pdf'" "permit_records_kind_check" "the old record kind was accepted"
refused_in grid_permit_kinds "UPDATE permit_requirements SET kind = 'auflage' WHERE position = 1 AND kind = 'condition'" "permit_requirements_kind_check" "the old requirement kind was accepted"
check_in grid_permit_kinds "SELECT count(*) FROM pg_constraint WHERE conname IN ('permit_records_kind_check', 'permit_requirements_kind_check') AND convalidated" "2" "both CHECKs are validated"
apply_in grid_permit_kinds 0166_permit_kinds.down.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "bewilligung,nachforderung,ablehnung,sonstiges" "down restores the record kinds"
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY position, kind) FROM permit_requirements" "auflage,nachforderung,hinweis" "down restores the requirement kinds"
refused_in grid_permit_kinds "UPDATE permit_records SET kind = 'approval' WHERE file_name = 'a.pdf'" "permit_records_kind_check" "down left the English record kind accepted"
apply_in grid_permit_kinds 0166_permit_kinds.sql
apply_in grid_permit_kinds 0166_permit_kinds.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "approval,information_request,refusal,other" "0166 re-applies, twice"
echo "==> 0166 permit kinds and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0167: the task kind, the document roles and the BIM rule ids take
# English values, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0167. A role or a rule
# id that exists under both spellings for the same key (an older pod wrote the
# old one after the migration ran) keeps the new one. Nothing else moves.
# ---------------------------------------------------------------------------
echo "==> verifying the 0167 task, role and rule names and their down migration on grid_task_names"
migrate_before grid_task_names 0167_task_role_and_rule_names
sql_in grid_task_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000166', 'org_0167', 'Namen 0167', 'user_1', 'proj_0167');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000166', 'org_0167', 'user_1', 'plan.pdf', 'k/0167/plan', 'proj_0167', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000166'),
  ('d2d2d2d2-0000-4000-8000-000000000166', 'org_0167', 'user_1', 'modell.ifc', 'k/0167/modell', 'proj_0167', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000166');
INSERT INTO tasks (organization_id, project_id, kind, title, plan, requester_user_id) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'document', 'Dokument', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'manual');
INSERT INTO task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'delegated', 'succeeded', '{}'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'compliance_check', 'Normprüfung', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'delegated', 'succeeded', '{}');
INSERT INTO document_roles (organization_id, project_id, document_id, role, scope_instance_id, created_by) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'bebauungsplan', NULL, 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'bestandsplan', 'b1', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'lageplan', NULL, 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'site_plan', NULL, 'user_2');
INSERT INTO bim_models (id, organization_id, project_id, document_id, status)
VALUES ('f1f1f1f1-0000-4000-8000-000000000166', 'org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd2d2d2d2-0000-4000-8000-000000000166', 'completed');
INSERT INTO bim_check_confirmations (organization_id, project_id, rule_id, model_id, confirmed_by) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib2-feuerwiderstand-tragend', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib3-raumhoehe', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib4-tuer-durchgangsbreite', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib4-door-clear-width', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_2');
SQL
apply_in grid_task_names 0167_task_role_and_rule_names.sql
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM tasks" "document,submission_check" "0167 renames the kind on tasks"
check_in grid_task_names "SELECT string_agg(kind, ',') FROM task_definitions" "submission_check" "0167 renames the kind on task_definitions"
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM task_runs" "compliance_check,submission_check" "0167 renames the kind on task_runs and leaves the others"
check_in grid_task_names "SELECT string_agg(role || ':' || coalesce(scope_instance_id, '-') || ':' || created_by, ',' ORDER BY role) FROM document_roles" "development_plan:-:user_1,existing_plans:b1:user_1,site_plan:-:user_2" "0167 renames the roles, and the binding that existed under both spellings keeps the new one"
check_in grid_task_names "SELECT string_agg(rule_id || ':' || confirmed_by, ',' ORDER BY rule_id) FROM bim_check_confirmations" "oib2-fire-resistance-load-bearing:user_1,oib3-room-height:user_1,oib4-door-clear-width:user_2" "0167 renames the rule ids, and the confirmation that existed under both spellings keeps the new one"
apply_in grid_task_names 0167_task_role_and_rule_names.down.sql
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM tasks" "document,einreichcheck" "down restores the task kind"
check_in grid_task_names "SELECT string_agg(role, ',' ORDER BY role) FROM document_roles" "bebauungsplan,bestandsplan,lageplan" "down restores the roles"
check_in grid_task_names "SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM bim_check_confirmations" "oib2-feuerwiderstand-tragend,oib3-raumhoehe,oib4-tuer-durchgangsbreite" "down restores the rule ids"
apply_in grid_task_names 0167_task_role_and_rule_names.sql
apply_in grid_task_names 0167_task_role_and_rule_names.sql
check_in grid_task_names "SELECT string_agg(role, ',' ORDER BY role) FROM document_roles" "development_plan,existing_plans,site_plan" "0167 re-applies, twice"
echo "==> 0167 task, role and rule names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0168: English topic tags on conversations, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0168. Each array is
# rewritten element by element in the order of first appearance, an old key
# and its new spelling in one array collapse to one, a conversation without an
# old key is not touched (its `updated_at` stays), and the rewrite does not
# bump `updated_at` of one that is.
# ---------------------------------------------------------------------------
echo "==> verifying the 0168 conversation tag names and their down migration on grid_tag_names"
migrate_before grid_tag_names 0168_conversation_tag_names
sql_in grid_tag_names <<'SQL'
INSERT INTO conversations (id, organization_id, created_by, tags, updated_at) VALUES
  ('s_0168_a', 'org_0168', 'user_1', ARRAY['brandschutz', 'statik', 'brandschutz'], '2026-01-01 10:00:00+00'),
  ('s_0168_b', 'org_0168', 'user_1', ARRAY['allgemein'], '2026-01-02 10:00:00+00'),
  ('s_0168_c', 'org_0168', 'user_1', ARRAY['hygiene'], '2026-01-03 10:00:00+00'),
  ('s_0168_d', 'org_0168', 'user_1', ARRAY['fire_safety', 'brandschutz', 'energie'], '2026-01-04 10:00:00+00'),
  ('s_0168_e', 'org_0168', 'user_1', '{}', '2026-01-05 10:00:00+00');
SQL
apply_in grid_tag_names 0168_conversation_tag_names.sql
check_in grid_tag_names "SELECT string_agg(id || '=' || array_to_string(tags, '|'), ',' ORDER BY id) FROM conversations" "s_0168_a=fire_safety|structural,s_0168_b=general,s_0168_c=hygiene,s_0168_d=fire_safety|energy,s_0168_e=" "0168 rewrites the tags in order, without duplicates"
check_in grid_tag_names "SELECT count(*) FROM conversations WHERE updated_at <> ('2026-01-0' || (ascii(right(id, 1)) - 96)::text || ' 10:00:00+00')::timestamptz" "0" "0168 does not bump updated_at"
apply_in grid_tag_names 0168_conversation_tag_names.down.sql
check_in grid_tag_names "SELECT string_agg(id || '=' || array_to_string(tags, '|'), ',' ORDER BY id) FROM conversations" "s_0168_a=brandschutz|statik,s_0168_b=allgemein,s_0168_c=hygiene,s_0168_d=brandschutz|energie,s_0168_e=" "down restores the German keys"
apply_in grid_tag_names 0168_conversation_tag_names.sql
apply_in grid_tag_names 0168_conversation_tag_names.sql
check_in grid_tag_names "SELECT array_to_string(tags, '|') FROM conversations WHERE id = 's_0168_a'" "fire_safety|structural" "0168 re-applies, twice"
echo "==> 0168 conversation tag names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0169: English names for the builtin skills, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0169. An
# organization's decision about a playbook follows the rename, a clone that kept
# the builtin's name keeps shadowing it, a job and a standing task keep naming
# the skill, and a slash token inside a path is not one.
# ---------------------------------------------------------------------------
echo "==> verifying the 0169 skill names and their down migration on grid_skill_names"
migrate_before grid_skill_names 0169_skill_names
sql_in grid_skill_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Skills 0169', 'user_1', 'proj_0169');
INSERT INTO platform_skills (name, description, body, created_by) VALUES
  ('einreichcheck', 'd', 'b', 'platform'),
  ('brandschutz', 'd', 'b', 'platform'),
  ('fire-safety', 'd', 'b', 'platform');
INSERT INTO curated_skill_activations (organization_id, skill_name, enabled, updated_by) VALUES
  ('org_0169', 'einreichcheck', false, 'user_1'),
  ('org_0169', 'bestand', true, 'user_1'),
  ('org_0169', 'brandschutz', true, 'user_1'),
  ('org_0169', 'fire-safety', false, 'user_2');
INSERT INTO skills (organization_id, name, description, body, origin, cloned_from, created_by) VALUES
  ('org_0169', 'einreichcheck', 'd', 'b', 'platform-clone', 'einreichcheck', 'user_1'),
  ('org_0169', 'bestand', 'd', 'b', 'platform-clone', 'bestand', 'user_1'),
  ('org_0169', 'existing-building', 'd', 'b', 'org', NULL, 'user_1'),
  ('org_0169', 'brandschutz-check', 'd', 'b', 'platform-clone', 'brandschutz', 'user_1'),
  ('org_0169', 'hausregeln', 'd', 'b', 'org', NULL, 'user_1');
INSERT INTO jobs (id, project_id, organization_id, name, prompt, skill_name, skill_snapshot, output, enabled, schedule_timezone, created_by)
VALUES
  ('bbbbbbbb-0000-4000-8000-000000000168', 'aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Wöchentlich', '/einreichcheck bis Freitag; Ablage /brandschutz/eg bleibt', 'einreichcheck',
   '{"name":"einreichcheck","description":"d","body":"b","metadata":{},"origin":"platform"}', 'chat', true, 'UTC', 'user_1'),
  ('bbbbbbbb-0000-4000-8000-000000000169', 'aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Ohne Skill', 'Prüfe den Bestand', NULL, NULL, 'chat', true, 'UTC', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0169', 'aaaaaaaa-0000-4000-8000-000000000168', 'compliance_check', 'Einreichcheck', '{"prompt":"Prüfe — /einreichcheck.","skill":{"name":"einreichcheck"},"dataSources":null}', 'user_1', 'manual');
SQL
apply_in grid_skill_names 0169_skill_names.sql
check_in grid_skill_names "SELECT string_agg(name, ',' ORDER BY name) FROM platform_skills" "fire-safety,submission-check" "0169 renames the platform skills, and the one that existed under both names keeps the new one"
check_in grid_skill_names "SELECT string_agg(skill_name || ':' || enabled::text || ':' || updated_by, ',' ORDER BY skill_name) FROM curated_skill_activations" "existing-building:true:user_1,fire-safety:false:user_2,submission-check:false:user_1" "0169 carries an organization's decision over to the new name"
check_in grid_skill_names "SELECT string_agg(name || '<' || coalesce(cloned_from, '-'), ',' ORDER BY name) FROM skills" "bestand<existing-building,brandschutz-check<fire-safety,existing-building<-,hausregeln<-,submission-check<submission-check" "0169 renames a clone that kept the builtin's name (unless the organization already has the new one, as with bestand) and repoints cloned_from"
check_in grid_skill_names "SELECT coalesce(skill_name, '-') || '|' || coalesce(skill_snapshot ->> 'name', '-') || '|' || prompt FROM jobs WHERE name = 'Wöchentlich'" "submission-check|submission-check|/submission-check bis Freitag; Ablage /brandschutz/eg bleibt" "0169 renames a job's skill and its slash token, and not a path"
check_in grid_skill_names "SELECT prompt FROM jobs WHERE name = 'Ohne Skill'" "Prüfe den Bestand" "0169 leaves the words of a prompt alone"
check_in grid_skill_names "SELECT (plan ->> 'prompt') || '|' || (plan #>> '{skill,name}') FROM task_definitions" "Prüfe — /submission-check.|submission-check" "0169 renames the skill of a standing task"
apply_in grid_skill_names 0169_skill_names.down.sql
check_in grid_skill_names "SELECT string_agg(name, ',' ORDER BY name) FROM platform_skills" "brandschutz,einreichcheck" "down restores the platform skill names (the new-only duplicate is the loss)"
check_in grid_skill_names "SELECT string_agg(skill_name, ',' ORDER BY skill_name) FROM curated_skill_activations" "bestand,brandschutz,einreichcheck" "down restores the activations"
check_in grid_skill_names "SELECT skill_name || '|' || prompt FROM jobs WHERE name = 'Wöchentlich'" "einreichcheck|/einreichcheck bis Freitag; Ablage /brandschutz/eg bleibt" "down restores a job's skill and slash token"
apply_in grid_skill_names 0169_skill_names.sql
apply_in grid_skill_names 0169_skill_names.sql
check_in grid_skill_names "SELECT skill_name FROM jobs WHERE name = 'Wöchentlich'" "submission-check" "0169 re-applies, twice"
echo "==> 0169 skill names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0172: the inbox payload's `marksFassung` becomes `marksRevision`, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0172. Only the key moves,
# the count stays; a payload with both keys keeps the new one's value; a row
# without the old key is not touched (its `updated_at` stays).
# ---------------------------------------------------------------------------
echo "==> verifying the 0172 inbox revision marks and their down migration on grid_revmarks"
migrate_before grid_revmarks 0172_inbox_revision_marks
sql_in grid_revmarks <<'SQL'
INSERT INTO inbox_items (id, organization_id, recipient_user_id, type, resource_type, resource_id, group_key, actionable, payload, updated_at) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd1', 'g1', false, '{"openMarks": 3, "marksFassung": 2}', '2026-01-01 10:00:00+00'),
  ('a2a2a2a2-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd2', 'g2', false, '{"openMarks": 1, "marksFassung": 1, "marksRevision": 4}', '2026-01-02 10:00:00+00'),
  ('a3a3a3a3-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd3', 'g3', false, '{"openMarks": 2}', '2026-01-03 10:00:00+00');
SQL
apply_in grid_revmarks 0172_inbox_revision_marks.sql
check_in grid_revmarks "SELECT string_agg(payload::text, ' ' ORDER BY group_key) FROM inbox_items" '{"openMarks": 3, "marksRevision": 2} {"openMarks": 1, "marksRevision": 4} {"openMarks": 2}' "0172 renames the key, keeps the new key's value when both exist, and leaves other payloads alone"
check_in grid_revmarks "SELECT count(*) FROM inbox_items WHERE updated_at <> ('2026-01-0' || right(group_key, 1) || ' 10:00:00+00')::timestamptz" "0" "0172 does not bump updated_at"
apply_in grid_revmarks 0172_inbox_revision_marks.down.sql
check_in grid_revmarks "SELECT string_agg(payload::text, ' ' ORDER BY group_key) FROM inbox_items" '{"openMarks": 3, "marksFassung": 2} {"openMarks": 1, "marksFassung": 4} {"openMarks": 2}' "down restores the old key, with the value up kept (the newer one)"
apply_in grid_revmarks 0172_inbox_revision_marks.sql
apply_in grid_revmarks 0172_inbox_revision_marks.sql
check_in grid_revmarks "SELECT payload->>'marksRevision' FROM inbox_items WHERE group_key = 'g1'" "2" "0172 re-applies, twice"
echo "==> 0172 inbox revision marks and down migration verified"

# ---------------------------------------------------------------------------
# Migrations 0159 to 0162: the project profile's names in English, and their DOWNs.
#
# On a database of its own, migrated to what precedes 0159, with a project whose
# profile, prompt view, dismissed values, building bindings, proposed patch and
# permit record all hold the German names. Each migration rewrites its own table;
# a second run changes nothing; the down restores the German names.
# ---------------------------------------------------------------------------
echo "==> verifying the 0159-0162 English profile names and their down migrations on grid_profile_names"
migrate_before grid_profile_names 0159_english_profile_names
sql_in grid_profile_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name, profile, profile_prompt_view, profile_version) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000159', 'org_0159', 'Haus Wien', 'user_1', 'proj_0159',
   '{"facts":{"bundesland":{"value":"wien","confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "nutzungen@bw1":{"value":["wohnen","buero"],"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "wohneinheiten@bw1@wohnen":{"value":4,"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "gebaeudeklasse@bw1":{"value":3,"confidence":"confirmed","source":"derivation","updatedAt":"x",
                "evidence":[{"kind":"derivation","rule":"gebaeudeklasse","inputs":[{"key":"geschosse_oberirdisch@bw1","value":3},{"key":"nutzungen@bw1","value":["wohnen"]}]}]},
              "bauweise@bw1":{"value":["holzbau","offen"],"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "project_name":{"value":"Haus","confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "agent_key":{"value":"wien","confidence":"confirmed","source":"onboarding","updatedAt":"x"}},
     "goals":{}, "unknowns":["bgf_oberirdisch@bw1"],
     "assumptions":{"erschliessung":{"value":"ja","confidence":"assumed","source":"onboarding","updatedAt":"x"}}}',
   E'PROJECT_CONTEXT v1\n\nconfirmed:\n- bundesland=wien\n- nutzungen@bw1=wohnen,buero\n- agent_key=wien\n\nunknown:\n- bgf_oberirdisch@bw1\n\nassumptions:\n- erschliessung=ja', 5),
  ('bbbbbbbb-0000-4000-8000-000000000159', 'org_0159', 'Leer', 'user_1', 'proj_0159b',
   '{"facts":{},"goals":{},"unknowns":[],"assumptions":{}}', NULL, 1);
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000159', 'org_0159', 'user_1', 'a.pdf', 'k/0159/a', 'proj_0159', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000159'),
  ('d2d2d2d2-0000-4000-8000-000000000159', 'org_0159', 'user_1', 'b.pdf', 'k/0159/b', 'proj_0159', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000159');
INSERT INTO document_roles (organization_id, project_id, document_id, role, scope_instance_id, created_by) VALUES
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd1d1d1d1-0000-4000-8000-000000000159', 'drawing', 'bw1', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'drawing', 'bw2', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'drawing', 'bldg2', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'site_plan', NULL, 'user_1');
INSERT INTO project_intakes (organization_id, project_id, created_by, dismissed, location) VALUES
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'user_1',
   '[{"key":"bundesland","value":"niederoesterreich"},{"key":"nutzungen@bw1","value":["wohnen"]}]',
   '{"bundesland":"tirol","gemeinde":"Innsbruck","lat":47.2}');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('e1e1e1e1-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'project', 'project_profile',
   '{"title":"t","patch":[{"op":"add","path":"/facts/bundesland","value":{"value":"tirol","confidence":"confirmed"}},
                          {"op":"replace","path":"/facts/nutzungen@bw1/value","value":["wohnen","buero"]},
                          {"op":"add","path":"/unknowns/-","value":"geschosse_oberirdisch@bw1"}]}', 'piloti', 'user_1'),
  ('e2e2e2e2-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'project', 'memory',
   '{"patch":[{"path":"/facts/bundesland"}]}', 'piloti', 'user_1');
INSERT INTO permit_records (id, organization_id, project_id, document_id, collection_name, file_name, kind, bundesland, model) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd1d1d1d1-0000-4000-8000-000000000159',
   'proj_0159', 'a.pdf', 'bewilligung', 'niederoesterreich', 'm');
SQL

PROFILE_0159="SELECT profile::text || ' v' || profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'"
before_0159=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_profile_names -tAc "$PROFILE_0159")
before_view_0159=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_profile_names -tAc "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'")

apply_in grid_profile_names 0159_english_profile_names.sql
check_in grid_profile_names "SELECT string_agg(k, ',' ORDER BY k) FROM projects, jsonb_object_keys(profile->'facts') k WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "agent_key,building_class@bldg1,construction_method@bldg1,dwelling_units@bldg1@residential,federal_state,project_name,uses@bldg1" \
  "0159 renames the fact keys, the building id and the use zone; a key it does not know stays"
check_in grid_profile_names "SELECT profile->'facts'->'federal_state'->>'value' || '|' || (profile->'facts'->'uses@bldg1'->>'value') || '|' || (profile->'facts'->'construction_method@bldg1'->>'value') || '|' || (profile->'facts'->'agent_key'->>'value') FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  'vienna|["residential", "office"]|["timber", "open"]|wien' \
  "0159 renames the tokens under the key they sit under, and not the same word under a key it does not know"
check_in grid_profile_names "SELECT profile->'facts'->'building_class@bldg1'->'evidence'->0->>'rule' || '|' || (profile->'facts'->'building_class@bldg1'->'evidence'->0->'inputs'->0->>'key') || '|' || (profile->'facts'->'building_class@bldg1'->'evidence'->0->'inputs'->1->'value'->>0) FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "building_class|storeys_above_ground@bldg1|residential" "0159 renames a derivation's rule, its input keys and their values"
check_in grid_profile_names "SELECT profile->'unknowns'->>0 || '|' || (profile->'assumptions'->'servicing'->>'value') FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "gfa_above_ground@bldg1|yes" "0159 renames an unknown and an assumption (ja is yes only for servicing)"
check_in grid_profile_names "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  $'PROJECT_CONTEXT v1\n\nconfirmed:\n- federal_state=vienna\n- uses@bldg1=residential,office\n- agent_key=wien\n\nunknown:\n- gfa_above_ground@bldg1\n\nassumptions:\n- servicing=yes' \
  "0159 rewrites the prompt view the agent parses, line by line"
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "6" "0159 bumps profile_version so an open wizard reloads"
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'bbbbbbbb-0000-4000-8000-000000000159'" "1" "0159 leaves a profile without German names alone"
apply_in grid_profile_names 0159_english_profile_names.sql
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "6" "0159 re-applies without a second bump"

apply_in grid_profile_names 0160_english_intake_names.sql
check_in grid_profile_names "SELECT dismissed::text FROM project_intakes" \
  '[{"key": "federal_state", "value": "lower_austria"}, {"key": "uses@bldg1", "value": ["residential"]}]' "0160 renames a dismissed key and value"
check_in grid_profile_names "SELECT location::text FROM project_intakes" \
  '{"lat": 47.2, "federalState": "tyrol", "municipality": "Innsbruck"}' "0160 renames the location's fields and the Land's token"
apply_in grid_profile_names 0160_english_intake_names.sql

apply_in grid_profile_names 0161_english_building_ids.sql
check_in grid_profile_names "SELECT string_agg(coalesce(scope_instance_id, '-') || ':' || role, ',' ORDER BY scope_instance_id, role) FROM document_roles" \
  "bldg1:drawing,bldg2:drawing,-:site_plan" \
  "0161 renames the building id of a binding, and drops the German duplicate of a binding that already exists in English"
check_in grid_profile_names "SELECT payload->'patch'->0->>'path' || '|' || (payload->'patch'->0->'value'->>'value') || '|' || (payload->'patch'->1->>'path') || '|' || (payload->'patch'->2->>'value') FROM proposed_changes WHERE kind = 'project_profile'" \
  "/facts/federal_state|tyrol|/facts/uses@bldg1/value|storeys_above_ground@bldg1" "0161 renames a proposed profile patch's paths and values"
check_in grid_profile_names "SELECT payload::text FROM proposed_changes WHERE kind = 'memory'" '{"patch": [{"path": "/facts/bundesland"}]}' "0161 leaves a proposal of another kind alone"
apply_in grid_profile_names 0161_english_building_ids.sql
check_in grid_profile_names "SELECT count(*) FROM document_roles" "3" "0161 re-applies without losing a binding"

apply_in grid_profile_names 0162_permit_federal_state.sql
check_in grid_profile_names "SELECT bundesland || '|' || federal_state FROM permit_records" "niederoesterreich|lower_austria" "0162 backfills federal_state with the English token and keeps bundesland"
sql_in grid_profile_names <<'SQL'
INSERT INTO permit_records (organization_id, project_id, document_id, collection_name, file_name, kind, federal_state, model)
VALUES ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'proj_0159', 'b.pdf', 'bewilligung', 'styria', 'm');
SQL
check_in grid_profile_names "SELECT bundesland || '|' || federal_state FROM permit_records WHERE file_name = 'b.pdf'" "steiermark|styria" "0162: a new pod's write fills the old column, so an older pod reads it"
sql_in grid_profile_names <<<"UPDATE permit_records SET bundesland = 'tirol' WHERE file_name = 'a.pdf'"
check_in grid_profile_names "SELECT federal_state FROM permit_records WHERE file_name = 'a.pdf'" "tyrol" "0162: an older pod's write fills the new column"
apply_in grid_profile_names 0162_permit_federal_state.sql

apply_in grid_profile_names 0162_permit_federal_state.down.sql
check_in grid_profile_names "SELECT count(*) FROM information_schema.columns WHERE table_name = 'permit_records' AND column_name IN ('federal_state', 'bundesland')" "1" "0162 down drops the English column and keeps bundesland"
check_in grid_profile_names "SELECT string_agg(file_name || ':' || bundesland, ',' ORDER BY file_name) FROM permit_records" "a.pdf:tirol,b.pdf:steiermark" "0162 down leaves the German tokens, as the trigger kept them"
apply_in grid_profile_names 0161_english_building_ids.down.sql
check_in grid_profile_names "SELECT string_agg(coalesce(scope_instance_id, '-') || ':' || role, ',' ORDER BY scope_instance_id, role) FROM document_roles" "bw1:drawing,bw2:drawing,-:site_plan" "0161 down restores the bwN building ids"
check_in grid_profile_names "SELECT payload->'patch'->0->>'path' || '|' || (payload->'patch'->1->>'path') FROM proposed_changes WHERE kind = 'project_profile'" "/facts/bundesland|/facts/nutzungen@bw1/value" "0161 down restores the patch paths"
apply_in grid_profile_names 0160_english_intake_names.down.sql
check_in grid_profile_names "SELECT dismissed::text || location::text FROM project_intakes" \
  '[{"key": "bundesland", "value": "niederoesterreich"}, {"key": "nutzungen@bw1", "value": ["wohnen"]}]{"lat": 47.2, "gemeinde": "Innsbruck", "bundesland": "tirol"}' "0160 down restores the German dismissed values and location"
apply_in grid_profile_names 0159_english_profile_names.down.sql
check_in grid_profile_names "$PROFILE_0159" "${before_0159%% v*} v7" "0159 down restores the profile exactly (its version moves forward, never back)"
check_in grid_profile_names "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "$before_view_0159" "0159 down restores the prompt view exactly"
echo "==> 0159-0162 English profile names and down migrations verified"

# ---------------------------------------------------------------------------
# Migrations 0170 and 0171: the office shelf's scope value is `office_shelf`,
# and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0170. An office-shelf
# folder with a child, a document filed in the child, a project document, an
# upload batch and a proposal on the shelf, an access-log entry and a quarantine
# decision under the old value. 0170 rewrites the four mutable tables (and the
# composite keys between documents and folders survive the rewrite), refuses the
# old value in their new CHECKs, and leaves the two immutable tables alone; 0171
# makes those accept both spellings. The down puts the old value back; the up
# re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0170/0171 office shelf scope and its down migrations on grid_shelfscope"
migrate_before grid_shelfscope 0170_office_shelf_scope
sql_in grid_shelfscope <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000170', 'org_0170', 'Scope 0170', 'user_1', 'proj_0170');
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000170', 'org_0170', 'archiv', 'Normen', 'Normen');
INSERT INTO project_folders (id, organization_id, scope, parent_id, name, path) VALUES
  ('f2f2f2f2-0000-4000-8000-000000000170', 'org_0170', 'archiv', 'f1f1f1f1-0000-4000-8000-000000000170', 'OIB', 'Normen/OIB');
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('f3f3f3f3-0000-4000-8000-000000000170', 'org_0170', 'aaaaaaaa-0000-4000-8000-000000000170', 'Plaene', 'Plaene');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, folder_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'norm.pdf', 'k/0170/norm', 'archiv_org_0170', 'completed', 'archiv', 'f2f2f2f2-0000-4000-8000-000000000170');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES
  ('d2d2d2d2-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'plan.pdf', 'k/0170/plan', 'proj_0170', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000170', 'f3f3f3f3-0000-4000-8000-000000000170');
INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES
  ('b1b1b1b1-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'archiv', 1);
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000170', 'org_0170', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"norm.pdf","source":"office","target_folder":"Normen"}]}', 'piloti', 'user_1');
INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name)
VALUES ('org_0170', 'u', 'download', 'archiv', 'd1d1d1d1-0000-4000-8000-000000000170', 'norm.pdf');
INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, filename, uploaded_by)
VALUES ('e1e1e1e1-0000-4000-8000-000000000170', 'org_0170', 'd1d1d1d1-0000-4000-8000-000000000170', 'job-0170', 'archiv', 'norm.pdf', 'u');
SQL
SCOPES_0170="SELECT (SELECT string_agg(scope, ',' ORDER BY id) FROM project_folders) || '|' || (SELECT string_agg(scope, ',' ORDER BY id) FROM documents) || '|' || (SELECT scope FROM upload_batches) || '|' || (SELECT scope FROM proposed_changes)"
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 renames the scope on folders, documents, the upload batch and the proposal"
check_in grid_shelfscope "SELECT folder_id FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000170'" "f2f2f2f2-0000-4000-8000-000000000170" "0170 keeps a document in its folder"
check_in grid_shelfscope "SELECT count(*) FROM pg_constraint WHERE conname IN ('documents_folder_id_organization_id_scope_fkey','project_folders_parent_id_organization_id_scope_fkey','documents_folder_requires_project','project_folders_scope_check','upload_batches_scope','proposed_changes_scope_known') AND convalidated" "6" "0170 brings back the six constraints it dropped, validated"
check_in grid_shelfscope "SELECT scope FROM document_access_log" "archiv" "0170 does not rewrite the immutable access log"
check_in grid_shelfscope "SELECT scope FROM document_quarantine_decisions" "archiv" "0170 does not rewrite the immutable quarantine decisions"
refused_in grid_shelfscope "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_0170', 'archiv', 'Alt', 'Alt');" "project_folders_scope_check" "the old shelf value on a folder"
refused_in grid_shelfscope "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES (gen_random_uuid(), 'org_0170', 'u', 'archiv', 1);" "upload_batches_scope" "the old shelf value on an upload batch"
refused_in grid_shelfscope "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0170', NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"x.pdf\",\"source\":\"office\"}]}', 'piloti', 'user_1');" "proposed_changes_scope_known" "the old shelf value on a proposal"
refused_in grid_shelfscope "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0170', NULL, 'office_shelf', 'memory', '{}', 'piloti', 'user_1');" "proposed_changes_office_shelf_move" "a shelf proposal that is not a move still refused"
refused_in grid_shelfscope "UPDATE documents SET folder_id = 'f3f3f3f3-0000-4000-8000-000000000170' WHERE id = 'd1d1d1d1-0000-4000-8000-000000000170';" "documents_folder_id_organization_id_scope_fkey" "a shelf document in a project folder"
refused_in grid_shelfscope "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_0170', 'office_shelf', 'f3f3f3f3-0000-4000-8000-000000000170', 'x', 'x');" "project_folders_parent_id_organization_id_scope_fkey" "a project folder as the parent of a shelf folder"
refused_in grid_shelfscope "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'x');" "document_access_log_scope_check" "the new shelf value in the log before 0171"
apply_in grid_shelfscope 0171_office_shelf_scope_logs.sql
sql_in grid_shelfscope <<<"INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'neu.pdf');"
check_in grid_shelfscope "SELECT string_agg(scope, ',' ORDER BY document_name) FROM document_access_log" "office_shelf,archiv" "0171: the log holds the old entry and takes a new one"
refused_in grid_shelfscope "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'regal', gen_random_uuid(), 'x');" "document_access_log_scope_check" "an unknown shelf value in the log"
sql_in grid_shelfscope <<<"INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0170', gen_random_uuid(), 'job-2', 'office_shelf', 'neu.pdf', 'u');"
apply_in grid_shelfscope 0171_office_shelf_scope_logs.sql
apply_in grid_shelfscope 0170_office_shelf_scope.sql
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 re-applies, twice"
# The down of 0171 needs a log with no new-spelling row; the log is immutable, so it runs on a fresh database.
migrate_before grid_shelfscope_down 0171_office_shelf_scope_logs
apply_in grid_shelfscope_down 0171_office_shelf_scope_logs.sql
apply_in grid_shelfscope_down 0171_office_shelf_scope_logs.down.sql
refused_in grid_shelfscope_down "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'x');" "document_access_log_scope_check" "0171 down takes the new value out of the log CHECK"
apply_in grid_shelfscope 0170_office_shelf_scope.down.sql
check_in grid_shelfscope "$(echo "$SCOPES_0170")" "archiv,archiv,project|archiv,project|archiv|archiv" "0170 down puts the old scope back on every mutable table"
refused_in grid_shelfscope "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES (gen_random_uuid(), 'org_0170', 'u', 'office_shelf', 1);" "upload_batches_scope" "down: the new shelf value on an upload batch"
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 re-applies after its down"
echo "==> 0170/0171 office shelf scope and down migrations verified"
