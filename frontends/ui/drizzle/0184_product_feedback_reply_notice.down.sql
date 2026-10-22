-- Reverse 0184. ORDER: roll the frontend back first; the newer build reads and
-- writes the column.
--
-- Lossy only in what it forgets: after 0184 applies again, the next poke on a
-- ticket announces the team replies the reporter has not opened since, once.
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "reporter_notified_at";
