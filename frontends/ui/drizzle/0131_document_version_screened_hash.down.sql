-- Reverse 0131. ORDER: roll the frontend back first; the newer build writes
-- `document_versions.screened_hash` with every verdict and reads it on every
-- version read.
--
-- Safe in the refusing direction: the older build judges a version only by the
-- item's verdict, so every earlier upload of a person's document is refused to
-- ordinary members again. Nothing is exposed that was not before.
ALTER TABLE "document_versions" DROP COLUMN IF EXISTS "screened_hash";
