-- 0181: the office's conventions as Piloti counted them (ADR-0129).
--
-- ## What was missing
--
-- Every document's project, folder, file name, Dokumentart and title-block
-- facts were recorded, one document at a time, and nothing counted them
-- across the office. A question "wo legen wir Gutachten ab?" was answered from
-- one project's tree. The extractor (`lib/office-conventions/extract.ts`)
-- counts the folder skeleton, where each Dokumentart is filed, the Plannummer
-- shape, the Index style and the date in file names; this row keeps the result.
--
-- ## The row
--
-- One per organization, derived and replaced whole by the BFF's refresh
-- (`refreshOfficeConventions`). `conventions` and its three companions are set
-- together or not at all: the row is created before the first refresh, by the
-- claim on `refresh_requested_at` that keeps two turns from starting two refreshes.
--
-- ## RLS
--
-- A tenant table keyed by its organization. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "office_conventions" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "conventions" jsonb,
  "extractor_version" integer,
  "source_fingerprint" text,
  "computed_at" timestamp with time zone,
  "refresh_requested_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT office_conventions_computed_together
    CHECK (("conventions" IS NULL) = ("computed_at" IS NULL)
       AND ("conventions" IS NULL) = ("source_fingerprint" IS NULL)
       AND ("conventions" IS NULL) = ("extractor_version" IS NULL))
);
--> statement-breakpoint
SELECT grid_secure_table('office_conventions', 'organization_id = grid_current_org()');
