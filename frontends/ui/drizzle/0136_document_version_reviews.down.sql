-- Reverse 0136. ORDER: roll the frontend back first; the newer build writes a
-- row here on every submit and review decision.
--
-- Loses only the rounds. Every fact a reader uses is still on
-- `document_versions`, which this step dual-writes and does not stop writing.
DROP TABLE IF EXISTS "document_version_reviews";
