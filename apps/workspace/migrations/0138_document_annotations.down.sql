-- Reverse 0138. ORDER: roll the frontend back first; the newer build reads and
-- writes both tables whenever a document is opened.
--
-- Lossy: every Anmerkung and every reply is deleted with the tables. Export
-- them first (ask Piloti for a Protokoll of a document's Anmerkungen) if they
-- are to be kept.
DROP TABLE IF EXISTS "document_annotation_replies";
DROP TABLE IF EXISTS "document_annotations";
