-- 0151: a mark that goes on with the document's next Fassung, and the index the
-- daily reminder of a Zuständige's date reads by.
--
-- ## What was missing
--
-- A mark is set on one Fassung. When the document was uploaded again, its open
-- marks were listed and never drawn, and there was no way to say „gilt weiter
-- auf Fassung 3" short of resolving the mark and setting it again, which lost
-- its number and its thread. Under the same name a mark now moves to the
-- current Fassung in place (`version_id` changes; the row, its number and its
-- thread stay). When another document replaces this one (Index B filed as
-- Index C under another name), the mark cannot move: its number belongs to B,
-- its thread is anchored on B in every inbox row and wake that names it, and C
-- has numbers of its own. So C receives a linked mark, numbered on C, that
-- points back here (`carried_from_id`), and this one is closed in the same
-- transaction. B's thread stays where its rows point; C's mark says where it
-- came from, and B's says where it went.
--
-- ## The columns and what holds them
--
-- `carried_from_id`: the mark this one was carried from, on the document it
-- replaced. `ON DELETE SET NULL`, so deleting the original (or its document)
-- leaves the carried mark standing without its link. Unique where set: one
-- mark is carried once, and a second carry, whatever raced it, is refused by
-- the index rather than by a service that remembered to look. A mark is never
-- its own source (`…_carried_from_other`).
--
-- `idx_document_annotations_due`: open marks with a Zuständige and a date, by
-- the date. The daily reminder (`lib/annotations/due-reminders.ts`) finds the
-- organizations with marks due tomorrow or overdue, then walks each
-- organization's marks; a partial index keeps both reads off the closed and
-- unassigned marks, which are most of them.
--
-- ## RLS
--
-- No new table: `document_annotations` is under `grid_secure_table` since
-- 0138, and a column inherits its table's policy.

ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "carried_from_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_carried_from_fkey";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_carried_from_fkey"
  FOREIGN KEY ("carried_from_id") REFERENCES "document_annotations"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_carried_from_other";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_carried_from_other"
  CHECK ("carried_from_id" IS NULL OR "carried_from_id" <> "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_annotations_carried_from"
  ON "document_annotations" ("carried_from_id") WHERE "carried_from_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotations_due"
  ON "document_annotations" ("due_on") WHERE "status" = 'open' AND "assignee_user_id" IS NOT NULL AND "due_on" IS NOT NULL;
