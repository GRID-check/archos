-- 0189: the three tables named after the product lose the brand (ADR-0145 rule 5).
--
--   piloti_wakes    -> agent_wakes     what woke the agent on an Anmerkung (0139)
--   piloti_changes  -> agent_changes   every change the agent applied (0142)
--   piloti_asks     -> agent_asks      a question another agent asked it (0179)
--
-- Each table's own constraints and indexes, which carry its name, move with it.
-- Row-level security, the tenant policy and the grants belong to the table and
-- survive a rename; each table is secured again under its new name anyway, with
-- its predicate unchanged, so `rls-coverage.spec.ts` reads the boundary from
-- this file as it does from every other. No other table references these by a
-- foreign key, and no function or trigger names them.
--
-- ## The old names stay readable for one release
--
-- The migrate Job runs before the new frontend rolls out, so the old pods keep
-- serving for a minute and still name the old tables, and a reply that enqueues
-- a wake writes one in its own transaction. Each old name is a view over the new
-- table until the next release drops it: simple, so Postgres updates through it,
-- and `security_invoker`, so the table's tenant policy is checked as the caller
-- rather than as the view's owner.
--
-- ## Idempotent
--
-- A table is renamed only while the old name is a table and the new one is
-- free; the constraints and indexes are renamed by prefix, `grid_secure_table`
-- replaces its policy, and a view takes only a name that is free. A second run
-- changes nothing.

DO $$
BEGIN
  IF to_regclass('public.agent_wakes') IS NULL
     AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'piloti_wakes') THEN
    ALTER TABLE piloti_wakes RENAME TO agent_wakes;
  END IF;
  IF to_regclass('public.agent_changes') IS NULL
     AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'piloti_changes') THEN
    ALTER TABLE piloti_changes RENAME TO agent_changes;
  END IF;
  IF to_regclass('public.agent_asks') IS NULL
     AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'piloti_asks') THEN
    ALTER TABLE piloti_asks RENAME TO agent_asks;
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  base text;
  old_name text;
  new_name text;
  r record;
BEGIN
  FOREACH base IN ARRAY ARRAY['wakes', 'changes', 'asks'] LOOP
    old_name := 'piloti_' || base;
    new_name := 'agent_' || base;
    FOR r IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = format('public.%I', new_name)::regclass
         AND left(conname, length(old_name) + 1) = old_name || '_'
    LOOP
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        new_name, r.conname, new_name || substr(r.conname, length(old_name) + 1));
    END LOOP;
    FOR r IN
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = new_name
         AND left(indexname, length(old_name) + 5) = 'idx_' || old_name || '_'
    LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I',
        r.indexname, 'idx_' || new_name || substr(r.indexname, length(old_name) + 5));
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
SELECT grid_secure_table('agent_wakes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM document_annotations a WHERE a.id = annotation_id AND a.organization_id = grid_current_org())');
--> statement-breakpoint
SELECT grid_secure_table('agent_changes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.organization_id = grid_current_org())');
--> statement-breakpoint
SELECT grid_secure_table('agent_asks', 'organization_id = grid_current_org()');
--> statement-breakpoint
DO $$
DECLARE
  base text;
BEGIN
  FOREACH base IN ARRAY ARRAY['wakes', 'changes', 'asks'] LOOP
    IF to_regclass(format('public.piloti_%s', base)) IS NULL THEN
      EXECUTE format('CREATE VIEW %I WITH (security_invoker = true) AS SELECT * FROM %I',
        'piloti_' || base, 'agent_' || base);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO grid_app_rw, grid_app_platform',
        'piloti_' || base);
    END IF;
  END LOOP;
END $$;
