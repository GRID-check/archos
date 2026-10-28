-- Down of 0162: the pre-0162 shape. `bundesland` has been kept in step with
-- `federal_state` by a trigger since 0162, in German tokens, so nothing needs
-- copying back; the trigger, its functions and the English column go.

DROP TRIGGER IF EXISTS permit_records_federal_state_sync ON "permit_records";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_permit_federal_state_sync();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_permit_federal_state_to_english(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_permit_federal_state_to_legacy(text);
--> statement-breakpoint
ALTER TABLE "permit_records" DROP COLUMN IF EXISTS "federal_state";
