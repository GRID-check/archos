-- 0176: the inbox types of a task run say "task_run", not "job".
--
-- `job.completed`, `job.failed` and `job.waiting` announce a task run (one
-- attempt at a task: ended, failed, stopped to ask). "Job" is the claim-queue
-- item (`research_job_queue`, a run's `backendJobId`), a different thing
-- (docs/glossary.md, "Agent surface and standard terms"). The rows and the
-- front of their group key (`<type>:<resource>:<id>:<anchor>`) are renamed, so a
-- retried report or a second question folds into the row it already has.
--
-- No CHECK constrains `inbox_items.type`; the allowed values are the code's
-- (`INBOX_ITEM_TYPES`). Idempotent: it acts only on the old names. A pod that
-- has not rolled yet and writes `job.*` after this ran is read as the new type
-- (`LEGACY_INBOX_TYPES`), and the waiting row it wrote is settled by its old
-- key as well (`lib/runs/service.ts`), for one release.
UPDATE "inbox_items"
  SET "type" = 'task_run.completed',
      "group_key" = 'task_run.completed' || substr("group_key", length('job.completed') + 1)
  WHERE "type" = 'job.completed';
--> statement-breakpoint
UPDATE "inbox_items"
  SET "type" = 'task_run.failed',
      "group_key" = 'task_run.failed' || substr("group_key", length('job.failed') + 1)
  WHERE "type" = 'job.failed';
--> statement-breakpoint
UPDATE "inbox_items"
  SET "type" = 'task_run.waiting',
      "group_key" = 'task_run.waiting' || substr("group_key", length('job.waiting') + 1)
  WHERE "type" = 'job.waiting';
