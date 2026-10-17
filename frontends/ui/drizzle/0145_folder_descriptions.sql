-- 0145: a folder says what belongs in it (docs/ux/file-upload-and-explorer.md,
-- „Ordner, die sagen, was hineingehört").
--
-- A folder was a name and a path. „Bescheide" told a person what it holds and
-- told Piloti nothing it could act on: whether a Fristerstreckung belongs there
-- or in „Korrespondenz" was a guess from one word. The description is a short
-- free text a person writes in the Files workspace: what belongs here. Piloti
-- reads it when it suggests where an upload belongs, and the agents get it
-- with the folder tree.
--
-- Both shelves: a project's Dateien and the Büroablage share this table
-- (ADR-0078, migration 0102), and the two are one workspace.
--
-- NULL is „nobody described it". An empty or whitespace-only text is not a
-- description, so it is refused rather than stored as a second way of saying
-- NULL; at most 500 characters, a sentence or two.
--
-- RLS is unchanged: the column sits on `project_folders`, under its policy.
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS project_folders_description_length;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT project_folders_description_length
  CHECK ("description" IS NULL OR (char_length("description") <= 500 AND btrim("description") <> ''));
