-- 0162: permit_records.federal_state, the English name of `bundesland`, expand step.
--
-- ## What
--
-- `permit_records.bundesland` holds the intake's Land token the document makes
-- clear (`wien`, `niederoesterreich`, ...). It becomes `federal_state` with the
-- English tokens (`vienna`, `lower_austria`, ...), by the same table as the
-- profile (0159, `legacy-names.json`).
--
-- ## Why two columns for a release
--
-- A column rename is not safe in a rolling deploy: an older pod keeps writing
-- and reading `bundesland` while a new pod uses `federal_state`. So this is the
-- expand half. The new column is added and backfilled, and a trigger keeps the
-- two in step in both directions (a write to either fills the other, with the
-- tokens mapped), so neither pod sees a NULL it should not. The next release
-- reads and writes only `federal_state`; a later migration drops `bundesland`,
-- the trigger and the two functions (the contract half). The Drizzle schema
-- already names only `federal_state`; the old column is not in it, so a new pod
-- never touches it directly.
--
-- ## Re-runnable
--
-- `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE` and a backfill that only fills
-- a NULL `federal_state`. A token the table does not know is copied as it is.
--
-- ## RLS
--
-- No policy changes: a new column on a table whose policies are by row. The
-- backfill runs as the owner.

ALTER TABLE "permit_records" ADD COLUMN IF NOT EXISTS "federal_state" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_permit_federal_state_to_english(token text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE token
    WHEN 'wien' THEN 'vienna'
    WHEN 'niederoesterreich' THEN 'lower_austria'
    WHEN 'oberoesterreich' THEN 'upper_austria'
    WHEN 'steiermark' THEN 'styria'
    WHEN 'kaernten' THEN 'carinthia'
    WHEN 'tirol' THEN 'tyrol'
    WHEN 'ausserhalb_oesterreichs' THEN 'outside_austria'
    ELSE token END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_permit_federal_state_to_legacy(token text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE token
    WHEN 'vienna' THEN 'wien'
    WHEN 'lower_austria' THEN 'niederoesterreich'
    WHEN 'upper_austria' THEN 'oberoesterreich'
    WHEN 'styria' THEN 'steiermark'
    WHEN 'carinthia' THEN 'kaernten'
    WHEN 'tyrol' THEN 'tirol'
    WHEN 'outside_austria' THEN 'ausserhalb_oesterreichs'
    ELSE token END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_permit_federal_state_sync() RETURNS trigger
  LANGUAGE plpgsql AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."federal_state" IS NULL AND NEW."bundesland" IS NOT NULL THEN
      NEW."federal_state" := grid_permit_federal_state_to_english(NEW."bundesland");
    ELSIF NEW."bundesland" IS NULL AND NEW."federal_state" IS NOT NULL THEN
      NEW."bundesland" := grid_permit_federal_state_to_legacy(NEW."federal_state");
    END IF;
  ELSIF NEW."federal_state" IS DISTINCT FROM OLD."federal_state" THEN
    NEW."bundesland" := grid_permit_federal_state_to_legacy(NEW."federal_state");
  ELSIF NEW."bundesland" IS DISTINCT FROM OLD."bundesland" THEN
    NEW."federal_state" := grid_permit_federal_state_to_english(NEW."bundesland");
  END IF;
  RETURN NEW;
END
$f$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS permit_records_federal_state_sync ON "permit_records";
--> statement-breakpoint
CREATE TRIGGER permit_records_federal_state_sync
  BEFORE INSERT OR UPDATE ON "permit_records"
  FOR EACH ROW EXECUTE FUNCTION grid_permit_federal_state_sync();
--> statement-breakpoint
UPDATE "permit_records"
SET "federal_state" = grid_permit_federal_state_to_english("bundesland")
WHERE "federal_state" IS NULL AND "bundesland" IS NOT NULL;
