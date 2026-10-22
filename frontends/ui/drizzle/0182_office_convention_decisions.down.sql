-- Reverse 0182. ORDER: roll the frontend back first; the newer build reads and
-- writes the table.
--
-- Lossy: the decisions are authored, not derived. Dropping them un-declines
-- every declined line and un-confirms every confirmed one. Re-applying 0182
-- does not bring them back.
DROP TABLE IF EXISTS "office_convention_decisions";
