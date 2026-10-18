-- 0152: when a reply in an Anmerkung's thread was last changed by its author.
--
-- ## What was missing
--
-- A reply could not be changed or taken back. A typo, a wrong name in an
-- „@“, an answer posted to the wrong mark stayed in the thread for good, and
-- whoever it mentioned stayed told. The person who wrote a reply may now
-- reword it or delete it while the mark is live and Piloti has not taken it up
-- (`lib/annotations/service.ts`, `editReply` and `deleteOwnReply`).
--
-- ## The column
--
-- `edited_at` on `document_annotation_replies`: when the author last changed
-- the reply's text, or null for one never changed. The thread says
-- „bearbeitet“ beside its time, so a reader who answered the earlier words
-- can tell. Set by the database's clock in the edit's own UPDATE
-- (`now()`), the clock `created_at` was set by, so the CHECK holds:
-- an edit never predates the reply it changes. Default null, so every reply
-- written before this reads as never edited.
--
-- ## RLS
--
-- No new table: `document_annotation_replies` is under `grid_secure_table`
-- since 0138, and a column inherits its table's policy.

ALTER TABLE "document_annotation_replies"
  ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS document_annotation_replies_edited_after_created;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD CONSTRAINT document_annotation_replies_edited_after_created
  CHECK ("edited_at" IS NULL OR "edited_at" >= "created_at");
