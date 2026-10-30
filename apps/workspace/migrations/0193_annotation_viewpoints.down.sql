-- Reverse 0193. Lossy by design: the viewpoint marks (and their viewpoints)
-- are deleted, because a mark with no box cannot exist on the older schema;
-- `anchor_kind` is forgotten (a mark on a Skizze keeps its elements, which
-- 0192's CHECKs hold). The snapshot objects stay in the object store until the
-- document's `_bim/` prefix is swept.
DELETE FROM "document_annotations" WHERE "anchor_kind" = 'viewpoint';
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_viewpoint_is_3d";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_sketch_is_elements";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_page_is_box";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_kind_known";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_document_annotations_viewpoint";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_viewpoint_fkey";
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "page" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "shape" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "x" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "y" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "viewpoint_id";
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "anchor_kind";
--> statement-breakpoint
DROP TABLE IF EXISTS "annotation_viewpoints";
