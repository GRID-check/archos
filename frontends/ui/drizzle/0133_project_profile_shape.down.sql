-- Reverse 0133: the profile's shape is the readers' problem again.
--
-- The CHECK goes and the default is `{}` again. The backfilled rows keep their
-- four parts: an older build reads the empty profile exactly as it reads `{}`,
-- through the salvage, and has nothing to restore them to.
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_profile_shape_check";
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "profile" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
COMMENT ON COLUMN "projects"."profile" IS NULL;
