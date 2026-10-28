-- 0139: what wakes Piloti on an Anmerkung, and the record of each wake
-- (ADR-0106, „Events on Piloti's work wake a turn").
--
-- ## What was missing
--
-- Only a person's browser could start a turn. A colleague who answered Piloti
-- in an Anmerkung's thread, or wrote „@Piloti“ there with nobody's chat open,
-- reached the database and the live room and never Piloti. The BFF now
-- enqueues a wake in the same transaction as the event, and the bff-jobs
-- worker runs it as the person whose act the event is.
--
-- ## The reply says whether it addresses Piloti
--
-- `document_annotation_replies.addresses_agent`: the composer's structured
-- mention, a chip the person set, never a match on the text (ADR-0036: a rule
-- people can read, not a guess that a message was meant for the agent).
-- Default false, so every reply written before this is a reply to people.
--
-- ## Piloti as the delegate on a mark
--
-- Work is assigned to people and delegated to agents (ADR-0105, the pattern
-- Linear ships). The mark keeps its human assignee; `delegated_by` is the
-- person on whose behalf Piloti works it, `delegated_at` when they asked.
-- Both or neither, and only on an open mark: a closed mark has nobody working
-- it, and a proposal is Piloti's own finding, not work handed to it. Piloti
-- hands the mark back by replying, which clears both.
--
-- ## The record of each wake
--
-- `piloti_wakes`: one row per event that met a wake rule. Its id is the
-- bff_job_queue job id AND the turn id (uuid5 of the event), so a wake runs
-- at most once whatever retries. The queue deletes a job once it is done
-- (ADR-0079), so the outcome is kept here: started, or suppressed (a cap, the
-- switch, rights lost), refused (the person's budget), failed. A suppressed
-- wake has no model call and therefore no trace; this row is its trace. The
-- caps per mark and per person count these rows, at enqueue and again when
-- the job is claimed.
--
-- `reason` is set exactly when the wake did not start a turn. `settled_at` is
-- set exactly when the row left `queued`.
--
-- ## RLS
--
-- A tenant table: the organization, AND the mark's organization. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

ALTER TABLE "document_annotation_replies"
  ADD COLUMN IF NOT EXISTS "addresses_agent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations"
  ADD COLUMN IF NOT EXISTS "delegated_by" text,
  ADD COLUMN IF NOT EXISTS "delegated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_delegation_complete;
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT document_annotations_delegation_complete
  CHECK (("delegated_by" IS NULL) = ("delegated_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_delegated_while_open;
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT document_annotations_delegated_while_open
  CHECK ("delegated_by" IS NULL OR "status" = 'open');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "piloti_wakes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "annotation_id" uuid NOT NULL,
  "trigger_kind" text NOT NULL,
  "event_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "piloti_wakes_annotation_fkey"
    FOREIGN KEY ("annotation_id") REFERENCES "document_annotations"("id") ON DELETE CASCADE,
  CONSTRAINT piloti_wakes_trigger_known
    CHECK ("trigger_kind" IN ('thread_mention', 'thread_reply', 'assigned')),
  CONSTRAINT piloti_wakes_status_known
    CHECK ("status" IN ('queued', 'started', 'suppressed', 'refused', 'failed')),
  CONSTRAINT piloti_wakes_reason_when_not_started
    CHECK (("status" IN ('suppressed', 'refused', 'failed')) = ("reason" IS NOT NULL)),
  CONSTRAINT piloti_wakes_reason_length
    CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT piloti_wakes_settled_when_not_queued
    CHECK (("status" = 'queued') = ("settled_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_wakes_annotation_created"
  ON "piloti_wakes" ("annotation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_wakes_actor_created"
  ON "piloti_wakes" ("organization_id", "actor_user_id", "created_at");
--> statement-breakpoint
SELECT grid_secure_table('piloti_wakes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM document_annotations a WHERE a.id = annotation_id AND a.organization_id = grid_current_org())');
