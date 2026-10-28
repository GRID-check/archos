-- 0137: a version knows how it began, and an upload carries no approval nobody
-- gave (ADR-0104 rules 4–6, slice 4 step 4).
--
--   upload  a person put the bytes there. Born `published`, the basis for
--           answers once read; nobody reviewed it unless somebody asked.
--   draft   it began as a draft, Piloti's or a person's revision, and becomes
--           `published` only through an approval in a review round.
--
-- Until now `document_versions_published_is_approved` demanded an approver on
-- every published row, so an upload wrote its uploader into `approved_by`. The
-- CHECK now demands one only of a draft, and the stand-in approvals go.
-- `published_by`/`published_at` stay: the uploader did make it the current
-- version, at that moment.
--
-- Backfill: a version that was never submitted and is or was the published one
-- arrived as an upload (`upload` is the only transition that is born
-- published). Everything else began as a draft.
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "origin" text;
--> statement-breakpoint
UPDATE "document_versions"
SET "origin" = CASE
  WHEN "submitted_by" IS NULL AND "state" IN ('published', 'superseded') THEN 'upload'
  ELSE 'draft'
END
WHERE "origin" IS NULL;
--> statement-breakpoint
ALTER TABLE "document_versions" ALTER COLUMN "origin" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_versions" ALTER COLUMN "origin" SET DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_origin_known";
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_origin_known"
  CHECK ("origin" IN ('upload', 'draft'));
--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_published_is_approved";
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_published_is_approved"
  CHECK ("state" <> 'published' OR "origin" = 'upload' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));
--> statement-breakpoint
UPDATE "document_versions"
SET "approved_by" = NULL, "approved_at" = NULL
WHERE "origin" = 'upload' AND "approved_by" IS NOT NULL;
