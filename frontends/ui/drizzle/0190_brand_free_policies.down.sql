-- Reverse 0190. ORDER: after the deploy's role rename has been reversed
-- (`rename-legacy-names.sh` has no reverse; rename the four roles back by hand
-- as a superuser first), because 0189's `secure_table` grants to the old names.
-- Puts the `grid_` policy names back, the guards' literal role name, and
-- 0189's `secure_table` and `secure_platform_table`.

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname IN ('tenant_isolation', 'tenant_write_guard_ins', 'tenant_write_guard_upd',
                          'tenant_write_guard_del', 'keda_scaler_count')
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_policies q
       WHERE q.schemaname = 'public' AND q.tablename = p.tablename AND q.policyname = 'grid_' || p.policyname);
    EXECUTE format('ALTER POLICY %I ON %I RENAME TO %I', p.policyname, p.tablename, 'grid_' || p.policyname);
  END LOOP;
END $$;
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
    rewritten := replace(def, 'current_user::text <> rls_role(''platform'')', 'current_user <> ''grid_app_platform''');
    IF rewritten <> def THEN
      EXECUTE rewritten;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION secure_table(target text, tenancy_predicate text)
  RETURNS void LANGUAGE plpgsql AS $$
DECLARE seq text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format(
    'CREATE POLICY grid_tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
    target, tenancy_predicate, tenancy_predicate);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO grid_app_rw, grid_app_platform', target);
  FOR seq IN
    SELECT s.relname
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE s.relkind = 'S'
      AND t.relname = target
      AND t.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO grid_app_rw, grid_app_platform', seq);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION secure_platform_table(target text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format('CREATE POLICY grid_tenant_isolation ON %I FOR SELECT USING (true)', target);
  EXECUTE format('GRANT SELECT ON %I TO grid_app_rw', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO grid_app_platform', target);
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS rls_role(text);
