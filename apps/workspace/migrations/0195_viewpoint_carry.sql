-- 0195: a mark on a model goes on with the model's next Fassung.
--
-- ## What was missing
--
-- A mark on a model (0193) names an immutable viewpoint: the camera, the
-- section planes and the elements by IFC GlobalId, as they were on the Fassung
-- it was set on. When the model gets a new Fassung (the same file uploaded
-- again, or another file confirmed as its replacement), a person carries the
-- mark on („übernehmen“, `lib/annotations/viewpoint-carry.ts`). The view is
-- never changed: the carry writes a NEW viewpoint with the same camera and
-- planes and only the elements the new Fassung still has, matched by GlobalId,
-- never by coordinates. When none of the mark's elements is left, it keeps its
-- last viewpoint and says so, as a mark on a Skizze does (0192).
--
-- ## The columns and what holds them
--
-- `annotation_viewpoints.carried_from_id`: the viewpoint this one was carried
-- from, on the same document (carried in place) or on the document it replaced
-- (carried across, where the mark itself is linked by
-- `document_annotations.carried_from_id`, 0151). A plain foreign key, set to
-- null when the older viewpoint goes with its document; never itself
-- (`…_carried_from_other`). Deleting a mark deletes its viewpoint and the
-- earlier viewpoints of the same document it was carried from.
--
-- `document_annotations.anchor_lost_at` now also holds on a viewpoint mark:
-- none of its elements is in the Fassung it was carried to. 0193's
-- `…_anchor_viewpoint_is_3d` forbade it and 0192's `…_anchor_lost_needs_anchor`
-- asked for Skizze elements; both are restated to allow a viewpoint.
--
-- ## RLS
--
-- No new table: both are under `secure_table` already (0138, 0193), and a
-- column inherits its table's policy.

ALTER TABLE "annotation_viewpoints" ADD COLUMN IF NOT EXISTS "carried_from_id" uuid;
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" DROP CONSTRAINT IF EXISTS "annotation_viewpoints_carried_from_fkey";
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" ADD CONSTRAINT "annotation_viewpoints_carried_from_fkey"
  FOREIGN KEY ("carried_from_id") REFERENCES "annotation_viewpoints"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" DROP CONSTRAINT IF EXISTS "annotation_viewpoints_carried_from_other";
--> statement-breakpoint
ALTER TABLE "annotation_viewpoints" ADD CONSTRAINT "annotation_viewpoints_carried_from_other"
  CHECK ("carried_from_id" IS NULL OR "carried_from_id" <> "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_annotation_viewpoints_carried_from" ON "annotation_viewpoints" ("carried_from_id") WHERE "carried_from_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_viewpoint_is_3d";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_viewpoint_is_3d"
  CHECK ("anchor_kind" <> 'viewpoint' OR ("viewpoint_id" IS NOT NULL AND "page" IS NULL AND "shape" IS NULL AND "x" IS NULL AND "y" IS NULL AND "w" IS NULL AND "h" IS NULL AND "anchor_element_ids" IS NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_lost_needs_anchor";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_lost_needs_anchor"
  CHECK ("anchor_lost_at" IS NULL OR "anchor_element_ids" IS NOT NULL OR "viewpoint_id" IS NOT NULL);
