-- Reverse 0169: the German skill names come back, exactly.
--
-- Every mapping is one to one. A standing prompt that a person wrote with the
-- new name in the meantime is rewritten back too: the old name is what the
-- build this reverses to resolves. ORDER: roll the frontend and the Python agent
-- back first; the newer build resolves skills by the English names only.
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
)
DELETE FROM "platform_skills" "old"
  USING "names", "platform_skills" "new"
  WHERE "old"."name" = "names"."old_name" AND "new"."name" = "names"."new_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
)
UPDATE "platform_skills" SET "name" = "names"."new_name"
  FROM "names"
  WHERE "platform_skills"."name" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
)
DELETE FROM "curated_skill_activations" "old"
  USING "names", "curated_skill_activations" "new"
  WHERE "old"."skill_name" = "names"."old_name"
    AND "new"."skill_name" = "names"."new_name"
    AND "new"."organization_id" = "old"."organization_id";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
)
UPDATE "curated_skill_activations" SET "skill_name" = "names"."new_name"
  FROM "names"
  WHERE "curated_skill_activations"."skill_name" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
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
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
)
UPDATE "skills" SET "cloned_from" = "names"."new_name"
  FROM "names"
  WHERE "skills"."origin" = 'platform-clone' AND "skills"."cloned_from" = "names"."old_name";
--> statement-breakpoint
WITH "names"("old_name", "new_name") AS (VALUES
  ('submission-check', 'einreichcheck'),
  ('fire-safety', 'brandschutz'),
  ('existing-building', 'bestand'),
  ('safety-in-use', 'nutzungssicherheit'),
  ('building-class', 'gebaeudeklasse'),
  ('thermal-protection', 'waermeschutz'),
  ('plot-development', 'bebauung'),
  ('inspection-report-writer', 'pruefbericht-writer')
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
    'submission-check:einreichcheck',
    'fire-safety:brandschutz',
    'existing-building:bestand',
    'safety-in-use:nutzungssicherheit',
    'building-class:gebaeudeklasse',
    'thermal-protection:waermeschutz',
    'plot-development:bebauung',
    'inspection-report-writer:pruefbericht-writer'
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
