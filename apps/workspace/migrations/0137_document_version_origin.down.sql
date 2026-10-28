-- Reverse 0137. ORDER: roll the frontend back first; the newer build writes
-- uploads without an approver, which the old CHECK refuses.
--
-- The stand-in approvals come back as the uploader at the upload's moment,
-- which is what the old build wrote (to within the milliseconds between its
-- clock and the row's `created_at`).
UPDATE "document_versions"
SET "approved_by" = "created_by", "approved_at" = "created_at"
WHERE "origin" = 'upload' AND "approved_by" IS NULL;
--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_published_is_approved";
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_published_is_approved"
  CHECK ("state" <> 'published' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_origin_known";
--> statement-breakpoint
ALTER TABLE "document_versions" DROP COLUMN IF EXISTS "origin";
