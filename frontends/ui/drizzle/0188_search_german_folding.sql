-- 0188: one German spelling for the workspace search's words (ADR-0136).
--
-- ## What was missing
--
-- „Flächenwidmung“ and „Flaechenwidmung“ are one word to an architect, and
-- found different documents. The name test compared bytes (`strpos`), and the
-- reading's full-text vector was `to_tsvector('german', search_text)`, whose
-- stemmer drops an umlaut („flachenwidm“) but leaves the spelling a keyboard
-- without one writes („flaechenwidm“). The agent's file listing has always
-- folded both to one form (`knowledge_layer/browse.py`, `fold`).
--
-- ## The fold
--
-- `grid_fold_german` spells ä ö ü ß the way a German writes them without the
-- letter: ae oe ue ss, upper case too (`lower()` leaves them under the C
-- collation), after NFC so a name off a Mac (decomposed) folds the same. The
-- other direction cannot be taken: „ae“ is not always an „ä“ (Michael, Israel).
-- A name is compared folded on both sides (`nameContains`).
--
-- ## The column
--
-- The vector holds the text as written AND folded. Folded alone it would lose
-- what the stemmer does with an umlaut: „Pläne“ stems to „plan“, the singular's
-- stem, but „Plaene“ to „plaen“, so „Brandschutzplan“ would stop finding
-- „Brandschutzpläne“. The query asks both spellings the same way
-- (`lib/search/document-repository.ts`, `tsQuery`): as typed against the text
-- as written, folded against the folded text, so „Flaechenwidmung“ finds
-- „Flächenwidmung“ and a text that writes „Flaechenwidmung“ is found by both.
--
-- A generated column cannot change its expression in place, so it is dropped
-- and added again, which rewrites the table once. Nothing indexes it (0185's
-- header: no GIN under RLS).

CREATE OR REPLACE FUNCTION grid_fold_german(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(
    replace(replace(replace(replace(replace(replace(replace(replace(
      normalize(value, NFC),
      'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'Ä', 'Ae'), 'Ö', 'Oe'), 'Ü', 'Ue'), 'ß', 'ss'), 'ẞ', 'SS')
  )
$$;
--> statement-breakpoint
ALTER TABLE "document_search_facets" DROP COLUMN IF EXISTS "search_vector";
--> statement-breakpoint
ALTER TABLE "document_search_facets" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('german'::regconfig, "search_text") || to_tsvector('german'::regconfig, grid_fold_german("search_text"))
  ) STORED;
