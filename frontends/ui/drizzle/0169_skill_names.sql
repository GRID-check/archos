-- 0169: English names for the builtin skills.
--
--   einreichcheck -> submission-check     brandschutz -> fire-safety
--   bestand -> existing-building          nutzungssicherheit -> safety-in-use
--   gebaeudeklasse -> building-class      waermeschutz -> thermal-protection
--   bebauung -> plot-development          pruefbericht-writer -> inspection-report-writer
--   (hygiene already read English and stays)
--
-- A skill's name is the token people type after a slash and the key an
-- organization's decision refers to, so it is stored in several places and
-- all of them move together:
--
--   * `platform_skills.name` (a dashboard row named like a builtin).
--   * `curated_skill_activations.skill_name`: an organization that switched a
--     playbook off keeps it off under the new name.
--   * `skills`: an organization's clone of a builtin keeps shadowing it. Only a
--     clone that kept the builtin's own name is renamed, and `cloned_from` is
--     rewritten on every clone; an org's own skill with a German name is theirs.
--   * `jobs.skill_name` and the name inside `skill_snapshot`, and the
--     `/<name>` token in a standing prompt (`jobs.prompt`,
--     `task_definitions.plan`), so a schedule that says "/einreichcheck" keeps
--     naming the skill. Finished runs and the messages they wrote are history
--     and are left; the old names also still work as typed aliases
--     (`LEGACY_SKILL_NAMES`), so nothing that names a skill the old way breaks.
--
-- Where a row for the new name already exists the old-valued row is dropped
-- first (only reachable when an older pod wrote an activation after this ran),
-- so the file can be applied twice.
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
DELETE FROM "platform_skills" "old"
  USING "names", "platform_skills" "new"
  WHERE "old"."name" = "names"."old_name" AND "new"."name" = "names"."new_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
UPDATE "platform_skills" SET "name" = "names"."new_name"
  FROM "names"
  WHERE "platform_skills"."name" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
DELETE FROM "curated_skill_activations" "old"
  USING "names", "curated_skill_activations" "new"
  WHERE "old"."skill_name" = "names"."old_name"
    AND "new"."skill_name" = "names"."new_name"
    AND "new"."organization_id" = "old"."organization_id";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
UPDATE "curated_skill_activations" SET "skill_name" = "names"."new_name"
  FROM "names"
  WHERE "curated_skill_activations"."skill_name" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
UPDATE "skills" SET "name" = "names"."new_name"
  FROM "names"
  WHERE "skills"."origin" = 'platform-clone'
    AND "skills"."name" = "names"."old_name"
    AND "skills"."cloned_from" = "names"."old_name"
    AND NOT EXISTS (
      SELECT 1 FROM "skills" "other"
      WHERE "other"."organization_id" = "skills"."organization_id" AND "other"."name" = "names"."new_name"
    );
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
UPDATE "skills" SET "cloned_from" = "names"."new_name"
  FROM "names"
  WHERE "skills"."origin" = 'platform-clone' AND "skills"."cloned_from" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('einreichcheck', 'submission-check'),
  ('brandschutz', 'fire-safety'),
  ('bestand', 'existing-building'),
  ('nutzungssicherheit', 'safety-in-use'),
  ('gebaeudeklasse', 'building-class'),
  ('waermeschutz', 'thermal-protection'),
  ('bebauung', 'plot-development'),
  ('pruefbericht-writer', 'inspection-report-writer')
)
UPDATE "jobs" SET
  "skill_name" = "names"."new_name",
  "skill_snapshot" = CASE
    WHEN "jobs"."skill_snapshot" ->> 'name' = "names"."old_name"
      THEN jsonb_set("jobs"."skill_snapshot", '{name}', to_jsonb("names"."new_name"))
    ELSE "jobs"."skill_snapshot"
  END
  FROM "names"
  WHERE "jobs"."skill_name" = "names"."old_name";
--> statement-breakpoint
DO $$
DECLARE
  pair text[];
  renames text[] := ARRAY[
    'einreichcheck:submission-check',
    'brandschutz:fire-safety',
    'bestand:existing-building',
    'nutzungssicherheit:safety-in-use',
    'gebaeudeklasse:building-class',
    'waermeschutz:thermal-protection',
    'bebauung:plot-development',
    'pruefbericht-writer:inspection-report-writer'
  ];
  entry text;
BEGIN
  FOREACH entry IN ARRAY renames LOOP
    pair := string_to_array(entry, ':');
    UPDATE "jobs"
      SET "prompt" = regexp_replace("prompt", '(^|[[:space:]])/' || pair[1] || '(?![[:alnum:]_/-])', '\1/' || pair[2], 'g')
      WHERE "prompt" ~ ('(^|[[:space:]])/' || pair[1] || '(?![[:alnum:]_/-])');
    UPDATE "task_definitions"
      SET "plan" = jsonb_set("plan", '{skill,name}', to_jsonb(pair[2]))
      WHERE "plan" #>> '{skill,name}' = pair[1];
    UPDATE "task_definitions"
      SET "plan" = jsonb_set(
        "plan",
        '{prompt}',
        to_jsonb(regexp_replace("plan" ->> 'prompt', '(^|[[:space:]])/' || pair[1] || '(?![[:alnum:]_/-])', '\1/' || pair[2], 'g'))
      )
      WHERE ("plan" ->> 'prompt') ~ ('(^|[[:space:]])/' || pair[1] || '(?![[:alnum:]_/-])');
  END LOOP;
END
$$;
