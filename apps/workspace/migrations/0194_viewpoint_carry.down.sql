-- Reverse 0194. Lossy by design: a viewpoint mark none of whose elements was
-- left forgets it (its `anchor_lost_at` is cleared, as 0193 had no room for
-- it), and a carried viewpoint forgets the one it was carried from. Every
-- viewpoint stays, and so does every mark. A model forgets which Fassung it
-- was extracted from.
ALTER TABLE "bim_models" DROP CONSTRAINT IF EXISTS "bim_models_source_version_fkey";
--> statement-breakpoint
ALTER TABLE "bim_models" DROP COLUMN IF EXISTS "source_version_id";
--> statement-breakpoint
UPDATE "document_annotations" SET "anchor_lost_at" = NULL WHERE "anchor_kind" = 'viewpoint' AND "anchor_lost_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_lost_needs_anchor";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_lost_needs_anchor"
  CHECK ("anchor_lost_at" IS NULL OR "anchor_element_ids" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_viewpoint_is_3d";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_viewpoint_is_3d"
  CHECK ("anchor_kind" <> 'viewpoint' OR ("viewpoint_id" IS NOT NULL AND "page" IS NULL AND "shape" IS NULL AND "x" IS NULL AND "y" IS NULL AND "w" IS NULL AND "h" IS NULL AND "anchor_element_ids" IS NULL AND "anchor_lost_at" IS NULL));
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_annotation_viewpoints_carried_from";
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" DROP CONSTRAINT IF EXISTS "annotation_viewpoints_carried_from_other";
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" DROP CONSTRAINT IF EXISTS "annotation_viewpoints_carried_from_fkey";
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" DROP COLUMN IF EXISTS "carried_from_id";
