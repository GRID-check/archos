-- 0170: the office shelf's scope value is `office_shelf`, not `archiv`.
--
-- The scope names the shelf a row belongs to (`project` | `archiv` | `session`
-- until now). The value is renamed in the code, on the wire and here, on every
-- table whose rows may still change:
--
--   * `documents.scope`
--   * `project_folders.scope`
--   * `upload_batches.scope`
--   * `proposed_changes.scope`
--
-- Two composite foreign keys carry the scope (`documents` -> `project_folders`,
-- and a folder -> its parent), so a row cannot be rewritten while they stand:
-- both go, the rows move, and both come back. Each CHECK that names the value
-- is dropped and re-added with the English one, NOT VALID first and validated as
-- its own statement so the scan takes the weaker lock.
--
-- NOT touched, on purpose: `document_access_log` and
-- `document_quarantine_decisions`. Their rows are immutable (a trigger refuses
-- an UPDATE), because they are the record of who took which document and what
-- the upload gate decided; rewriting the history to a new spelling is not ours
-- to do. Migration 0171 widens their CHECK to accept both spellings instead, and
-- the readers (`modernizeDocumentScope`) say `office_shelf` for either.
--
-- Rolling out: a pod not yet rolled still writes `archiv` after this ran, and
-- the new CHECKs refuse it. That is the same window every renamed stored value
-- has; the order is database, then frontend, and the frontend reads `archiv`
-- (`LEGACY_DOCUMENT_SCOPES`) wherever it arrives from a peer. Every statement
-- acts only on the old value, so the file can be applied twice.
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
UPDATE "project_folders" SET "scope" = 'office_shelf' WHERE "scope" = 'archiv';
--> statement-breakpoint
UPDATE "documents" SET "scope" = 'office_shelf' WHERE "scope" = 'archiv';
--> statement-breakpoint
UPDATE "upload_batches" SET "scope" = 'office_shelf' WHERE "scope" = 'archiv';
--> statement-breakpoint
UPDATE "proposed_changes" SET "scope" = 'office_shelf' WHERE "scope" = 'archiv';
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_scope_check" CHECK ("scope" IN ('project', 'office_shelf')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "project_folders" VALIDATE CONSTRAINT "project_folders_scope_check";
--> statement-breakpoint
ALTER TABLE "upload_batches"
  ADD CONSTRAINT "upload_batches_scope" CHECK ("scope" IN ('project', 'office_shelf', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "upload_batches" VALIDATE CONSTRAINT "upload_batches_scope";
--> statement-breakpoint
ALTER TABLE "proposed_changes"
  ADD CONSTRAINT "proposed_changes_scope_known" CHECK ("scope" IN ('project', 'office_shelf')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT "proposed_changes_scope_known";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_requires_project"
  CHECK ("folder_id" IS NULL OR "project_id" IS NOT NULL OR "scope" = 'office_shelf') NOT VALID;
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
