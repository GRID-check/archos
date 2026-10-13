-- 0133: a project's profile always has its four parts.
--
-- ## Why
--
-- `projects.profile` was `jsonb NOT NULL DEFAULT '{}'`, so a project whose
-- intake was never saved stored `{}`, and every reader had to remember that a
-- profile may lack `facts`. Two did not: `findProjectInOrg` (the settings
-- overview, „Ähnliche Projekte") and `getProjectOverviewData` (the close
-- dialog's debrief). Both crashed in `answersFromProfile` on
-- `Object.keys(profile.facts)`. Salvaging in each reader fixed each reader; the
-- next one would have crashed again. The shape belongs to the row.
--
-- ## What
--
-- The default becomes exactly `emptyProjectProfile()`
-- (`ProjectProfileSchema.parse({})`), and a CHECK holds the four parts to their
-- JSON types: `facts`, `goals` and `assumptions` objects, `unknowns` an array.
-- What is inside them stays the application's (`ProjectProfileSchema`); the
-- database only guarantees a reader can enumerate them. Every writer already
-- passes the schema (`saveProjectProfile` parses the body, a patch goes through
-- `applyProjectProfilePatch`), and `insertProject` takes the default.
--
-- ## The backfill
--
-- Every row lacking the shape gets it: each part kept when it has the right
-- type, an empty one otherwise, and any other top-level key kept. A profile
-- that is not an object at all becomes the empty profile. `profile_version` is
-- left alone: the content a reader sees through the salvage is unchanged, so
-- an open wizard's optimistic lock should not fail over it.

UPDATE "projects"
  SET "profile" =
    (CASE WHEN jsonb_typeof("profile") = 'object' THEN "profile" ELSE '{}'::jsonb END)
    || jsonb_build_object(
      'facts', CASE WHEN jsonb_typeof("profile"->'facts') = 'object' THEN "profile"->'facts' ELSE '{}'::jsonb END,
      'goals', CASE WHEN jsonb_typeof("profile"->'goals') = 'object' THEN "profile"->'goals' ELSE '{}'::jsonb END,
      'unknowns', CASE WHEN jsonb_typeof("profile"->'unknowns') = 'array' THEN "profile"->'unknowns' ELSE '[]'::jsonb END,
      'assumptions', CASE WHEN jsonb_typeof("profile"->'assumptions') = 'object' THEN "profile"->'assumptions' ELSE '{}'::jsonb END
    )
  WHERE jsonb_typeof("profile") IS DISTINCT FROM 'object'
     OR jsonb_typeof("profile"->'facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof("profile"->'goals') IS DISTINCT FROM 'object'
     OR jsonb_typeof("profile"->'unknowns') IS DISTINCT FROM 'array'
     OR jsonb_typeof("profile"->'assumptions') IS DISTINCT FROM 'object';
--> statement-breakpoint
ALTER TABLE "projects"
  ALTER COLUMN "profile" SET DEFAULT '{"facts":{},"goals":{},"unknowns":[],"assumptions":{}}'::jsonb;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_profile_shape_check";
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_profile_shape_check" CHECK (
    -- IS NOT DISTINCT FROM, never `=`: a missing part is NULL, and a CHECK
    -- whose expression is NULL passes, so `= 'object'` would accept `{}`.
    jsonb_typeof("profile"->'facts') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("profile"->'goals') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("profile"->'unknowns') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof("profile"->'assumptions') IS NOT DISTINCT FROM 'object'
  );
--> statement-breakpoint
COMMENT ON COLUMN "projects"."profile" IS
  'The project profile (ProjectProfileSchema). Always has facts, goals and assumptions objects and an unknowns array (0133); an unsaved intake is the empty profile, never {}.';
