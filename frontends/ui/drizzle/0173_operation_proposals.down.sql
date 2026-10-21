-- Reverse 0173. ORDER: roll the frontend back first; the newer build writes the
-- `operation` kind.
--
-- Lossy: operation proposals are deleted (the older build cannot read them).
DELETE FROM "proposed_changes" WHERE "kind" = 'operation';
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_kind_known;
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_kind_known
  CHECK ("kind" IN ('file_operation', 'memory', 'project_profile'));
