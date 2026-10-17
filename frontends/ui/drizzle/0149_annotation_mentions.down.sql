-- Reverse 0149. Lossy by design: whom a mark or a reply mentioned goes. The
-- text keeps its „@Name“, which then reads as plain text, and the Postfach rows
-- already written stay.
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_mentions_bounded;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS document_annotation_replies_mentions_bounded;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "mentions";
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "mentions";
