-- 0196: an Anmerkung imported from a BCF file remembers the topic it came from.
--
-- ## What was missing
--
-- A coordination round brings a BCF file with the model: a few hundred topics
-- from the Fachplaner's tool. The import (`lib/bim/bcf-import-service.ts`)
-- makes each topic an ordinary mark on the model, anchored to a viewpoint
-- (0193). Importing the same file twice, or the next round's file that still
-- carries last round's topics, must not set the same point twice; and a later
-- triage step works over what ONE import brought in.
--
-- ## The columns
--
-- `source_topic_guid`: the topic's `Guid` from the file, lowercase (a `uuid`;
-- a writer's Guid that is not one is mapped to a UUIDv5 of it by the import).
-- Unique per document (`uniq_document_annotations_source_topic`), so the same
-- topic on the same model is one mark however often the file comes in; the
-- same topic on another model is another mark.
--
-- `import_batch_id`: the one import that brought the mark in, shared by every
-- mark of that import, indexed for the triage step's read.
--
-- ## The CHECKs
--
-- `…_import_complete`: both or neither; a topic always arrives in a batch.
-- `…_import_is_viewpoint`: an imported mark sits on a model's view. A topic
-- without a viewpoint is not imported (yet: a later step frames it from the
-- elements' stored boxes), so there is no imported page mark to allow.
--
-- No new table, so no new policy: `document_annotations` keeps its own.

ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "source_topic_guid" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD COLUMN IF NOT EXISTS "import_batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_import_complete";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_import_complete"
  CHECK (("source_topic_guid" IS NULL) = ("import_batch_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS "document_annotations_import_is_viewpoint";
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_import_is_viewpoint"
  CHECK ("source_topic_guid" IS NULL OR "anchor_kind" = 'viewpoint');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_annotations_source_topic"
  ON "document_annotations" ("document_id", "source_topic_guid") WHERE "source_topic_guid" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_annotations_import_batch"
  ON "document_annotations" ("import_batch_id") WHERE "import_batch_id" IS NOT NULL;
