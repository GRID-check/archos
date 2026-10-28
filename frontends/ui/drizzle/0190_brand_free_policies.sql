-- 0190: the row-level-security policies lose the `grid_` prefix, and nothing
-- the database runs names a role by its old name (ADR-0145 rule 5).
--
-- ## The roles are renamed after this runs, by the deploy
--
-- `grid_app_rw`, `grid_app_platform`, `grid_app_owner` and `grid_keda_scaler`
-- become `app_rw`, `app_platform`, `app_owner` and `keda_scaler`. A migration
-- cannot do that (renaming a role takes a superuser, and the migrations run as
-- the database owner), so the deploy does it once the migrations have run:
-- `deploy/postgres/rename-legacy-names.sh after-migrate`, the Kubernetes Job
-- `pg-rename-rls-roles` and the Compose service `postgres-rename-roles`.
--
-- Grants, memberships and policies hold a role by its oid and come along. Two
-- kinds of code name a role as TEXT and would not:
--
--   * `secure_table` and `secure_platform_table` grant to the runtime roles by
--     name, and run again in every later migration that adds a table;
--   * the delete guards of `document_access_log` and
--     `document_quarantine_decisions` (0114, 0119) compare `current_user` with
--     the platform role's name.
--
-- Both now ask `rls_role(kind)`, which answers whichever of the two names
-- exists. A database migrated from scratch runs every migration before the
-- deploy renames anything, so up to that rename the old names are the ones
-- that exist; every database after it has only the new ones. The old names
-- below are there for that first run and nothing else.
--
-- ## The policies
--
-- Every policy whose name starts `grid_` loses the prefix:
-- `grid_tenant_isolation` (one per secured table), the three restrictive
-- `grid_tenant_write_guard_*` on `skill_categories` (0089), and the KEDA
-- scaler's `grid_keda_scaler_count`. `secure_table` drops the policy under
-- both names before it creates `tenant_isolation`: two permissive policies on
-- one table OR together, and the second would silently widen the first.
--
-- Idempotent: a policy is renamed only while its new name is free, the
-- functions are replaced whole, and a guard is rewritten only while it still
-- names the old role.

CREATE OR REPLACE FUNCTION rls_role(kind text) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN to_regrole('app_' || kind) IS NOT NULL THEN 'app_' || kind ELSE 'grid_app_' || kind END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION rls_role(text) IS
  'The name a row-level-security role (owner, platform, rw) has in this database: app_<kind>, or grid_app_<kind> until the deploy has renamed it (migration 0190).';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION secure_table(target text, tenancy_predicate text)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
    target, tenancy_predicate, tenancy_predicate);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I, %I', target, rls_role('rw'), rls_role('platform'));
  -- The table's own identity/serial sequences (0031 says why, and why scoped).
  FOR seq IN
    SELECT s.relname
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE s.relkind = 'S'
      AND t.relname = target
      AND t.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO %I, %I', seq, rls_role('rw'), rls_role('platform'));
  END LOOP;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION secure_table(text, text) IS
  'Put a table inside the tenant boundary: enable RLS, install the single tenant_isolation policy from the given predicate, and grant DML to the runtime roles. Every tenant table must call this.';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION secure_platform_table(target text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT USING (true)', target);
  EXECUTE format('GRANT SELECT ON %I TO %I', target, rls_role('rw'));
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', target, rls_role('platform'));
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION secure_platform_table(text) IS
  'Platform-wide configuration: every tenant may read it, only the platform role may write it. Not tenant data, so no organization predicate.';
--> statement-breakpoint
DO $$
DECLARE
  f record;
  def text;
  rewritten text;
BEGIN
  FOR f IN
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('document_access_log_guard', 'document_quarantine_decisions_guard')
  LOOP
    def := pg_get_functiondef(f.oid);
    rewritten := replace(def, 'current_user <> ''grid_app_platform''', 'current_user::text <> rls_role(''platform'')');
    IF rewritten <> def THEN
      EXECUTE rewritten;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
     WHERE schemaname = 'public' AND left(policyname, 5) = 'grid_'
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_policies q
       WHERE q.schemaname = 'public' AND q.tablename = p.tablename AND q.policyname = substr(p.policyname, 6));
    EXECUTE format('ALTER POLICY %I ON %I RENAME TO %I', p.policyname, p.tablename, substr(p.policyname, 6));
  END LOOP;
END $$;
