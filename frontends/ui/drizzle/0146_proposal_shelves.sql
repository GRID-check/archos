-- 0146: a proposed change on the Büroablage, and the trace that proposed it
-- (ADR-0105; docs/architecture/proposed-changes.md, „Ablage").
--
-- ## Why a proposal may have no project
--
-- Piloti now suggests where an upload belongs, on every shelf with folders:
-- a project's Dateien and the Büroablage (ADR-0078, ADR-0102). A suggestion is
-- a proposed change like any other, one record with one lifecycle, applied and
-- dismissed through the same routes. A Büroablage document has no project, and
-- `proposed_changes.project_id` was NOT NULL: the table could only hold half
-- of what the feature proposes. A second store for the Büroablage's
-- suggestions would be a second lifecycle, so the table learns the shelf.
--
-- `scope` is the shelf, in `project_folders.scope`'s vocabulary and with its
-- CHECK: `project` exactly when `project_id` is set. A Büroablage proposal can
-- only be a file operation that MOVES documents of the Büroablage: no project
-- means no project memory, no profile, no project folder to create and no
-- project member to assign, and the executors resolve a `buero` item on the
-- office's shelf. `proposed_changes_archiv_move` holds that, down to every
-- item's `source`, so no code path can file a Büroablage proposal that would
-- reach into a project when it is applied.
--
-- ## The trace
--
-- `origin_trace_id` is the Langfuse trace of the judgement that proposed it,
-- for a proposal no chat turn made (a filing suggestion has no answer message
-- to find its trace through). A person's decision is scored on it, as the
-- turn's is for a card (ADR-0089).
--
-- ## RLS
--
-- The organization, AND for a project proposal the project's organization;
-- a Büroablage proposal is the organization's alone, as a Büroablage folder is.
ALTER TABLE "proposed_changes" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD COLUMN IF NOT EXISTS "origin_trace_id" text;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_scope_known
  CHECK ("scope" IN ('project', 'archiv'));
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_scope_owner;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_scope_owner
  CHECK (("scope" = 'project') = ("project_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_archiv_move;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_archiv_move
  CHECK (
    "scope" = 'project'
    -- COALESCE: a missing key reads NULL, and a CHECK that is NULL passes.
    OR COALESCE(
      "kind" = 'file_operation'
      AND "payload"->>'operation' = 'move'
      AND jsonb_typeof("payload"->'operations') = 'array'
      AND jsonb_path_exists("payload", '$.operations[0]')
      AND NOT jsonb_path_exists("payload", '$.operations[*] ? (!(@.source == "buero"))'),
      false
    )
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposed_changes_open"
  ON "proposed_changes" ("organization_id", "scope", "project_id")
  WHERE "status" = 'proposed';
--> statement-breakpoint
SELECT grid_secure_table('proposed_changes',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
