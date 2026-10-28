-- Reverse 0132. Safe in either order with the frontend: the indexes only make
-- the level read fast, and every query is correct without them. Dropping them
-- makes a large folder's pages slower again (a sort of the whole shelf per page).
DROP INDEX IF EXISTS documents_org_scope_folder_listing_idx;
DROP INDEX IF EXISTS documents_project_folder_listing_idx;
