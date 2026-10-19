-- Reverse 0145. ORDER: roll the frontend back first; the newer build reads and
-- writes folder descriptions.
--
-- Lossy: every folder forgets what a person wrote it holds.
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS project_folders_description_length;
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "description";
