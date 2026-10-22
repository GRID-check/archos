-- 0183: what settling an upload batch sets off, per batch (ADR-0086).
--
-- ## What was missing
--
-- Settling a batch (`lib/upload-batches/settle.ts`) sets off four effects, and
-- until now every batch set off all four:
--
--   1. `upload.completed` to the uploader: „Was ist angekommen?“;
--   2. Piloti judges where the upload belongs (`filing_review`, `lib/filing`),
--      once from the names at the seal and once from the content at the settle:
--      a model call each;
--   3. a project whose intake is open starts a reading (`project_intake_read`,
--      ADR-0111);
--   4. every settled document that is a new Fassung tells the people who
--      followed the older one (`document.new_revision`,
--      `lib/documents/revision-notify.ts`).
--
-- That is right for a person's upload and wrong for a server-side caller that
-- files on a person's decision. A mail filed into a project's E-Mail-Verlauf is
-- one more Fassung of the conversation per reply: at daily volume the Postfach
-- would fill with „Hochgeladen“ and „Neue Fassung“ rows, and every filed mail
-- would buy a model call re-judging a placement the person just chose. The
-- revision notice fires for every settled document, batch or not, so the
-- choice has to live on the batch row the document carries.
--
-- ## The columns
--
-- Three switches and one audience. The defaults are today's behaviour, so this
-- migration changes nothing until a caller opens a batch with other values.
--
--   `announces_completion`  1. off: no `upload.completed` item.
--   `reviews_filing`        2. off: neither filing review is queued.
--   `starts_intake`         3. off: the batch starts no intake reading.
--   `revision_notice`       4. `all`: assignees, uploaders and mark
--                           participants, as before. `marks_only`: only the
--                           people working on an open mark the new Fassung
--                           leaves behind, so no mark is orphaned silently.
--
-- Only the server sets them (`OpenUploadBatchInput.effects`); the route the
-- browser and agents open a batch through has no field for them.
--
-- ## Locks
--
-- `ADD COLUMN … DEFAULT <constant> NOT NULL` is a catalog change since
-- PostgreSQL 11: no table rewrite. The CHECK scans the table once, under the
-- same short ACCESS EXCLUSIVE lock; `upload_batches` is one row per upload.

ALTER TABLE "upload_batches" ADD COLUMN IF NOT EXISTS "announces_completion" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_batches" ADD COLUMN IF NOT EXISTS "reviews_filing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_batches" ADD COLUMN IF NOT EXISTS "starts_intake" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_batches" ADD COLUMN IF NOT EXISTS "revision_notice" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_batches" DROP CONSTRAINT IF EXISTS "upload_batches_revision_notice_known";--> statement-breakpoint
ALTER TABLE "upload_batches" ADD CONSTRAINT "upload_batches_revision_notice_known"
  CHECK ("revision_notice" IN ('all', 'marks_only'));
