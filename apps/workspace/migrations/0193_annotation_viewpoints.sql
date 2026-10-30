-- 0193: an Anmerkung on a 3D model is a viewpoint.
--
-- ## What was missing
--
-- A mark is a box on a page (0138), or the elements of a Skizze (0192). A model
-- (IFC) has neither: what a person points at is a view of it, from a camera
-- position, with a section, with some elements picked, hidden or coloured. So a
-- mark on a model carries a viewpoint (BCF's word): the camera, the clipping
-- planes, the selected elements, the visibility and a snapshot of what was on
-- screen. All coordinates are IFC world coordinates, Z-up, metres.
--
-- ## The table
--
-- `annotation_viewpoints`: immutable, no code path updates a row. A mark names
-- its viewpoint (`document_annotations.viewpoint_id`); the composite foreign key
-- `(viewpoint_id, document_id)` keeps a mark from naming another document's
-- viewpoint. The snapshot bytes are an object in the document's `_bim/`
-- prefix, swept with the document; the row keeps its key, type and size.
--
-- ## The mark's anchor
--
-- `anchor_kind` says what a mark is anchored to: `page` (a box on a page),
-- `sketch` (elements of a Skizze, 0192) or `viewpoint`. `page`, `shape`, `x` and
-- `y` become nullable, because a viewpoint mark has no box; the three
-- `…_anchor_*` CHECKs say which fields each kind must and must not carry. The
-- older CHECKs (`…_page_positive`, `…_point_on_page`, `…_region_on_page`) read
-- a NULL as passing, so they stand.
--
-- ## RLS
--
-- `annotation_viewpoints` is under `secure_table`: its organization, and the
-- organization of its document. `document_annotations` keeps its policy.

CREATE TABLE IF NOT EXISTS "annotation_viewpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "version_id" uuid,
  "camera_kind" text NOT NULL,
  "camera" jsonb NOT NULL,
  "clipping_planes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "selection_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "default_visibility" boolean DEFAULT true NOT NULL,
  "visibility_exception_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "coloring" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pin_point" jsonb,
  "pin_global_id" text,
  "snapshot_key" text,
  "snapshot_content_type" text,
  "snapshot_bytes" integer,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "annotation_viewpoints_id_document_uniq" UNIQUE ("id", "document_id"),
  CONSTRAINT "annotation_viewpoints_document_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
  CONSTRAINT "annotation_viewpoints_version_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL,
  CONSTRAINT "annotation_viewpoints_camera_kind_known" CHECK ("camera_kind" IN ('perspective', 'orthographic')),
  CONSTRAINT "annotation_viewpoints_camera_is_object" CHECK (CASE WHEN jsonb_typeof("camera") = 'object' THEN "camera"->>'type' = "camera_kind" ELSE false END),
  CONSTRAINT "annotation_viewpoints_planes_bounded" CHECK (CASE WHEN jsonb_typeof("clipping_planes") = 'array' THEN jsonb_array_length("clipping_planes") <= 6 ELSE false END),
  CONSTRAINT "annotation_viewpoints_selection_bounded" CHECK (cardinality("selection_ids") <= 500 AND array_position("selection_ids", NULL) IS NULL),
  CONSTRAINT "annotation_viewpoints_exceptions_bounded" CHECK (cardinality("visibility_exception_ids") <= 2000 AND array_position("visibility_exception_ids", NULL) IS NULL),
  CONSTRAINT "annotation_viewpoints_coloring_bounded" CHECK (CASE WHEN jsonb_typeof("coloring") = 'array' THEN jsonb_array_length("coloring") <= 16 ELSE false END),
  CONSTRAINT "annotation_viewpoints_pin_complete" CHECK ("pin_global_id" IS NULL OR "pin_point" IS NOT NULL),
  CONSTRAINT "annotation_viewpoints_snapshot_complete" CHECK (("snapshot_key" IS NULL) = ("snapshot_bytes" IS NULL) AND ("snapshot_key" IS NULL) = ("snapshot_content_type" IS NULL)),
  CONSTRAINT "annotation_viewpoints_snapshot_bounded" CHECK ("snapshot_bytes" IS NULL OR "snapshot_bytes" BETWEEN 1 AND 1500000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_annotation_viewpoints_document" ON "annotation_viewpoints" ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_annotation_viewpoints_organization_id" ON "annotation_viewpoints" ("organization_id");
--> statement-breakpoint
SELECT secure_table('annotation_viewpoints',
  'organization_id = current_org() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.organization_id = current_org())');
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "anchor_kind" text DEFAULT 'page' NOT NULL;
--> statement-breakpoint
UPDATE "document_annotations" SET "anchor_kind" = 'sketch' WHERE "anchor_element_ids" IS NOT NULL AND "anchor_kind" = 'page';
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "viewpoint_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_viewpoint_fkey";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_viewpoint_fkey"
  FOREIGN KEY ("viewpoint_id", "document_id") REFERENCES "annotation_viewpoints"("id", "document_id");
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "page" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "shape" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "x" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" ALTER COLUMN "y" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_kind_known";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_kind_known"
  CHECK ("anchor_kind" IN ('page', 'sketch', 'viewpoint'));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_page_is_box";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_page_is_box"
  CHECK ("anchor_kind" <> 'page' OR ("page" IS NOT NULL AND "shape" IS NOT NULL AND "x" IS NOT NULL AND "y" IS NOT NULL AND "anchor_element_ids" IS NULL AND "viewpoint_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_sketch_is_elements";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_sketch_is_elements"
  CHECK ("anchor_kind" <> 'sketch' OR ("anchor_element_ids" IS NOT NULL AND "viewpoint_id" IS NULL AND "page" IS NOT NULL AND "shape" IS NOT NULL AND "x" IS NOT NULL AND "y" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_viewpoint_is_3d";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_viewpoint_is_3d"
  CHECK ("anchor_kind" <> 'viewpoint' OR ("viewpoint_id" IS NOT NULL AND "page" IS NULL AND "shape" IS NULL AND "x" IS NULL AND "y" IS NULL AND "w" IS NULL AND "h" IS NULL AND "anchor_element_ids" IS NULL AND "anchor_lost_at" IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotations_viewpoint" ON "document_annotations" ("viewpoint_id") WHERE "viewpoint_id" IS NOT NULL;
