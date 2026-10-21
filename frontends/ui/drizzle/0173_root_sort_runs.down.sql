-- Reverse 0173. ORDER: roll the frontend back first; the newer build reads and
-- writes this table from the root-sort routes and the `root_sort` job.
--
-- Lossy: every run is forgotten, including what an applied run moved, so an
-- applied run can no longer be undone. Queued `root_sort` jobs find no row and
-- end quietly.
DROP TABLE IF EXISTS "root_sort_runs";
