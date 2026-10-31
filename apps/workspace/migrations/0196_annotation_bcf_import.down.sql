-- Reverse 0196. The imported marks stay, as ordinary marks on their model: only
-- the memory of which topic and which import they came from goes, so a later
-- import of the same file would set them again.
DROP INDEX IF EXISTS "idx_document_annotations_import_batch";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_document_annotations_source_topic";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_import_is_viewpoint";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_import_complete";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "import_batch_id";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "source_topic_guid";
