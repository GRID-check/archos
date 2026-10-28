-- Reverse 0129: back to active or closed.
--
-- A paused project becomes active, which is what an older build would treat it
-- as anyway: it was writable and members-only, so nothing widens. Its schedules
-- run again. The outcome of a closed project is dropped; it stays closed.
UPDATE "projects" SET "status" = 'active', "paused_at" = NULL WHERE "status" = 'paused';
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_closed_outcome_check";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_paused_state_check";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_status_check";
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_status_check" CHECK ("status" IN ('active', 'closed'));
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "closed_outcome";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "paused_at";
