-- Reverse 0181. ORDER: roll the frontend back first; the newer build reads and
-- writes the row.
--
-- Lossless: every row is derived from the documents and folders, and the next
-- refresh after a re-apply recomputes it.
DROP TABLE IF EXISTS "office_conventions";
