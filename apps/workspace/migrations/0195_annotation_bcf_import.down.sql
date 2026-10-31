-- Reverse 0195. The imported marks and replies stay, as ordinary ones: only the
-- memory of which topic and which import they came from goes, so a later import
-- of the same file would set them again, and an imported reply no longer says so.
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS "document_annotation_replies_import_complete";
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "source_date";
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "imported_by";
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "import_batch_id";
--> statement-breakpoint
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
