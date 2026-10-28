-- Reverse 0165. ORDER: roll the frontend back first; the newer build reads and
-- writes `document_revision_announcements` and `document.new_revision`.
--
-- Exact: every name comes back as it was, and so does every inbox row's type and
-- group key. An inbox row an older pod wrote as `document.new_fassung` after 0165
-- is already in the old form and is left alone.
UPDATE "inbox_items"
  SET "type" = 'document.new_fassung',
      "group_key" = 'document.new_fassung' || substr("group_key", length('document.new_revision') + 1)
  WHERE "type" = 'document.new_revision';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proposed_changes_office_shelf_move' AND conrelid = 'public.proposed_changes'::regclass
  ) THEN
    ALTER TABLE "proposed_changes"
      RENAME CONSTRAINT "proposed_changes_office_shelf_move" TO "proposed_changes_archiv_move";
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.document_revision_announcements') IS NOT NULL
     AND to_regclass('public.document_fassung_announcements') IS NULL THEN
    ALTER TABLE "document_revision_announcements" RENAME TO "document_fassung_announcements";
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_revision_announcements_pk'
      AND conrelid = 'public.document_fassung_announcements'::regclass
  ) THEN
    ALTER TABLE "document_fassung_announcements"
      RENAME CONSTRAINT "document_revision_announcements_pk" TO "document_fassung_announcements_pk";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_revision_announcements_document_fkey'
      AND conrelid = 'public.document_fassung_announcements'::regclass
  ) THEN
    ALTER TABLE "document_fassung_announcements"
      RENAME CONSTRAINT "document_revision_announcements_document_fkey" TO "document_fassung_announcements_document_fkey";
  END IF;
END
$$;
--> statement-breakpoint
COMMENT ON TABLE "document_fassung_announcements" IS
  'A new Fassung (document_id, anchor_id) that document.new_fassung has been announced for, once. The settle hook skips what is here, so a re-read tells nobody again.';
--> statement-breakpoint
SELECT grid_secure_table('document_fassung_announcements', 'organization_id = grid_current_org()');
