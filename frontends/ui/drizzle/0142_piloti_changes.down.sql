-- Reverse 0142. ORDER: roll the frontend back first; the newer build writes
-- and reads the change record.
--
-- Lossy: which turn made which change, and every undo, is forgotten. The marks
-- themselves are untouched.
DROP TABLE IF EXISTS "piloti_changes";
