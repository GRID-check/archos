-- 0144: project_intakes — Piloti sets a project up from its documents
-- (ADR-0111; docs/design/agentic-project-intake.md).
--
-- ## What was missing
--
-- A new project's profile was filled by hand in the intake wizard, nine
-- modules and up to fifty questions. The project's documents state most of
-- those values and nobody read them for the profile. A reading now does: an
-- agent of its own on the research worker reads the project's documents and
-- writes what it finds onto the profile as suggestions with evidence, and a
-- person confirms them. The values live on the profile, not here. This row is
-- the reading's bookkeeping: whether one runs, what it has read, what a person
-- dismissed, and how a past project is to be closed once it is reviewed.
--
-- ## The row
--
-- One per project (`project_id` unique). `mode` is `closing` exactly when
-- `closing` holds the intent (`{ outcome, startedOn?, endedOn }`,
-- `closingIntentSchema` in `lib/project-intake/types.ts`): a past project is
-- created active, read, and closed when the review is finished, because a
-- closed project refuses profile writes (ADR-0090).
--
-- `description` is the person's „Worum geht es?" at creation, at most 500
-- characters; `location` the geocoder's hit when one was chosen.
--
-- `documents_read` is `[{ documentId, contentHash }]`: a new Fassung has a new
-- hash and is read again. `dismissed` is `[{ key, value }]`, so a value a
-- person dismissed is not suggested again. Both arrays, never null.
--
-- ## The lifecycle
--
-- waiting → reading → ready | failed → reading … → completed. `job_id` is the
-- current or last reading's research job and is set whenever the status is
-- `reading`; every internal op carries it, and a run whose `jobId` is no
-- longer the row's is refused (`stale-reading`). Partial unique, because the
-- outcome route finds the intake by it. `rerun_requested` records a trigger
-- that arrived during a reading. `completed_at` and `completed_by` are set
-- exactly when the review was finished.
--
-- ## RLS
--
-- A tenant table: the organization, AND the project's organization, so a row
-- cannot be planted on another tenant's project. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "project_intakes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "mode" text DEFAULT 'active' NOT NULL,
  "description" text,
  "location" jsonb,
  "closing" jsonb,
  "status" text DEFAULT 'waiting' NOT NULL,
  "job_id" text,
  "requested_by" text,
  "trace_id" text,
  "rerun_requested" boolean DEFAULT false NOT NULL,
  "documents_read" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "dismissed" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "counts" jsonb,
  "summary" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "completed_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_intakes_project_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT project_intakes_status_known
    CHECK ("status" IN ('waiting', 'reading', 'ready', 'failed', 'completed')),
  CONSTRAINT project_intakes_mode_known
    CHECK ("mode" IN ('active', 'closing')),
  CONSTRAINT project_intakes_closing_when_closing
    CHECK (("mode" = 'closing') = ("closing" IS NOT NULL)),
  CONSTRAINT project_intakes_closing_object
    CHECK ("closing" IS NULL OR jsonb_typeof("closing") = 'object'),
  CONSTRAINT project_intakes_location_object
    CHECK ("location" IS NULL OR jsonb_typeof("location") = 'object'),
  CONSTRAINT project_intakes_counts_object
    CHECK ("counts" IS NULL OR jsonb_typeof("counts") = 'object'),
  CONSTRAINT project_intakes_description_length
    CHECK ("description" IS NULL OR char_length("description") <= 500),
  CONSTRAINT project_intakes_completion_complete
    CHECK (
      ("status" = 'completed') = ("completed_at" IS NOT NULL)
      AND ("completed_at" IS NULL) = ("completed_by" IS NULL)
    ),
  CONSTRAINT project_intakes_job_when_reading
    CHECK ("status" <> 'reading' OR "job_id" IS NOT NULL),
  CONSTRAINT project_intakes_documents_read_array
    CHECK (jsonb_typeof("documents_read") = 'array'),
  CONSTRAINT project_intakes_dismissed_array
    CHECK (jsonb_typeof("dismissed") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_intakes_project"
  ON "project_intakes" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_intakes_job"
  ON "project_intakes" ("job_id")
  WHERE "job_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_intakes_organization_id"
  ON "project_intakes" ("organization_id");
--> statement-breakpoint
SELECT grid_secure_table('project_intakes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
