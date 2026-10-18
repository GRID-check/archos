-- A wake knows how its turn ENDED (ADR-0106, amended): `answered` or
-- `stopped`, or `failed` after it started, with `ended_at`. Before this,
-- `started` was the last word the record ever had: the BFF detaches from a
-- woken turn once it runs, and nothing reported back.
--
-- `settled_at` keeps its meaning (when the wake left `queued`); `ended_at` is
-- when it reached its final word. A wake that never started ends when it
-- settles.
ALTER TABLE "piloti_wakes" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "piloti_wakes" DROP CONSTRAINT IF EXISTS piloti_wakes_status_known;
--> statement-breakpoint
ALTER TABLE "piloti_wakes" ADD CONSTRAINT piloti_wakes_status_known
  CHECK ("status" IN ('queued', 'started', 'answered', 'stopped', 'suppressed', 'refused', 'failed'));
--> statement-breakpoint
UPDATE "piloti_wakes" SET "ended_at" = "settled_at"
  WHERE "ended_at" IS NULL AND "status" IN ('suppressed', 'refused', 'failed');
--> statement-breakpoint
ALTER TABLE "piloti_wakes" DROP CONSTRAINT IF EXISTS piloti_wakes_ended_when_final;
--> statement-breakpoint
ALTER TABLE "piloti_wakes" ADD CONSTRAINT piloti_wakes_ended_when_final
  CHECK (("status" IN ('queued', 'started')) = ("ended_at" IS NULL));
