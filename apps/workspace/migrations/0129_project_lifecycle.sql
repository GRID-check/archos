-- 0129: the project lifecycle as a small state machine (ADR-0098).
--
-- ## Three states
--
-- `active` (every project until now), `paused` and `closed`. Pausing parks a
-- project the office is waiting on (a Baubescheid, a client's financing): it
-- leaves the list's „Aktiv" view and its schedules stop, and nothing else
-- changes; it stays writable and members-only. Closing is ADR-0090 unchanged:
-- read-only, open to the office, the trigger of 0116 keeps refusing inserts.
--
--   active ⇄ paused,  active|paused → closed,  closed → active
--
-- The application decides which transitions exist (`PROJECT_TRANSITIONS`,
-- `lib/projects/project-status.ts`); the CHECKs below keep each state's own
-- columns honest.
--
-- ## How it ended, and when
--
-- A closed project says how it ended: `completed` (built, handed over) or
-- `cancelled` (not realized: a competition not won, a commission withdrawn).
-- And it always has an Abschluss: `ended_on` is no longer a free field of the
-- Steckbrief but the month the closing names, so a closed project without one
-- cannot exist. Every closed row already has one (closing filled it since
-- 0117); the UPDATE covers a row written by hand.
--
-- `ended_on` and `closed_outcome` are left alone on an active or paused
-- project: a reopened project keeps how and when it was closed, and the next
-- close offers both again. No surface reads them there (`abschlussOf`,
-- `lifecycleViewOf`).

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "closed_outcome" text;
--> statement-breakpoint
UPDATE "projects" SET "closed_outcome" = 'completed' WHERE "status" = 'closed' AND "closed_outcome" IS NULL;
--> statement-breakpoint
UPDATE "projects"
  SET "ended_on" = GREATEST(date_trunc('month', "closed_at")::date, "started_on")
  WHERE "status" = 'closed' AND "ended_on" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_status_check";
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_status_check" CHECK ("status" IN ('active', 'paused', 'closed'));
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_paused_state_check";
--> statement-breakpoint
-- Paused exactly when it says since when.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_paused_state_check" CHECK (("status" = 'paused') = ("paused_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_closed_outcome_check";
--> statement-breakpoint
-- A closed project says how it ended and has an Abschluss.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_closed_outcome_check" CHECK (
    ("status" <> 'closed' OR "closed_outcome" IS NOT NULL)
    AND ("closed_outcome" IS NULL OR "closed_outcome" IN ('completed', 'cancelled'))
    AND ("status" <> 'closed' OR "ended_on" IS NOT NULL)
  );
--> statement-breakpoint
COMMENT ON COLUMN "projects"."status" IS
  'active, paused or closed (ADR-0098). Paused: writable, members-only, schedules skipped. Closed (ADR-0090): read-only for files, folders, versions, the profile and project memory, and every organization member may read it.';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."paused_at" IS 'When the project was paused. Set exactly when status = paused.';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."closed_outcome" IS 'How a closed project ended: completed or cancelled (not realized). Never empty on a closed project; kept across a reopen as the next close''s suggestion.';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."ended_on" IS 'Abschluss, the first of its month. Set by closing (ADR-0098) and never empty on a closed project; kept across a reopen as the next close''s suggestion.';
