-- 0144: the indexes „Was Piloti tut" reads by (docs/architecture/piloti-activity.md).
--
-- The view lists, for one project, the wakes of Piloti still running and the
-- ones that ended lately, the turns' changes to Anmerkungen lately, and the
-- proposals decided lately. Each read is bounded (LIMIT cap + 1) and ordered
-- newest first by its own time column, so each wants an index it can walk in
-- that order instead of sorting every row the organization has:
--
-- * `piloti_wakes` has no project column; a wake reaches its project through
--   its document. The two reads walk the organization's wakes by time and join
--   the document: the live ones (partial, `queued`/`started`, a handful at any
--   time) by `created_at`, the ended ones by `ended_at`.
-- * `piloti_changes` likewise: by organization and `created_at`. The existing
--   `idx_piloti_changes_origin` leads with the answer message, for one turn's
--   card, and does not serve a read by time.
-- * `proposed_changes` has its project: the decided ones by project and
--   `decided_at` (partial: an open proposal has none). The open ones are
--   served by `idx_proposed_changes_project_created` (0140).
--
-- Indexes only: no table, no row and no policy changes, so nothing here moves
-- the tenant boundary.
CREATE INDEX IF NOT EXISTS "idx_piloti_wakes_live"
  ON "piloti_wakes" ("organization_id", "created_at" DESC)
  WHERE "status" IN ('queued', 'started');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_wakes_ended"
  ON "piloti_wakes" ("organization_id", "ended_at" DESC)
  WHERE "ended_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_changes_org_created"
  ON "piloti_changes" ("organization_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposed_changes_project_decided"
  ON "proposed_changes" ("project_id", "decided_at" DESC)
  WHERE "decided_at" IS NOT NULL;
