-- 0195: an Anmerkung imported from a BCF file remembers the topic it came from.
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
-- ## A reply brought in by an import
--
-- A comment whose author's email is a colleague becomes a reply BY that
-- colleague: the thread names who said it. So that it is never mistaken for
-- something they wrote here, the reply keeps where it came from:
-- `import_batch_id` (the import), `imported_by` (who imported it) and
-- `source_date` (the comment's own date in the file, when it had one). Its
-- `created_at` is the import's time, so the thread's order and every „new
-- since“ reading stay true to when it arrived here; the original date is
-- shown beside it. `…_import_complete` on the reply: batch and importer both
-- or neither, and an original date only on an imported reply.
--
-- No new table, so no new policy: both tables keep their own.

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
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD COLUMN IF NOT EXISTS "import_batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD COLUMN IF NOT EXISTS "imported_by" text;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD COLUMN IF NOT EXISTS "source_date" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS "document_annotation_replies_import_complete";
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD CONSTRAINT "document_annotation_replies_import_complete"
  CHECK (("import_batch_id" IS NULL) = ("imported_by" IS NULL) AND ("source_date" IS NULL OR "import_batch_id" IS NOT NULL));
