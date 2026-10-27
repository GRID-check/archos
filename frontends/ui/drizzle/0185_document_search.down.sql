-- Reverse 0185. ORDER: roll the frontend back first; the newer build reads and
-- writes both tables.
--
-- Lossless: both tables are derived. Applying 0185 again and searching
-- rebuilds them (the backstop refresh finds every shelf unsynced).
DROP TABLE IF EXISTS "document_search_shelves";
--> statement-breakpoint
DROP TABLE IF EXISTS "document_search_facets";
--> statement-breakpoint
DROP INDEX IF EXISTS "documents_id_organization_id_key";
