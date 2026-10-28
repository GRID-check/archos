-- 0167: English values for three stored enums with no CHECK to swap.
--
--   tasks / task_definitions / task_runs .kind   einreichcheck -> submission_check
--   document_roles.role                          13 German roles -> English (lib/project-profile/document-roles.ts)
--   bim_check_confirmations.rule_id              7 German rule ids -> English (lib/bim/rules.ts)
--
-- None of the three columns has a CHECK (0075 and 0086 left task kinds to the
-- TypeScript tuple on purpose, and the role and rule id vocabularies are
-- validated at the service boundary), so there is no constraint to swap. Every
-- rewrite touches only a row that still holds an old value, so the file can be
-- applied twice.
--
-- Two of the columns sit in a unique key (a role binding is unique per project,
-- document, role and instance; a confirmation per project, rule and revision).
-- A pod that has not rolled yet can write the old value after this ran, and the
-- next run of this file would then collide with the row the new build wrote
-- for the same key. The statement before each rewrite deletes the old-valued
-- row in that case: the new one is the newer decision.
--
-- Nothing writes the old values again: the write routes map them
-- (`LEGACY_DOCUMENT_ROLES`, `LEGACY_BIM_RULE_IDS`, `LEGACY_TASK_KINDS`).
UPDATE "tasks" SET "kind" = 'submission_check' WHERE "kind" = 'einreichcheck';
--> statement-breakpoint
UPDATE "task_definitions" SET "kind" = 'submission_check' WHERE "kind" = 'einreichcheck';
--> statement-breakpoint
UPDATE "task_runs" SET "kind" = 'submission_check' WHERE "kind" = 'einreichcheck';
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
DELETE FROM "document_roles" "old"
  USING "names", "document_roles" "new"
  WHERE "old"."role" = "names"."old_role"
    AND "new"."role" = "names"."new_role"
    AND "new"."project_id" = "old"."project_id"
    AND "new"."document_id" = "old"."document_id"
    AND "new"."scope_instance_id" IS NOT DISTINCT FROM "old"."scope_instance_id";
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
UPDATE "document_roles" SET "role" = "names"."new_role"
  FROM "names"
  WHERE "document_roles"."role" = "names"."old_role";
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
DELETE FROM "bim_check_confirmations" "old"
  USING "names", "bim_check_confirmations" "new"
  WHERE "old"."rule_id" = "names"."old_id"
    AND "new"."rule_id" = "names"."new_id"
    AND "new"."organization_id" = "old"."organization_id"
    AND "new"."project_id" = "old"."project_id"
    AND "new"."model_id" = "old"."model_id";
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
UPDATE "bim_check_confirmations" SET "rule_id" = "names"."new_id"
  FROM "names"
  WHERE "bim_check_confirmations"."rule_id" = "names"."old_id";

-- The task_created cards stored on messages carry the same kind. No other object in a
-- message's metadata has a task kind, so the exact JSON pair is the whole match.
UPDATE messages
SET metadata = replace(metadata::text, '"kind": "einreichcheck"', '"kind": "submission_check"')::jsonb
WHERE metadata::text LIKE '%"kind": "einreichcheck"%';
