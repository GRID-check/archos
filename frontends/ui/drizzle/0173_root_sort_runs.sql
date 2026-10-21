-- 0173: root_sort_runs — a person's run of sorting a shelf's root into its
-- folders (ADR-0121).
--
-- The run is the server's, never the browser's: the BFF job `root_sort`
-- (`lib/filing/root-sort-run.ts`) works it a bounded slice at a time and keeps
-- everything it learns here, so closing the tab, a deploy or a dead worker
-- loses nothing. The person's dialog only reads this row and asks for the next
-- step (apply, undo, cancel).
--
-- `status` walks judging -> grouping -> ready -> applying -> applied
-- (-> undoing -> undone); cancelled and failed end it from anywhere. One run
-- in work per shelf at a time: the partial unique index refuses a second while
-- one is judging, grouping, applying or undoing.
--
-- The JSON columns hold the run's own lists, bounded by the CHECKs: the root
-- documents read (at most 5000 ids), what Piloti placed, the new folders it
-- proposed, what the person kept, and what was moved, so undo moves exactly
-- those back. Ids and paths only, never document content.
--
-- `error` ends a run (`failed`); `grouping_error` does not: a grouping that
-- failed leaves its files in the root and the run still reaches `ready`, and
-- the review says so.
--
-- Secured by its own `organization_id`; the composite foreign key keeps a
-- project run's organization the project's. An Archiv run has no project.
CREATE TABLE IF NOT EXISTS "root_sort_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "scope" text NOT NULL,
  "project_id" uuid,
  "requested_by" text NOT NULL,
  "status" text NOT NULL,
  "document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cursor" integer DEFAULT 0 NOT NULL,
  "unreadable" integer DEFAULT 0 NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "placements" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "failed_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "new_folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "kept_moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "moved_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "move_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "grouping_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT root_sort_runs_project_fkey
    FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT root_sort_runs_scope_check
    CHECK ("scope" IN ('project', 'office_shelf')),
  CONSTRAINT root_sort_runs_scope_owner_check
    CHECK (("scope" = 'project') = ("project_id" IS NOT NULL)),
  CONSTRAINT root_sort_runs_status_check
    CHECK ("status" IN ('judging', 'grouping', 'ready', 'applying', 'applied', 'undoing', 'undone', 'cancelled', 'failed')),
  CONSTRAINT root_sort_runs_lists_bounded
    CHECK (
      jsonb_array_length("document_ids") <= 5000
      AND jsonb_array_length("placements") <= 5000
      AND jsonb_array_length("failed_document_ids") <= 5000
      AND jsonb_array_length("new_folders") <= 12
      AND jsonb_array_length("kept_moves") <= 5000
      AND jsonb_array_length("moved_document_ids") <= 5000
      AND jsonb_array_length("move_failures") <= 5000
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "root_sort_runs_one_in_work_per_shelf"
  ON "root_sort_runs" ("organization_id", "scope", COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" IN ('judging', 'grouping', 'applying', 'undoing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "root_sort_runs_shelf_recent_idx"
  ON "root_sort_runs" ("organization_id", "scope", "project_id", "created_at" DESC);
--> statement-breakpoint
COMMENT ON TABLE "root_sort_runs" IS
  'A run of sorting a shelf root into its folders (ADR-0121), worked by the BFF job root_sort. Ids and folder paths only.';
--> statement-breakpoint
SELECT grid_secure_table('root_sort_runs', 'organization_id = grid_current_org()');
