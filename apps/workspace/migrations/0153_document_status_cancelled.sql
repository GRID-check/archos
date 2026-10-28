-- 0153: `documents.status` gains `cancelled` — the eighth value (ADR-0104).
--
-- A person can stop an ingestion that has not finished: a queued job is never
-- claimed, a running worker stops at its next ownership check (before it reads
-- or writes anything), and the row goes `cancelled` rather than `failed` —
-- nothing went wrong, so it must not wear the red "Fehlgeschlagen" or be
-- counted with the failures. Like `stored` and `uploaded` it is neutral: the
-- bytes are here, nothing was indexed, and a re-ingest reads them again.
--
-- Widening the CHECK only admits a value no row holds yet, so nothing has to be
-- rewritten and the validation cannot fail; the two-step NOT VALID / VALIDATE is
-- the 0135 idiom and keeps the ACCESS EXCLUSIVE lock a catalog update while the
-- scan runs under SHARE UPDATE EXCLUSIVE (0049).
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_status_known";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_status_known"
  CHECK ("status" IN ('uploaded', 'pending', 'processing', 'completed', 'failed', 'quarantined', 'stored', 'cancelled'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_status_known";
--> statement-breakpoint
COMMENT ON COLUMN "documents"."status" IS
  'Where reading stands (migration 0153, ADR-0104): uploaded | pending | processing | completed | failed | quarantined | stored | cancelled. Vocabulary and meaning: lib/documents/document-status.ts.';
