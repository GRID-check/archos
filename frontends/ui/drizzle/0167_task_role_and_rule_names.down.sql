-- Reverse 0167: the German values come back, exactly.
--
-- Every mapping is one to one, so nothing is lost. ORDER: roll the frontend and
-- the Python worker back first; the newer build writes the English values.
UPDATE "tasks" SET "kind" = 'einreichcheck' WHERE "kind" = 'submission_check';
--> statement-breakpoint
UPDATE "task_definitions" SET "kind" = 'einreichcheck' WHERE "kind" = 'submission_check';
--> statement-breakpoint
UPDATE "task_runs" SET "kind" = 'einreichcheck' WHERE "kind" = 'submission_check';
--> statement-breakpoint
WITH "names"("old_role", "new_role") AS (VALUES
  ('bebauungsplan', 'development_plan'),
  ('flaechenwidmungsplan', 'zoning_plan'),
  ('grundbuchauszug', 'land_register_extract'),
  ('lageplan', 'site_plan'),
  ('bestandsplan', 'existing_plans'),
  ('foto_bestand', 'existing_photos'),
  ('gutachten_baugrund', 'expert_report_ground'),
  ('gutachten_laerm', 'expert_report_noise'),
  ('gutachten_schadstoffe', 'expert_report_pollutants'),
  ('vorentwurf_studie', 'preliminary_design_study'),
  ('behoerdenkorrespondenz', 'authority_correspondence'),
  ('vorbescheid', 'preliminary_decision'),
  ('sonstige_projektgrundlage', 'other_project_basis')
)
DELETE FROM "document_roles" "new"
  USING "names", "document_roles" "old"
  WHERE "new"."role" = "names"."new_role"
    AND "old"."role" = "names"."old_role"
    AND "old"."project_id" = "new"."project_id"
    AND "old"."document_id" = "new"."document_id"
    AND "old"."scope_instance_id" IS NOT DISTINCT FROM "new"."scope_instance_id";
--> statement-breakpoint
WITH "names"("old_role", "new_role") AS (VALUES
  ('bebauungsplan', 'development_plan'),
  ('flaechenwidmungsplan', 'zoning_plan'),
  ('grundbuchauszug', 'land_register_extract'),
  ('lageplan', 'site_plan'),
  ('bestandsplan', 'existing_plans'),
  ('foto_bestand', 'existing_photos'),
  ('gutachten_baugrund', 'expert_report_ground'),
  ('gutachten_laerm', 'expert_report_noise'),
  ('gutachten_schadstoffe', 'expert_report_pollutants'),
  ('vorentwurf_studie', 'preliminary_design_study'),
  ('behoerdenkorrespondenz', 'authority_correspondence'),
  ('vorbescheid', 'preliminary_decision'),
  ('sonstige_projektgrundlage', 'other_project_basis')
)
UPDATE "document_roles" SET "role" = "names"."old_role"
  FROM "names"
  WHERE "document_roles"."role" = "names"."new_role";
--> statement-breakpoint
WITH "names"("old_id", "new_id") AS (VALUES
  ('oib4-treppe-steigungsverhaeltnis', 'oib4-stair-rise-run-ratio'),
  ('oib4-tuer-durchgangsbreite', 'oib4-door-clear-width'),
  ('oib3-raumhoehe', 'oib3-room-height'),
  ('oib2-feuerwiderstand-tragend', 'oib2-fire-resistance-load-bearing'),
  ('oib6-u-wert-aussenwand', 'oib6-u-value-external-wall'),
  ('oib6-u-wert-fenster', 'oib6-u-value-window'),
  ('oib5-schalldaemmung-deklariert', 'oib5-sound-insulation-declared')
)
DELETE FROM "bim_check_confirmations" "new"
  USING "names", "bim_check_confirmations" "old"
  WHERE "new"."rule_id" = "names"."new_id"
    AND "old"."rule_id" = "names"."old_id"
    AND "old"."organization_id" = "new"."organization_id"
    AND "old"."project_id" = "new"."project_id"
    AND "old"."model_id" = "new"."model_id";
--> statement-breakpoint
WITH "names"("old_id", "new_id") AS (VALUES
  ('oib4-treppe-steigungsverhaeltnis', 'oib4-stair-rise-run-ratio'),
  ('oib4-tuer-durchgangsbreite', 'oib4-door-clear-width'),
  ('oib3-raumhoehe', 'oib3-room-height'),
  ('oib2-feuerwiderstand-tragend', 'oib2-fire-resistance-load-bearing'),
  ('oib6-u-wert-aussenwand', 'oib6-u-value-external-wall'),
  ('oib6-u-wert-fenster', 'oib6-u-value-window'),
  ('oib5-schalldaemmung-deklariert', 'oib5-sound-insulation-declared')
)
UPDATE "bim_check_confirmations" SET "rule_id" = "names"."old_id"
  FROM "names"
  WHERE "bim_check_confirmations"."rule_id" = "names"."new_id";

-- The task_created cards stored on messages carry the same kind. No other object in a
-- message's metadata has a task kind, so the exact JSON pair is the whole match.
UPDATE messages
SET metadata = replace(metadata::text, '"kind": "submission_check"', '"kind": "einreichcheck"')::jsonb
WHERE metadata::text LIKE '%"kind": "submission_check"%';
