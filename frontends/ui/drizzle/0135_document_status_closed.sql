-- 0135: `documents.status` holds one of seven values, and the database says so
-- (ADR-0104, rule 8).
--
-- The column was open `text` on purpose (0063: "a new state is a TypeScript
-- change rather than a migration"), and that is how it came to hold three
-- vocabularies: the schema documented `pending → processing → processed |
-- error`, the reconcile writes `completed` and `failed`, and the badge knew
-- eleven spellings. `document-status.ts` recorded the disagreement and said it
-- did not resolve it. This resolves it at the one layer every writer passes
-- through.
--
-- The seven are exactly what this repository writes (the writer scan in
-- `lib/documents/document-status.spec.ts`, plus `lib/projects/folder-bin-
-- repository.ts` and `lib/storage/repository.ts`):
--
--   uploaded     the bytes are here and nothing was dispatched yet (a row's
--                birth status, a replaced row, a released hold)
--   pending      an ingest job was queued for the row
--   processing   the BFF is working on it locally (IFC, Office rendition,
--                a placement re-read)
--   completed    read; Piloti can cite it
--   failed       the read went wrong
--   quarantined  the content check holds it (ADR-0086)
--   stored       the bytes are here and deliberately not read (a Piloti
--                document nobody published, an archived document)
--
-- 1. Legacy spellings are rewritten to the value they always meant. A row in
--    `ingesting` with a job to ask about becomes `pending`, so the reconcile
--    finishes it; one without becomes `uploaded`, which is at rest and can be
--    read again. Anything else nobody declared becomes `uploaded` for the same
--    reason: it is never shown as citable, and „Erneut lesen“ reaches it.
-- 2. The default becomes `uploaded`, the status every insert writes. `pending`
--    as a default described a job that nothing had queued.
-- 3. The CHECK, NOT VALID and then validated, so the ACCESS EXCLUSIVE lock is a
--    catalog update and the scan runs under SHARE UPDATE EXCLUSIVE (0049).
--
-- Run as the owner, which row-level security exempts (0031), so step 1 rewrites
-- every tenant's rows.
UPDATE "documents"
SET "status" = CASE
  WHEN lower("status") IN ('completed', 'ready', 'ingested', 'success', 'processed') THEN 'completed'
  WHEN lower("status") IN ('failed', 'error') THEN 'failed'
  WHEN lower("status") = 'pending' THEN 'pending'
  WHEN lower("status") = 'ingesting' AND "metadata" ? 'ingestJobId' THEN 'pending'
  WHEN lower("status") = 'processing' THEN 'processing'
  WHEN lower("status") = 'quarantined' THEN 'quarantined'
  WHEN lower("status") = 'stored' THEN 'stored'
  ELSE 'uploaded'
END
WHERE "status" NOT IN ('uploaded', 'pending', 'processing', 'completed', 'failed', 'quarantined', 'stored');
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "status" SET DEFAULT 'uploaded';
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
