-- Reverse 0156: the column is NOT NULL DEFAULT 'en' again.
--
-- A NULL ("not chosen") row becomes 'en', which is what a build before 0156
-- read for it anyway. Lossless for that build; the distinction between chosen
-- and defaulted is the thing 0156 added, and it goes.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_default_locale_known";
--> statement-breakpoint
UPDATE "organizations" SET "default_locale" = 'en' WHERE "default_locale" IS NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "default_locale" SET DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "default_locale" SET NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "organizations"."default_locale" IS NULL;
