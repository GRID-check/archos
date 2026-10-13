-- Reverse 0136. ORDER: roll the frontend back first; the newer build reads and
-- writes the wake record, the delegation and the reply's addressee flag.
--
-- Lossy: the record of every wake goes with its table, every delegation to
-- Piloti is forgotten (the marks keep their assignee), and which replies
-- addressed Piloti is no longer known.
DROP TABLE IF EXISTS "piloti_wakes";
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_delegated_while_open;
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_delegation_complete;
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "delegated_at";
ALTER TABLE "document_annotations" DROP COLUMN IF EXISTS "delegated_by";
ALTER TABLE "document_annotation_replies" DROP COLUMN IF EXISTS "addresses_agent";
