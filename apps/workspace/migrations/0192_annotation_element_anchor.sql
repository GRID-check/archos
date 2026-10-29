-- 0192: an Anmerkung pinned to elements of a Skizze.
--
-- ## What was missing
--
-- A mark is a place on one page of one Fassung. A Skizze (ADR-0148) gets a
-- Fassung on every save, and its elements move between them: a box set over
-- „Treppenhaus" on Fassung 3 would sit over empty paper on Fassung 4, and the
-- open marks would turn to ghosts at every save. So a mark on a Skizze names the
-- elements it is about (`anchor_element_ids`, Excalidraw's element ids), and its
-- box is derived from them on the server: the union of their bounds on the
-- exported sheet (`lib/annotations/sketch-anchor.ts`). When the Skizze is saved
-- as its next Fassung, its open and proposed marks go on with it in the same
-- transaction, their box drawn again from the elements that are still there.
-- When none of them is left, the mark keeps its last box and says so
-- (`anchor_lost_at`); an element that comes back clears it.
--
-- ## The columns and what holds them
--
-- `anchor_element_ids`: one to twenty element ids, none of them null
-- (`…_anchor_elements_bounded`). Only a region on the sheet's one page carries
-- them (`…_anchor_is_region_on_sheet`): a Skizze is one page, and the box is
-- the elements' bounds, never a point.
--
-- `anchor_lost_at`: when the last of its elements went, by the save that
-- removed it; only on a mark that names elements (`…_anchor_lost_needs_anchor`).
--
-- ## RLS
--
-- No new table: `document_annotations` is under `secure_table` since 0138, and a
-- column inherits its table's policy.

ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "anchor_element_ids" text[];
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "anchor_lost_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_elements_bounded";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_elements_bounded"
  CHECK ("anchor_element_ids" IS NULL OR (cardinality("anchor_element_ids") BETWEEN 1 AND 20 AND array_position("anchor_element_ids", NULL) IS NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_is_region_on_sheet";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_is_region_on_sheet"
  CHECK ("anchor_element_ids" IS NULL OR ("page" = 1 AND "shape" = 'region'));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_anchor_lost_needs_anchor";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_anchor_lost_needs_anchor"
  CHECK ("anchor_lost_at" IS NULL OR "anchor_element_ids" IS NOT NULL);
