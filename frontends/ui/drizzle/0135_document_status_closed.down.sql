-- Reverse 0135. Any order: the older build writes only the seven values the
-- CHECK allows, so it runs against either schema.
--
-- Loses nothing a reader can see: the legacy spellings 0135 rewrote meant what
-- they were rewritten to, and the older build renders both alike.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_status_known";
ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMENT ON COLUMN "documents"."status" IS NULL;
