-- 0132: the indexes a folder level is read by (ADR-0102).
--
-- The Files workspace used to drain a whole shelf into the browser and filter
-- it there: one keyset walk over `(created_at DESC, id ASC)` with no folder in
-- it. It now reads ONE folder level, a page at a time
-- (`listDocumentLevelPage`, `lib/documents/repository.ts`):
--
--   project shelf:  organization_id = ? AND scope = 'project' AND project_id = ?
--                   AND folder_id = ?  (or IS NULL for the root)
--                   ORDER BY created_at DESC, id ASC   LIMIT 101
--   Archiv shelf:   organization_id = ? AND scope = 'archiv'
--                   AND folder_id = ?  ORDER BY created_at DESC, id ASC   LIMIT 101
--
-- Neither existing index can serve that. `documents_project_idx` and
-- `documents_org_scope_idx` find the shelf, and then every row of it is read
-- and sorted to return the first hundred of one folder: a root holding 2 000
-- documents beside 20 000 elsewhere on the shelf is a 22 000-row sort per page.
-- Each index below leads with the shelf's equality columns and the folder, and
-- then carries the order, so a page is an index range read that stops at the
-- 101st row. `folder_id IS NULL` (the root) is an equality on a B-tree, which
-- stores NULLs, so the root uses the same index.
--
-- `id` ascending after `created_at DESC` is the listing's own tiebreak, so the
-- index also matches the oldest-first read, scanned backwards, up to the id
-- tiebreak of rows sharing a timestamp (an incremental sort of the ties).
--
-- Sorting by name or size is NOT given its own index. The folder prefix of
-- these indexes narrows the read to the level, and sorting one level's rows
-- (a few thousand at the very most) is cheap; an index per order and shelf
-- would cost every upload four more index writes for a sort a person asks for
-- now and then. Revisit with a measurement if a level ever outgrows that.
--
-- Not CONCURRENTLY: `drizzle-kit migrate` runs every migration in one
-- transaction, which CONCURRENTLY refuses, and this repository has no
-- non-transactional runner (see 0039). The build takes a SHARE lock, so reads
-- go on and writes to `documents` wait for the length of the build; on the
-- largest shelves we hold that is seconds.
CREATE INDEX IF NOT EXISTS documents_project_folder_listing_idx
  ON documents (project_id, folder_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS documents_org_scope_folder_listing_idx
  ON documents (organization_id, scope, folder_id, created_at DESC, id);
