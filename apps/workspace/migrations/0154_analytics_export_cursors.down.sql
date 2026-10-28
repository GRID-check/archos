-- Down for 0154. The next export after an up-migration starts again at the
-- backfill horizon and re-sends that history: drop the PostHog events first.
DROP TABLE IF EXISTS "analytics_export_cursors";
