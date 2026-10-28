-- Reverse 0170. ORDER: roll the frontend back first; the newer build writes
-- `office_shelf`, and the restored CHECKs refuse it.
--
-- Exact for the four mutable tables: every `office_shelf` row goes back to
-- `archiv`. An immutable log row (migration 0171) is not touched.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_folder_id_organization_id_scope_fkey";
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_parent_id_organization_id_scope_fkey";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_folder_requires_project";
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_scope_check";
--> statement-breakpoint
ALTER TABLE "upload_batches" DROP CONSTRAINT IF EXISTS "upload_batches_scope";
--> statement-breakpoint
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS "proposed_changes_scope_known";
--> statement-breakpoint
UPDATE "project_folders" SET "scope" = 'archiv' WHERE "scope" = 'office_shelf';
--> statement-breakpoint
UPDATE "documents" SET "scope" = 'archiv' WHERE "scope" = 'office_shelf';
--> statement-breakpoint
UPDATE "upload_batches" SET "scope" = 'archiv' WHERE "scope" = 'office_shelf';
--> statement-breakpoint
UPDATE "proposed_changes" SET "scope" = 'archiv' WHERE "scope" = 'office_shelf';
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_scope_check" CHECK ("scope" IN ('project', 'archiv')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "project_folders" VALIDATE CONSTRAINT "project_folders_scope_check";
--> statement-breakpoint
ALTER TABLE "upload_batches"
  ADD CONSTRAINT "upload_batches_scope" CHECK ("scope" IN ('project', 'archiv', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "upload_batches" VALIDATE CONSTRAINT "upload_batches_scope";
--> statement-breakpoint
ALTER TABLE "proposed_changes"
  ADD CONSTRAINT "proposed_changes_scope_known" CHECK ("scope" IN ('project', 'archiv')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT "proposed_changes_scope_known";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_requires_project"
  CHECK ("folder_id" IS NULL OR "project_id" IS NOT NULL OR "scope" = 'archiv') NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_folder_requires_project";
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_parent_id_organization_id_scope_fkey"
  FOREIGN KEY ("parent_id", "organization_id", "scope")
  REFERENCES "project_folders" ("id", "organization_id", "scope") NOT VALID;
--> statement-breakpoint
ALTER TABLE "project_folders" VALIDATE CONSTRAINT "project_folders_parent_id_organization_id_scope_fkey";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_id_organization_id_scope_fkey"
  FOREIGN KEY ("folder_id", "organization_id", "scope")
  REFERENCES "project_folders" ("id", "organization_id", "scope")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_folder_id_organization_id_scope_fkey";
