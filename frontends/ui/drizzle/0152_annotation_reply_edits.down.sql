-- Reverse 0152. Lossy by design: an edited reply keeps its new words and
-- forgets that it was changed, so the thread stops saying „bearbeitet“.
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS document_annotation_replies_edited_after_created;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "edited_at";
