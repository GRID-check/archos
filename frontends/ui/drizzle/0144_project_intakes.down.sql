-- Reverse 0144. ORDER: roll the frontend back first; the newer build creates an
-- intake for a project set up from its documents, and its readings write
-- through this table.
--
-- Lossy: which documents were read, the values people dismissed, and a past
-- project's closing intent go with the table. The suggestions and facts the
-- readings wrote stay on the profile, where every reader already reads them;
-- a project created with a closing intent and not yet reviewed stays active
-- and is closed by hand.
DROP TABLE IF EXISTS "project_intakes";
