-- 0165: English names for what the Fassung vocabulary stored in Postgres.
--
-- Fassung is "revision" in code (CONTEXT.md). Three persisted names still said
-- the German word, and this renames all three in one step:
--
--   * the table `document_fassung_announcements`, with its primary key and its
--     foreign key, becomes `document_revision_announcements`. The policy
--     `grid_tenant_isolation` does not carry the table's name and moves with it;
--     `grid_secure_table` is called again under the new name (as 0043 did for
--     `jobs`) so the coverage spec reads the table as secured.
--   * the CHECK `proposed_changes_archiv_move` becomes
--     `proposed_changes_office_shelf_move`. Only the name moves: the expression,
--     including the `'archiv'` shelf value and the item `source`, is untouched
--     (the shelf value is renamed with the routes and the collection prefix, not here).
--   * the inbox type `document.new_fassung` becomes `document.new_revision`, on
--     the rows and in the front of their group key (`<type>:<resource>:<id>:<anchor>`),
--     so a re-announcement folds into the row it already has.
--
-- Every statement is idempotent: it acts only on the old name, and does nothing
-- once the new one stands. A pod that has not rolled yet and writes
-- `document.new_fassung` after this ran is read as the new type
-- (`LEGACY_INBOX_TYPES`), and its announcement writes to the old table name fail
-- until it is replaced. The announcement is best effort: the settle hook that
-- makes it logs the failure and the document is unaffected.
DO $$
BEGIN
  IF to_regclass('public.document_fassung_announcements') IS NOT NULL
     AND to_regclass('public.document_revision_announcements') IS NULL THEN
    ALTER TABLE "document_fassung_announcements" RENAME TO "document_revision_announcements";
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_fassung_announcements_pk'
      AND conrelid = 'public.document_revision_announcements'::regclass
  ) THEN
    ALTER TABLE "document_revision_announcements"
      RENAME CONSTRAINT "document_fassung_announcements_pk" TO "document_revision_announcements_pk";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_fassung_announcements_document_fkey'
      AND conrelid = 'public.document_revision_announcements'::regclass
  ) THEN
    ALTER TABLE "document_revision_announcements"
      RENAME CONSTRAINT "document_fassung_announcements_document_fkey" TO "document_revision_announcements_document_fkey";
  END IF;
END
$$;
--> statement-breakpoint
COMMENT ON TABLE "document_revision_announcements" IS
  'A new Fassung (document_id, anchor_id) that document.new_revision has been announced for, once. The settle hook skips what is here, so a re-read tells nobody again.';
--> statement-breakpoint
SELECT grid_secure_table('document_revision_announcements', 'organization_id = grid_current_org()');
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposed_changes_archiv_move' AND conrelid = 'public.proposed_changes'::regclass
  ) THEN
    ALTER TABLE "proposed_changes"
      RENAME CONSTRAINT "proposed_changes_archiv_move" TO "proposed_changes_office_shelf_move";
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "inbox_items"
  SET "type" = 'document.new_revision',
      "group_key" = 'document.new_revision' || substr("group_key", length('document.new_fassung') + 1)
  WHERE "type" = 'document.new_fassung';
