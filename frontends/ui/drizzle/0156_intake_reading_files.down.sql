-- Reverse 0156. ORDER: roll the frontend back first; the newer build writes the
-- column on every `progress` op.
--
-- Lossy only for the live progress of a reading running at that moment: the
-- setup page then shows the last finished reading's count until the next one
-- finishes, as it did before 0156.
ALTER TABLE "project_intakes" DROP CONSTRAINT IF EXISTS "project_intakes_reading_files_array";
--> statement-breakpoint
ALTER TABLE "project_intakes" DROP COLUMN IF EXISTS "reading_files";
