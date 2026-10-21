-- Reverse 0175. ORDER: roll the frontend back first; the newer build reads and
-- writes the asks.
--
-- Lossy: the record of every ask goes with its table. The conversations the
-- asks ran in, and their questions and answers, stay: they are the person's
-- threads like any other.
DROP TABLE IF EXISTS "piloti_asks";
