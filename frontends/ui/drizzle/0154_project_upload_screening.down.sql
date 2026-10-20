-- Reverse 0154. ORDER: roll the frontend back first; the newer build reads this
-- table on every upload into a project.
--
-- Lossy: every project's changes to the office's name terms are forgotten, and
-- uploads are screened with the office's list alone again.
DROP TABLE IF EXISTS "project_upload_screening";
