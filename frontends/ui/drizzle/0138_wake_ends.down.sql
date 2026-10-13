-- Reverse 0138. ORDER: roll the frontend back first; the newer build writes
-- wake ends.
--
-- Lossy: an `answered` or `stopped` wake collapses back to `started` (its turn
-- ran), and when each wake ended is forgotten.
ALTER TABLE "piloti_wakes" DROP CONSTRAINT IF EXISTS piloti_wakes_ended_when_final;
ALTER TABLE "piloti_wakes" DROP CONSTRAINT IF EXISTS piloti_wakes_status_known;
UPDATE "piloti_wakes" SET "status" = 'started' WHERE "status" IN ('answered', 'stopped');
-- A turn that failed after it started was `started` before 0138 knew better.
UPDATE "piloti_wakes" SET "status" = 'started', "reason" = NULL
  WHERE "status" = 'failed' AND "ended_at" IS NOT NULL AND "ended_at" <> "settled_at";
ALTER TABLE "piloti_wakes" ADD CONSTRAINT piloti_wakes_status_known
  CHECK ("status" IN ('queued', 'started', 'suppressed', 'refused', 'failed'));
ALTER TABLE "piloti_wakes" DROP COLUMN IF EXISTS "ended_at";
