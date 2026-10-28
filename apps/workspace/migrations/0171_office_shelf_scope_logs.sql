-- 0171: the two append-only tables accept `office_shelf` beside `archiv`.
--
-- `document_access_log` (who took which document) and
-- `document_quarantine_decisions` (what the upload gate decided) are records,
-- and a trigger on each refuses an UPDATE. Their old rows keep the scope they
-- were written under (`archiv`); new rows are written with `office_shelf`
-- (migration 0170 renamed the value everywhere that may change). So the CHECK
-- widens to both spellings, and every reader says `office_shelf` for either
-- (`modernizeDocumentScope`). The legacy value leaves the CHECK when retention
-- has deleted the last row that holds it, in a later migration.
--
-- Idempotent: the constraint is dropped and added by name.
ALTER TABLE "document_access_log" DROP CONSTRAINT IF EXISTS "document_access_log_scope_check";
--> statement-breakpoint
ALTER TABLE "document_access_log"
  ADD CONSTRAINT "document_access_log_scope_check"
  CHECK ("scope" IN ('project', 'office_shelf', 'archiv', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_access_log" VALIDATE CONSTRAINT "document_access_log_scope_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" DROP CONSTRAINT IF EXISTS "document_quarantine_decisions_scope_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions"
  ADD CONSTRAINT "document_quarantine_decisions_scope_check"
  CHECK ("scope" IN ('project', 'office_shelf', 'archiv', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" VALIDATE CONSTRAINT "document_quarantine_decisions_scope_check";
