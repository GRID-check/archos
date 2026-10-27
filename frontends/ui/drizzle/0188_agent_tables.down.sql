-- Reverse 0188. ORDER: roll the frontend back first; the older build names the
-- piloti_* tables, which the views keep serving until this runs.

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
    EXECUTE format('DROP VIEW IF EXISTS %I', old_name);
    CONTINUE WHEN to_regclass(format('public.%I', new_name)) IS NULL;

    FOR r IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = format('public.%I', new_name)::regclass
         AND left(conname, length(new_name) + 1) = new_name || '_'
    LOOP
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        new_name, r.conname, old_name || substr(r.conname, length(new_name) + 1));
    END LOOP;

    FOR r IN
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = new_name
         AND left(indexname, length(new_name) + 5) = 'idx_' || new_name || '_'
    LOOP
      EXECUTE format('ALTER INDEX %I RENAME TO %I',
        r.indexname, 'idx_' || old_name || substr(r.indexname, length(new_name) + 5));
    END LOOP;

    EXECUTE format('ALTER TABLE %I RENAME TO %I', new_name, old_name);
  END LOOP;
END $$;
