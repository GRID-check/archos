-- Reverse 0180. ORDER: roll the frontend back first; the newer build reads and
-- writes the cards.
--
-- Lossy: the cards go with their table. They are derived (the Python builder
-- recomputes them from the folder's documents), so nothing a person typed is lost.
DROP TABLE IF EXISTS "folder_cards";
