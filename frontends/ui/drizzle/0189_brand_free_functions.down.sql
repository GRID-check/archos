-- Reverse 0189. ORDER: roll the frontend, purger and scheduler back first; the
-- older builds call the `grid_` names, which the wrappers keep answering until
-- this runs. It drops the wrappers, renames each function back, and writes the
-- bodies that call one another with the old names again.

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
  f record;
  old_name text;
  def text;
  rewritten text;
BEGIN
  FOR f IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (functions)
       AND obj_description(p.oid, 'pg_proc') LIKE 'Old name, kept for one release by migration 0189%'
  LOOP
    EXECUTE format('DROP FUNCTION public.%I(%s)', f.proname, f.identity_args);
  END LOOP;

  FOR f IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND 'grid_' || p.proname = ANY (functions)
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_proc q
       WHERE q.pronamespace = 'public'::regnamespace AND q.proname = 'grid_' || f.proname
         AND pg_get_function_identity_arguments(q.oid) = f.identity_args);
    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', f.proname, f.identity_args, 'grid_' || f.proname);
  END LOOP;

  FOR f IN
    SELECT p.oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (functions)
  LOOP
    def := pg_get_functiondef(f.oid);
    rewritten := def;
    FOREACH old_name IN ARRAY functions LOOP
      rewritten := regexp_replace(rewritten, '(?<![A-Za-z0-9_])' || substr(old_name, 6) || '\M', old_name, 'g');
    END LOOP;
    IF rewritten <> def THEN
      EXECUTE rewritten;
    END IF;
  END LOOP;
END $$;
