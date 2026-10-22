-- Reverse 0183. ORDER: roll the frontend back first; the newer build writes and
-- reads the four columns.
--
-- Lossy only in what it would set off later: a batch opened quiet and not yet
-- settled settles with all four effects once the columns are gone (one
-- `upload.completed`, the filing reviews, an intake reading, a revision notice
-- to everyone). A settled batch has nothing left to set off.
ALTER TABLE "upload_batches" DROP CONSTRAINT IF EXISTS "upload_batches_revision_notice_known";
ALTER TABLE "upload_batches" DROP COLUMN IF EXISTS "revision_notice";
ALTER TABLE "upload_batches" DROP COLUMN IF EXISTS "starts_intake";
ALTER TABLE "upload_batches" DROP COLUMN IF EXISTS "reviews_filing";
ALTER TABLE "upload_batches" DROP COLUMN IF EXISTS "announces_completion";
