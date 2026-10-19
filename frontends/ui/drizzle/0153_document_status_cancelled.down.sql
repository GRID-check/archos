-- Reverse 0153: `cancelled` leaves the vocabulary.
--
-- A row already at rest there is rewritten to `uploaded` — the neutral at-rest
-- value 0135 chose for any undeclared status — before the CHECK narrows, or the
-- constraint would fail to validate. Lossy for nothing a build before 0153
-- reads: such a build never wrote `cancelled`, and the row's bytes are here
-- either way, so „Erneut lesen“ still reaches it.
UPDATE "documents" SET "status" = 'uploaded' WHERE "status" = 'cancelled';
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_status_known";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_status_known"
  CHECK ("status" IN ('uploaded', 'pending', 'processing', 'completed', 'failed', 'quarantined', 'stored'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_status_known";
--> statement-breakpoint
COMMENT ON COLUMN "documents"."status" IS
  'Where reading stands (migration 0135, ADR-0104): uploaded | pending | processing | completed | failed | quarantined | stored. Vocabulary and meaning: lib/documents/document-status.ts.';
