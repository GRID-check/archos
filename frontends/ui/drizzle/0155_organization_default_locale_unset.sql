-- 0155: `organizations.default_locale` can say "nobody chose one".
--
-- The column was NOT NULL DEFAULT 'en', and nothing could tell 'en' chosen from
-- 'en' defaulted: every write of the row re-wrote the default it read
-- (`writeOrgSettings` merges the whole row, so saving the display name, the
-- Aufwand dial or the upload screening stored 'en'), and the settings form
-- preselected English. The client then applied that value to every member who
-- had not picked a language, so a German office's interface switched to
-- English after the first paint (pilot onboarding, 19.10.2026).
--
-- NULL now means "not chosen": members start in their own browser's language.
-- Every stored 'en' becomes NULL, because none of them is known to be a
-- choice; an office that wants English for members who never picked sets it
-- again under Organisation → Einstellungen. 'de' was never a default, so a 'de'
-- row is a choice and stays. The CHECK refuses anything but a supported
-- language, so an unknown value cannot be read as "chosen" again.
ALTER TABLE "organizations" ALTER COLUMN "default_locale" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "default_locale" DROP DEFAULT;
--> statement-breakpoint
UPDATE "organizations" SET "default_locale" = NULL WHERE "default_locale" IS DISTINCT FROM 'de';
--> statement-breakpoint
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_default_locale_known"
  CHECK ("default_locale" IS NULL OR "default_locale" IN ('de', 'en'));
--> statement-breakpoint
COMMENT ON COLUMN "organizations"."default_locale" IS
  'The interface language for members who never picked one (migration 0155): de | en, NULL until an admin chooses. Read by i18n/request-locale.ts and I18nProvider.';
