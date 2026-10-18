-- Reverse 0151. Lossy by design: a carried mark keeps its text, its number on
-- the newer document and everything said in its thread since, and forgets
-- which mark of the replaced document it came from. That one stays closed.
DROP INDEX IF EXISTS "idx_document_annotations_due";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_document_annotations_carried_from";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_carried_from_other";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_carried_from_fkey";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "carried_from_id";
