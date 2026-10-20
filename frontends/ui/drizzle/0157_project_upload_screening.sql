-- 0157: project_upload_screening — what one project changes about the office's
-- sensitive-data NAME terms (ADR-0086, amendment of 2026-10-20; ticket 26,
-- setup step „Ablage").
--
-- The office keeps one list (`organizations.settings.uploadScreening`). A
-- project may add name terms only it needs, and set aside office name terms
-- that hold back what it needs. No row: the office's list unchanged. The
-- content terms and detectors are never changed per project.
--
-- Written only by `PUT /api/projects/{id}/upload-screening` (`project:manage`,
-- audited as `project.upload_screening.updated` with counts). Read by the name
-- gate on both sides of an upload into the project.
--
-- The CHECK bounds what a request can store, as the route does: at most 50
-- added and 200 set-aside terms of at most 80 characters each.
--
-- Secured by its own `organization_id`; the composite foreign key keeps the
-- row's organization the project's.
CREATE TABLE IF NOT EXISTS "project_upload_screening" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "added_name_terms" text[] DEFAULT '{}' NOT NULL,
  "removed_name_terms" text[] DEFAULT '{}' NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT project_upload_screening_project_fkey
    FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT project_upload_screening_terms_bounded
    CHECK (
      cardinality("added_name_terms") <= 50
      AND cardinality("removed_name_terms") <= 200
      AND char_length(array_to_string("added_name_terms", '')) <= 4000
      AND char_length(array_to_string("removed_name_terms", '')) <= 16000
    )
);
--> statement-breakpoint
COMMENT ON TABLE "project_upload_screening" IS
  'Per-project changes to the office sensitive-data NAME terms (ADR-0086): added terms and office terms set aside. No row = the office list unchanged. Terms are sensitive; audit carries counts only.';
--> statement-breakpoint
SELECT grid_secure_table('project_upload_screening', 'organization_id = grid_current_org()');
