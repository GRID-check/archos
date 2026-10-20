-- 0154: how far each export to PostHog has got (ADR-0100,
-- docs/observability/org-spend-in-posthog.md).
--
-- The BFF sends the usage ledger to PostHog as hourly aggregates
-- (`llm_usage_hourly`) and every organization's limits as an hourly
-- `organization_budget_snapshot`. PostHog has no update and no reliable
-- de-duplication at read time, so an hour sent twice is counted twice. The
-- exporter therefore records, per stream, the end of the last hour it handed
-- over, and the next run starts there: each closed hour is sent once, a
-- scheduler that was down catches up, and the first run, finding no row, starts
-- at the backfill horizon and sends the history.
--
-- `lease_until` is the claim: a run sets it before it reads and clears it when
-- it advances the cursor, so two runs (a restart, a second scheduler) never send
-- the same hours. A run that dies leaves a lease that expires on its own.
--
-- Platform bookkeeping, no tenant data: a PLATFORM table for the tenant
-- boundary. Every tenant may read it (two timestamps per stream); only the
-- platform role, which the exporter runs as, may write it.
CREATE TABLE IF NOT EXISTS "analytics_export_cursors" (
  "stream" text PRIMARY KEY NOT NULL,
  -- Everything before this instant has been sent.
  "exported_through" timestamp with time zone NOT NULL,
  -- Set while a run holds the stream; NULL when nobody does.
  "lease_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "analytics_export_cursors_stream_known"
    CHECK ("stream" IN ('posthog_usage_hourly', 'posthog_budget_snapshot'))
);
--> statement-breakpoint
SELECT grid_secure_platform_table('analytics_export_cursors');
