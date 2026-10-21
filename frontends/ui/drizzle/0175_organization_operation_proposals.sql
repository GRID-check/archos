-- 0175: an `operation` proposal may be the organization's, with no project, and
-- one open call is one open proposal (ADR-0105, ADR-0122).
--
-- ## An organization-scoped proposal
--
-- Piloti's writes through the MCP server are proposals (0174). Many writes are
-- not in a project at all: the office's memory, a skill, a setting. A turn with
-- no project had nowhere to file them, so `proposed_changes.scope` learns a
-- third shelf, `organization`. Like the Büroablage's (0146) it has no project
-- (`proposed_changes_scope_owner` already says `project` exactly when there is
-- one); unlike it, it holds exactly one kind: `operation`
-- (`proposed_changes_organization_operation`). The Büroablage CHECK
-- (`proposed_changes_office_shelf_move`, 0146/0165) said "not a project
-- proposal, therefore a move"; it now says it only of the Büroablage.
--
-- ## RLS
--
-- Unchanged. The policy (0146) is the organization, and for a project proposal
-- the project's organization; a proposal with no project is the organization's
-- alone, and an organization-scoped one is exactly that.
--
-- ## One open call, one proposal
--
-- A model that repeats a call must not file a second open proposal. In one
-- conversation, an operation and an input (compared as jsonb, which has one
-- spelling per value, so key order and white space do not matter) name one
-- proposal while it is still `proposed`; a decided one frees the name. The
-- unique index is the backstop for two identical calls running at once; the
-- service looks first and returns the existing proposal. The input is hashed
-- (md5) so a large body cannot overflow a btree entry.
--
-- Before the index, a repeat that already got through is folded: of several
-- open operation proposals for one call in one conversation, the oldest stays
-- and the later ones are deleted. They are undecided, were filed by Piloti
-- after 0174 (days ago), and a person has nothing to lose: the survivor shows
-- the same change.
--
-- Idempotent: every constraint and the index are dropped before they are added.
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_scope_known
  CHECK ("scope" IN ('project', 'office_shelf', 'organization')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT proposed_changes_scope_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_office_shelf_move;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_office_shelf_move
  CHECK (
    "scope" <> 'office_shelf'
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
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_organization_operation;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_organization_operation
  CHECK ("scope" <> 'organization' OR "kind" = 'operation') NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT proposed_changes_organization_operation;
--> statement-breakpoint
DELETE FROM "proposed_changes" AS later
  USING "proposed_changes" AS earlier
  WHERE later."kind" = 'operation' AND later."status" = 'proposed'
    AND earlier."kind" = 'operation' AND earlier."status" = 'proposed'
    AND later."organization_id" = earlier."organization_id"
    AND later."origin_conversation_id" = earlier."origin_conversation_id"
    AND later."payload"->>'operation' = earlier."payload"->>'operation'
    AND later."payload"->'input' = earlier."payload"->'input'
    AND (later."created_at", later."id") > (earlier."created_at", earlier."id");
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_proposed_changes_open_operation";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_proposed_changes_open_operation"
  ON "proposed_changes" (
    "organization_id",
    "origin_conversation_id",
    (("payload"->>'operation')),
    (md5(("payload"->'input')::text))
  )
  WHERE "kind" = 'operation' AND "status" = 'proposed' AND "origin_conversation_id" IS NOT NULL;
