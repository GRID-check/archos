/** The DDL the init Job (`pg-init-tables` in `postgres.ts`) applies. */

// Table DDL adapted from deploy/compose/init-db.sql, minus the psql
// meta-commands (\gexec/\connect) — CNPG creates the databases, this Job only
// creates tables. Every statement is IF NOT EXISTS, so re-runs are safe.
export const JOBS_SQL = `
CREATE TABLE IF NOT EXISTS job_info (
  job_id VARCHAR PRIMARY KEY, status VARCHAR NOT NULL, config_file VARCHAR,
  error VARCHAR, output_path VARCHAR, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  expiry_seconds INTEGER, output VARCHAR, is_expired BOOLEAN DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS idx_job_info_status ON job_info(status);
CREATE INDEX IF NOT EXISTS idx_job_info_created_at ON job_info(created_at);
CREATE TABLE IF NOT EXISTS job_access (
  job_id VARCHAR PRIMARY KEY, owner_auth_type VARCHAR NOT NULL, owner_subject VARCHAR NOT NULL,
  owner_email VARCHAR, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_job_access_owner ON job_access(owner_auth_type, owner_subject);
CREATE TABLE IF NOT EXISTS job_events (
  id SERIAL PRIMARY KEY, job_id VARCHAR(64) NOT NULL, event_type VARCHAR(64) NOT NULL,
  event_data TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id_id ON job_events(job_id, id);
CREATE TABLE IF NOT EXISTS summaries (
  collection VARCHAR(256) NOT NULL, filename VARCHAR(512) NOT NULL, summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (collection, filename));
CREATE INDEX IF NOT EXISTS idx_summaries_collection ON summaries(collection);
`;

export const CHECKPOINTS_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_migrations (v INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint JSONB NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS checkpoint_blobs (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
  version TEXT NOT NULL, type TEXT NOT NULL, blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version));
CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
`;

/**
 * Lock down the filer's database (ADR-0043).
 *
 * PostgreSQL grants `CONNECT` on every new database to `PUBLIC`, which here
 * means the application logins can open a session against the store holding an
 * AES key for every chunk in the object store. They would find no tables they
 * could read — the filer owns them and grants nothing — but "the grant table
 * happens to be empty" is not a boundary, and `[postgres2]` creates a new table
 * per bucket at runtime, so the set of objects to protect is not even fixed.
 *
 * Run as the database OWNER, which is exactly the privilege needed and nothing
 * more. Idempotent: re-revoking an absent grant is a no-op.
 */
export const seaweedFilerSql = (database: string): string =>
  `REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC;\n`;
