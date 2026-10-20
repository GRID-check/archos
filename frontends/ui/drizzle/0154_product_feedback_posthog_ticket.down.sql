-- Reverse 0154: our own triage columns come back, every report at `new`.
--
-- Lossy by necessity: the triage state lived in PostHog meanwhile and is not
-- copied back. The tickets stay in PostHog, and each one's first message names
-- its report id.
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "triaged_by" text;
--> statement-breakpoint
ALTER TABLE "product_feedback" ADD COLUMN IF NOT EXISTS "triaged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_feedback"
  ADD CONSTRAINT "product_feedback_status"
  CHECK ("status" IN ('new', 'in_progress', 'resolved', 'dismissed'));
--> statement-breakpoint
ALTER TABLE "product_feedback"
  ADD CONSTRAINT "product_feedback_triage_attributed"
  CHECK ("status" = 'new' OR ("triaged_by" IS NOT NULL AND "triaged_at" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_feedback_status_created_idx"
  ON "product_feedback" USING btree ("status", "created_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "product_feedback_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "product_feedback_posthog_ticket_idx";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP CONSTRAINT IF EXISTS "product_feedback_posthog_ticket_id_shape";
--> statement-breakpoint
ALTER TABLE "product_feedback" DROP COLUMN IF EXISTS "posthog_ticket_id";
