-- Reverse 0187. ORDER: roll the frontend back first; the newer build calls
-- `grid_fold_german` in the search's name and full-text tests.
--
-- Lossless: the vector is generated from `search_text`, which stays.
ALTER TABLE "document_search_facets" DROP COLUMN IF EXISTS "search_vector";
ALTER TABLE "document_search_facets" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('german'::regconfig, "search_text")) STORED;
DROP FUNCTION IF EXISTS grid_fold_german(text);
