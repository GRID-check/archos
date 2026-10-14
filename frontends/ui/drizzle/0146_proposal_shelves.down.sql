-- Reverse 0146. ORDER: roll the frontend back first; the newer build files
-- Büroablage proposals and reads `scope`.
--
-- Lossy: every Büroablage proposal is deleted, open or decided (the older
-- build has no shelf to show it on and no project to hang it from), and which
-- trace proposed a filing suggestion is forgotten, so a decision on one no
-- longer scores.
SELECT grid_secure_table('proposed_changes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
DROP INDEX IF EXISTS "idx_proposed_changes_open";
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_archiv_move;
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_owner;
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_known;
DELETE FROM "proposed_changes" WHERE "project_id" IS NULL;
ALTER TABLE "proposed_changes" ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "proposed_changes" DROP COLUMN IF EXISTS "origin_trace_id";
ALTER TABLE "proposed_changes" DROP COLUMN IF EXISTS "scope";
