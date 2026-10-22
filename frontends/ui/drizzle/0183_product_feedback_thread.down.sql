-- Reverse 0183. ORDER: roll the frontend back first; the newer build reads and
-- writes both columns.
--
-- Lossy: without the stored session, no reply from the reporter can reach a
-- ticket opened before the rollback, even after 0183 is applied again. The
-- tickets and their messages stay in PostHog.
ALTER TABLE "product_feedback" DROP CONSTRAINT IF EXISTS "product_feedback_posthog_widget_session_id_shape";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "reporter_seen_at";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "posthog_widget_session_id";
