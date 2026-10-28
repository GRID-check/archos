-- A root sort's progress as it happens. A slice commits its `cursor` only when
-- it ends, a minute of judging or a hundred moves, so a dialog that read the
-- cursor stood still for that long and then jumped. `progress_done` counts the
-- items of the current step done so far: each chunk of judgement and every few
-- moves raise it while the slice is still running.
--
-- Display only. Nothing resumes from it; the cursor stays the one truth a slice
-- picks up from. It only ever rises within a step (the write takes the
-- GREATEST, so chunks finishing out of order cannot pull it back), and the step
-- that starts an apply or an undo sets it to 0 with the cursor.
ALTER TABLE "root_sort_runs" ADD COLUMN "progress_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "root_sort_runs" ADD CONSTRAINT "root_sort_runs_progress_done_check" CHECK ("progress_done" >= 0);
