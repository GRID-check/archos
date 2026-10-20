-- 0155: `project_intakes.reading_files` — what the current reading has opened
-- so far (ADR-0111; the setup page's step „Erfassung", ticket 26).
--
-- `documents_read` is written only when a reading finishes, because a reading
-- that fails part-way must leave its documents unread for the next one. So
-- while a reading ran, „23 Dokumente gelesen" could only be the last reading's
-- number. The run now reports each file it opens (`op: 'progress'`), and this
-- column holds those names: emptied when a reading is claimed, written only by
-- the reading whose `job_id` the row holds, and never read by anything that
-- decides what the next reading skips.
--
-- Adding a column with a constant default is a catalog update in PostgreSQL
-- 11+, so no row is rewritten.
ALTER TABLE "project_intakes"
  ADD COLUMN IF NOT EXISTS "reading_files" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Dropped first so the migration re-applies cleanly.
ALTER TABLE "project_intakes" DROP CONSTRAINT IF EXISTS "project_intakes_reading_files_array";
--> statement-breakpoint
ALTER TABLE "project_intakes"
  ADD CONSTRAINT "project_intakes_reading_files_array"
  CHECK (jsonb_typeof("reading_files") = 'array');
--> statement-breakpoint
COMMENT ON COLUMN "project_intakes"."reading_files" IS
  'File names the current or last reading opened, as the run reported them while reading (migration 0155). Live progress only; documents_read is what a finished reading read.';
