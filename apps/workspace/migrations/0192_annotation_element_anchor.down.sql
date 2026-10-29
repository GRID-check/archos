-- Reverse 0192. Lossy by design: a mark on a Skizze keeps its box on the
-- Fassung it was last carried to, and forgets which elements it was about. A
-- later save leaves it on that Fassung, as any mark set before 0192.
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_lost_needs_anchor";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_is_region_on_sheet";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_elements_bounded";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "anchor_lost_at";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "anchor_element_ids";
