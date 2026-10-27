-- Reverse 0186. ORDER: roll the frontend back first; the newer build reads and
-- writes the table.
--
-- Lossy: the saved questions are authored by people and go with the table.
DROP TABLE IF EXISTS "saved_searches";
