-- Reverse 0166: the German kinds come back, exactly.
--
-- The mapping is one to one in each table (`information_request` is the
-- Nachforderung in both), so nothing is lost. ORDER: roll the frontend and the
-- Python worker back first; the newer build writes the English kinds, which the
-- restored CHECK refuses.
ALTER TABLE "permit_records" DROP CONSTRAINT IF EXISTS "permit_records_kind_check";
--> statement-breakpoint
UPDATE "permit_records"
  SET "kind" = CASE "kind"
    WHEN 'approval' THEN 'bewilligung'
    WHEN 'information_request' THEN 'nachforderung'
    WHEN 'refusal' THEN 'ablehnung'
    WHEN 'other' THEN 'sonstiges'
  END
  WHERE "kind" IN ('approval', 'information_request', 'refusal', 'other');
--> statement-breakpoint
ALTER TABLE "permit_records"
  ADD CONSTRAINT "permit_records_kind_check"
  CHECK ("kind" IN ('bewilligung', 'nachforderung', 'ablehnung', 'sonstiges'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "permit_records" VALIDATE CONSTRAINT "permit_records_kind_check";
--> statement-breakpoint
ALTER TABLE "permit_requirements" DROP CONSTRAINT IF EXISTS "permit_requirements_kind_check";
--> statement-breakpoint
UPDATE "permit_requirements"
  SET "kind" = CASE "kind"
    WHEN 'condition' THEN 'auflage'
    WHEN 'information_request' THEN 'nachforderung'
    WHEN 'note' THEN 'hinweis'
  END
  WHERE "kind" IN ('condition', 'information_request', 'note');
--> statement-breakpoint
ALTER TABLE "permit_requirements"
  ADD CONSTRAINT "permit_requirements_kind_check"
  CHECK ("kind" IN ('auflage', 'nachforderung', 'hinweis'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "permit_requirements" VALIDATE CONSTRAINT "permit_requirements_kind_check";
