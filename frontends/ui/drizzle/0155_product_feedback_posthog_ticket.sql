-- 0155: product feedback is triaged in PostHog Support (ADR-0118).
--
-- ## Why
--
-- Platform → Feedback kept its own triage (`status`, `triaged_by`,
-- `triaged_at`) beside the PostHog Support ticket a report could open, so the
-- same report had two status systems that nothing kept in step. PostHog
-- Support is now the one record of triage: the BFF opens a ticket for every
-- report, and the platform page reads and moves the ticket. What stays here is
-- the intake log: what was sent, by whom, from where. It is the fallback the
-- page lists while PostHog cannot be read, and the row the inbox
-- announcement points at.
--
-- ## posthog_ticket_id
--
-- The ticket this report opened. NULL: none opened (PostHog not configured in
-- this deployment, the policy could not mask the text, or PostHog failed); the
-- platform page lists those reports as not in PostHog yet. The CHECK bounds it
-- to an id-shaped string because it ends up in a link.
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "posthog_ticket_id" text;
--> statement-breakpoint
ALTER TABLE "product_feedback"
  ADD CONSTRAINT "product_feedback_posthog_ticket_id_shape"
  CHECK ("posthog_ticket_id" IS NULL OR "posthog_ticket_id" ~ '^[A-Za-z0-9-]{1,64}$');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_feedback_posthog_ticket_idx"
  ON "product_feedback" USING btree ("posthog_ticket_id")
  WHERE "posthog_ticket_id" IS NOT NULL;
--> statement-breakpoint
-- The local list pages on (created_at, id), newest first, across tenants.
CREATE INDEX IF NOT EXISTS "product_feedback_created_idx"
  ON "product_feedback" USING btree ("created_at", "id");
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP CONSTRAINT IF EXISTS "product_feedback_triage_attributed";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP CONSTRAINT IF EXISTS "product_feedback_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "product_feedback_status_created_idx";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "triaged_at";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "triaged_by";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
COMMENT ON TABLE "product_feedback" IS
  'Product feedback (bug, idea, praise, question) a member sent to the platform owners from inside the app. Tenant data; the intake log behind Platform -> Feedback. Triage lives on the PostHog Support ticket (posthog_ticket_id, ADR-0118). Never an input to platform lessons.';
