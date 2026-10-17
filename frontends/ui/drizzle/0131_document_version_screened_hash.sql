-- 0131: a version records the verdict on its own bytes (ADR-0086, ADR-0054).
--
-- A screening verdict lived only on the item: `documents.screened_hash` (0123)
-- names the bytes `screening_outcome` judged, and the upload's replace resets
-- both, because the new bytes are unscreened. So once a re-upload replaced a
-- version, nothing on record said whether ITS bytes had passed, and the BFF
-- refused every earlier upload of a person's document to everyone but its
-- uploader and the quarantine's reviewers: the screened ones too, which took
-- Öffnen, Herunterladen and the comparison out of the „Fassungen und Freigabe"
-- timeline for every ordinary member.
--
-- `document_versions.screened_hash` is the `content_hash` of the version's
-- bytes when a verdict passed them. It counts only while it equals
-- `content_hash` (`versionBytesPassedScreening`), the same binding 0123 gave
-- the item, so a content write that swaps a version's bytes leaves it behind.
-- One writer, `recordVersionVerdict` (`lib/documents/repository.ts`), in the
-- transaction that records the item's verdict: the reconcile sets it on every
-- version of the document holding the bytes a completed job judged and clears
-- it on a quarantine of those bytes; a reviewer's release sets it on the
-- released bytes. A forked draft carries its source's value with the bytes.
--
-- BACKFILL. Set only where the rows prove a passing verdict about exactly
-- these bytes; everything else stays NULL, refused to a member:
--
--   1. The item's verdict, when it is about this version's bytes and passes:
--      `documents.screened_hash = content_hash` and the verdict passes by the
--      rule in `verdictPasses` (`lib/documents/document-reader.ts`): not
--      quarantined, and a passing outcome or, with none, a settled read. This
--      is every published version a member can open today, and it is what
--      keeps it openable once a re-upload supersedes it.
--   2. A reviewer's release of these bytes: `screening_released_hash =
--      content_hash`. A release is a person's verdict about named bytes, and
--      the replace does not reset it, so it survives a later re-upload. Unless
--      the item is quarantined on those same bytes again now: then the latest
--      verdict about them holds them.
--
-- Not set, and why: a version superseded before this migration whose item
-- verdict a re-upload has since reset. Nothing on record says whether its bytes
-- passed: the replace erased the verdict, the quarantine decisions record holds
-- but not passes, and whether the item was held while those bytes were current
-- is not kept anywhere. That includes versions uploaded before screening
-- existed (ADR-0086, 2026-10-01). RISK, accepted: such an earlier upload stays
-- closed to ordinary members (its uploader and the reviewers still open it),
-- which is the behaviour before this migration. Guessing a pass would hand a
-- member bytes that may have been replaced precisely because they were held.
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "screened_hash" text;
--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."screened_hash" IS
  'content_hash of this version''s bytes when a screening verdict passed them (ADR-0086, migration 0131). Counts only while it equals content_hash. Written with the item''s verdict by recordVersionVerdict.';
--> statement-breakpoint
UPDATE "document_versions" AS v
SET "screened_hash" = v."content_hash"
FROM "documents" AS d
WHERE d."id" = v."document_id"
  AND d."organization_id" = v."organization_id"
  AND v."screened_hash" IS NULL
  AND v."content_hash" IS NOT NULL
  AND d."screened_hash" = v."content_hash"
  AND d."status" <> 'quarantined'
  AND (
    d."screening_outcome" IN ('clean', 'partial', 'unchecked', 'released')
    OR (
      d."screening_outcome" IS NULL
      AND d."status" IN ('completed', 'ready', 'ingested', 'success', 'processed')
    )
  );
--> statement-breakpoint
UPDATE "document_versions" AS v
SET "screened_hash" = v."content_hash"
FROM "documents" AS d
WHERE d."id" = v."document_id"
  AND d."organization_id" = v."organization_id"
  AND v."screened_hash" IS NULL
  AND v."content_hash" IS NOT NULL
  AND d."screening_released_hash" = v."content_hash"
  AND NOT (d."status" = 'quarantined' AND d."content_hash" IS NOT DISTINCT FROM v."content_hash");
