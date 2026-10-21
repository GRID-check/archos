-- Reverse 0175. ORDER: roll the frontend back first; the newer build writes and
-- reads `task_run.*`.
--
-- Exact: every row's type and group key come back as they were. A row an older
-- pod wrote as `job.*` after 0175 is already in the old form and is left alone.
UPDATE "inbox_items"
  SET "type" = 'job.completed',
      "group_key" = 'job.completed' || substr("group_key", length('task_run.completed') + 1)
  WHERE "type" = 'task_run.completed';
--> statement-breakpoint
UPDATE "inbox_items"
  SET "type" = 'job.failed',
      "group_key" = 'job.failed' || substr("group_key", length('task_run.failed') + 1)
  WHERE "type" = 'task_run.failed';
--> statement-breakpoint
UPDATE "inbox_items"
  SET "type" = 'job.waiting',
      "group_key" = 'job.waiting' || substr("group_key", length('task_run.waiting') + 1)
  WHERE "type" = 'task_run.waiting';
