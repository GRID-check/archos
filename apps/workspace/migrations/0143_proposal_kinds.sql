-- Proposals become the one form for every change Piloti proposes (ADR-0105):
-- a note for the project's or the office's memory (`memory`) and a change to
-- the project's facts (`project_profile`) join the file operations. Before
-- this, both were decided in the reader's browser and written into the chat
-- message (`cardInteractions`), so nobody else saw the decision and the
-- record Piloti read back was the model's preview, not what was written.
--
-- `origin_card_index` makes creation idempotent at the database: one card of
-- one answer is one proposal, however often the turn's finish runs. Partial,
-- so a proposal made outside an answer (a person's, later) needs none.
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_kind_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_kind_known
  CHECK ("kind" IN ('file_operation', 'memory', 'project_profile'));
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD COLUMN IF NOT EXISTS "origin_card_index" integer;
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_card_index_nonnegative;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_card_index_nonnegative
  CHECK ("origin_card_index" IS NULL OR "origin_card_index" >= 0);
--> statement-breakpoint
-- A card index names a card of one answer, so it needs that answer.
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_card_index_needs_message;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_card_index_needs_message
  CHECK ("origin_card_index" IS NULL OR "origin_message_id" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_proposed_changes_origin_card"
  ON "proposed_changes" ("organization_id", "origin_message_id", "origin_card_index")
  WHERE "origin_card_index" IS NOT NULL;
