-- Reverse 0140. ORDER: roll the frontend back first; the newer build writes the
-- two new kinds and the card index.
--
-- Lossy: proposals of the two new kinds are deleted (the older build cannot
-- read them; their cards fall back to deciding in the browser), and which card
-- made which proposal is forgotten.
DROP INDEX IF EXISTS "uniq_proposed_changes_origin_card";
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_card_index_needs_message;
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_card_index_nonnegative;
ALTER TABLE "proposed_changes" DROP COLUMN IF EXISTS "origin_card_index";
DELETE FROM "proposed_changes" WHERE "kind" IN ('memory', 'project_profile');
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_kind_known;
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_kind_known
  CHECK ("kind" IN ('file_operation'));
