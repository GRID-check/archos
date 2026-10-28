-- Reverse 0174. ORDER: roll the frontend back first; the newer build writes
-- `progress_done` from the `root_sort` job. Lossless: the column is display only,
-- and the cursor it runs ahead of is untouched.
ALTER TABLE "root_sort_runs" DROP CONSTRAINT IF EXISTS "root_sort_runs_progress_done_check";
ALTER TABLE "root_sort_runs" DROP COLUMN IF EXISTS "progress_done";
