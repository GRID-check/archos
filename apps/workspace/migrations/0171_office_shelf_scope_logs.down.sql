-- Reverse 0171. Refuses while a row written with `office_shelf` stands, because
-- the restored CHECK would refuse it and the rows are immutable: roll the
-- frontend back first, and note that a log row written by the newer build cannot
-- be rewritten (a trigger refuses the UPDATE), so the down only applies to a
-- database that has not logged one yet.
ALTER TABLE "document_access_log" DROP CONSTRAINT IF EXISTS "document_access_log_scope_check";
--> statement-breakpoint
ALTER TABLE "document_access_log"
  ADD CONSTRAINT "document_access_log_scope_check"
  CHECK ("scope" IN ('project', 'archiv', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_access_log" VALIDATE CONSTRAINT "document_access_log_scope_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" DROP CONSTRAINT IF EXISTS "document_quarantine_decisions_scope_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions"
  ADD CONSTRAINT "document_quarantine_decisions_scope_check"
  CHECK ("scope" IN ('project', 'archiv', 'session')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" VALIDATE CONSTRAINT "document_quarantine_decisions_scope_check";
