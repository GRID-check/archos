-- Reverse 0174. ORDER: roll the frontend back first; the newer build writes the
-- `organization` scope, and the restored CHECKs refuse it.
--
-- Lossy: organization-scoped proposals are deleted (the older build cannot read
-- a proposal with no project and no Büroablage move). The folded duplicates are
-- not restored.
DELETE FROM "proposed_changes" WHERE "scope" = 'organization';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_proposed_changes_open_operation";
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_organization_operation;
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_office_shelf_move;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_office_shelf_move
  CHECK (
    "scope" = 'project'
    -- COALESCE: a missing key reads NULL, and a CHECK that is NULL passes.
    OR COALESCE(
      "kind" = 'file_operation'
      AND "payload"->>'operation' = 'move'
      AND jsonb_typeof("payload"->'operations') = 'array'
      AND jsonb_path_exists("payload", '$.operations[0]')
      AND NOT jsonb_path_exists("payload", '$.operations[*] ? (!(@.source == "office"))'),
      false
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT proposed_changes_office_shelf_move;
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_scope_known
  CHECK ("scope" IN ('project', 'office_shelf')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT proposed_changes_scope_known;
