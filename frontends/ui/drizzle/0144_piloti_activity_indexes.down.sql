-- Reverse 0144. Lossless: indexes only. Roll the frontend back first or not,
-- either order works; the older build never reads by these.
DROP INDEX IF EXISTS "idx_proposed_changes_project_decided";
DROP INDEX IF EXISTS "idx_piloti_changes_org_created";
DROP INDEX IF EXISTS "idx_piloti_wakes_ended";
DROP INDEX IF EXISTS "idx_piloti_wakes_live";
