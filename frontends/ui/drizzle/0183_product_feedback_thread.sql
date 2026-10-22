-- 0183: a report's Support ticket becomes a conversation the reporter can read
-- and answer inside Piloti (ADR-0118, amended).
--
-- ## Why
--
-- The platform owners answer a report in PostHog Support. Until now that answer
-- reached nobody: the PostHog widget is switched off, so the reporter had no
-- place to read it. The reporter's thread is now an in-app chat the BFF serves
-- from PostHog's API: the private REST API reads the ticket's messages, and a
-- reply from the reporter goes through the conversations endpoint the ticket
-- was opened through, which only accepts it in the same conversations session.
--
-- ## posthog_widget_session_id
--
-- The conversations session the server opened the ticket in, made up by the
-- server per report. It is what lets the reporter's later replies land on the
-- same ticket. It works like a bearer secret for that one ticket on PostHog's
-- public endpoint, so it never leaves the server: no route returns it. NULL for
-- reports filed before this migration, whose threads can be read but not
-- answered. The CHECK keeps it UUID-shaped.
--
-- ## reporter_seen_at
--
-- When the reporter last opened the thread. A ticket PostHog updated after it
-- (a reply, a status change) shows as new for them. NULL: never opened.
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "posthog_widget_session_id" text;
--> statement-breakpoint
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "reporter_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP CONSTRAINT IF EXISTS "product_feedback_posthog_widget_session_id_shape";
--> statement-breakpoint
ALTER TABLE "product_feedback"
  ADD CONSTRAINT "product_feedback_posthog_widget_session_id_shape"
  CHECK ("posthog_widget_session_id" IS NULL OR "posthog_widget_session_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
