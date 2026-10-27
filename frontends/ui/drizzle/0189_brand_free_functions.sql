-- 0189: the database's own functions lose the `grid_` prefix (ADR-0145 rule 5).
--
-- `grid_secure_table` becomes `secure_table`, `grid_current_org` becomes
-- `current_org`, and so for every function in `functions` below: the 29 that
-- earlier migrations created and none dropped, every one in the public schema
-- whose name starts with `grid_`. A migration from here on calls the new names
-- (`rls-coverage.spec.ts` reads both).
--
-- ## What holds a function, and what a rename does to it
--
-- A policy, a trigger, an index expression and a column default hold a
-- function by its oid, so they keep working through the rename. A function
-- BODY names the functions it calls as text, resolved when it runs, so after
-- the rename each body that called a `grid_` function is written again with
-- the new names. The BFF, the purger and the scheduler call a few by name in
-- SQL; this same change moves them to the new names.
--
-- ## The old names answer for one release
--
-- The migrate Job runs before the new frontend, purger and scheduler roll out,
-- so for a minute the old ones still call `grid_legal_hold_blocks` and its
-- siblings. Every function that is not a trigger function keeps its old name
-- as a one-line SQL wrapper over the new one, with the same arguments, result,
-- volatility and strictness, and the same EXECUTE grant to PUBLIC or none. A
-- trigger function is called only by its triggers, by oid, so it needs none.
-- The next release drops the wrappers, which carry the comment WRAPPER_NOTE.
--
-- ## Idempotent
--
-- A function is renamed only while no function of the new name and arguments
-- exists, a body is written again only when it still names an old function,
-- and a wrapper is made only where the old name is free. A second run changes
-- nothing.

DO $$
DECLARE
  functions CONSTANT text[] := ARRAY[
    'grid_conversation_restricted_use', 'grid_cosine_similarity', 'grid_current_org',
    'grid_current_user_id', 'grid_document_access_log_guard', 'grid_document_quarantine_decisions_guard',
    'grid_documents_hold_quarantine', 'grid_feedback_restricted_use',
    'grid_folder_ancestry', 'grid_folder_bin_lock_key', 'grid_folder_subtree', 'grid_legal_hold_blocks',
    'grid_mark_conversation_messages', 'grid_mark_conversation_restricted_use', 'grid_mark_feedback_restricted_use',
    'grid_mark_message_restricted_use', 'grid_mark_revision_thread', 'grid_mark_revision_thread_of_task',
    'grid_mark_revision_threads_of_document', 'grid_mark_revision_threads_of_folder',
    'grid_permit_federal_state_sync', 'grid_permit_federal_state_to_english', 'grid_permit_federal_state_to_legacy',
    'grid_refuse_held_delete', 'grid_refuse_insert_into_closed_project', 'grid_refuse_write_into_deleted_folder',
    'grid_secure_platform_table', 'grid_secure_table', 'grid_uuid_or_null'
  ];
  wrapper_note CONSTANT text := 'Old name, kept for one release by migration 0189; the next release drops it.';
  f record;
  old_name text;
  new_name text;
  def text;
  rewritten text;
  call_args text;
  volatility text;
BEGIN
  -- 1. Rename. A function whose new name already exists with its arguments is
  --    the wrapper a first run made, or was renamed then; it is left alone.
  FOR f IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (functions)
  LOOP
    new_name := substr(f.proname, 6);
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_proc q
       WHERE q.pronamespace = 'public'::regnamespace AND q.proname = new_name
         AND pg_get_function_identity_arguments(q.oid) = f.identity_args);
    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', f.proname, f.identity_args, new_name);
  END LOOP;

  -- 2. Bodies. Each renamed function is defined again with every old name in
  --    its body replaced by the new one, matched as a whole word.
  FOR f IN
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND 'grid_' || p.proname = ANY (functions)
  LOOP
    def := pg_get_functiondef(f.oid);
    rewritten := def;
    FOREACH old_name IN ARRAY functions LOOP
      rewritten := regexp_replace(rewritten, '\m' || old_name || '\M', substr(old_name, 6), 'g');
    END LOOP;
    IF rewritten <> def THEN
      EXECUTE rewritten;
    END IF;
  END LOOP;

  -- 3. Wrappers under the old names, for the callers still rolling out.
  FOR f IN
    SELECT p.oid, p.proname, p.pronargs, p.proretset, p.proisstrict, p.provolatile, p.proacl,
           pg_get_function_arguments(p.oid) AS args,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_result(p.oid) AS result
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND 'grid_' || p.proname = ANY (functions)
       AND p.prorettype <> 'trigger'::regtype
  LOOP
    old_name := 'grid_' || f.proname;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_proc q
       WHERE q.pronamespace = 'public'::regnamespace AND q.proname = old_name
         AND pg_get_function_identity_arguments(q.oid) = f.identity_args);
    SELECT coalesce(string_agg('$' || i, ', ' ORDER BY i), '') INTO call_args
      FROM generate_series(1, f.pronargs) AS i;
    volatility := CASE f.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END;
    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE sql %s %s AS %L',
      old_name, f.args, f.result, volatility,
      CASE WHEN f.proisstrict THEN 'STRICT' ELSE '' END,
      CASE WHEN f.proretset
        THEN format('SELECT * FROM public.%I(%s)', f.proname, call_args)
        ELSE format('SELECT public.%I(%s)', f.proname, call_args) END);
    EXECUTE format('COMMENT ON FUNCTION public.%I(%s) IS %L', old_name, f.identity_args, wrapper_note);
    IF f.proacl IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC', old_name, f.identity_args);
    END IF;
  END LOOP;
END $$;
