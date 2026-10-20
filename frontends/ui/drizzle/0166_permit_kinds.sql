-- 0166: English kinds on permit records and their requirements.
--
--   permit_records.kind        bewilligung | nachforderung | ablehnung | sonstiges
--                          ->  approval    | information_request | refusal | other
--   permit_requirements.kind   auflage | nachforderung | hinweis
--                          ->  condition | information_request | note
--
-- Each CHECK is dropped, the rows are rewritten, and the new CHECK goes on NOT
-- VALID and is validated, the 0135 idiom: the scan runs under SHARE UPDATE
-- EXCLUSIVE and the table is never locked against writes for it. The rewrite
-- touches only a row that still holds an old value, so the file can be applied
-- twice. These are derived index data (re-extraction replaces them), and the
-- write route maps a German kind a worker that has not rolled yet still sends
-- (`LEGACY_PERMIT_RECORD_KINDS`), so nothing writes the old name again.
ALTER TABLE "permit_records" DROP CONSTRAINT IF EXISTS "permit_records_kind_check";
--> statement-breakpoint
UPDATE "permit_records"
  SET "kind" = CASE "kind"
    WHEN 'bewilligung' THEN 'approval'
    WHEN 'nachforderung' THEN 'information_request'
    WHEN 'ablehnung' THEN 'refusal'
    WHEN 'sonstiges' THEN 'other'
  END
  WHERE "kind" IN ('bewilligung', 'nachforderung', 'ablehnung', 'sonstiges');
--> statement-breakpoint
ALTER TABLE "permit_records"
  ADD CONSTRAINT "permit_records_kind_check"
  CHECK ("kind" IN ('approval', 'information_request', 'refusal', 'other'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "permit_records" VALIDATE CONSTRAINT "permit_records_kind_check";
--> statement-breakpoint
ALTER TABLE "permit_requirements" DROP CONSTRAINT IF EXISTS "permit_requirements_kind_check";
--> statement-breakpoint
UPDATE "permit_requirements"
  SET "kind" = CASE "kind"
    WHEN 'auflage' THEN 'condition'
    WHEN 'nachforderung' THEN 'information_request'
    WHEN 'hinweis' THEN 'note'
  END
  WHERE "kind" IN ('auflage', 'nachforderung', 'hinweis');
--> statement-breakpoint
ALTER TABLE "permit_requirements"
  ADD CONSTRAINT "permit_requirements_kind_check"
  CHECK ("kind" IN ('condition', 'information_request', 'note'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "permit_requirements" VALIDATE CONSTRAINT "permit_requirements_kind_check";
