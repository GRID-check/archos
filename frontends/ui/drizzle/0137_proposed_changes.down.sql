-- Reverse 0137. ORDER: roll the frontend back first; the newer build creates,
-- reads and applies proposed changes, and its file-operation card shows one.
--
-- Lossy: every proposed change and the record of what applying it did go with
-- the table. The changes that were applied stay applied (they were made to the
-- documents and folders themselves); only the record of who decided them, and
-- the proposals nobody decided yet, are gone. A card in an older chat then
-- names a proposal that no longer exists and says so.
DROP TABLE IF EXISTS "proposed_changes";
