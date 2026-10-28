-- 0136: a review round is a row of its own (ADR-0104, slice 4 step 1).
--
-- `document_versions.state` holds two facts in one column: which bytes are
-- live (published, superseded) and whether a person stood behind them (draft,
-- in review, changes requested, approved, rejected). A person's upload is born
-- `published` with its uploader as approver, an approval nobody gave, because
-- `document_versions_published_is_approved` demands one. ADR-0104 separates the
-- two: the version's history, and review rounds on a version.
--
-- This step only ADDS the rounds. Every transition that opens or decides a
-- round writes this table in the transaction that moves the version's state
-- (`compareAndSwapVersionState`), and every reader stays on `state`. A later
-- step moves the readers here and drops the approval columns from versions.
--
--   requested          a person or Piloti sent the version for review
--   approved           a reviewer approved it
--   changes_requested  a reviewer sent it back, with a comment
--   rejected           a reviewer closed it, with a comment
--
-- At most one open round per version (partial unique index). A refusal carries
-- its comment, as `document_versions_refusal_has_comment` demands today.
--
-- Backfill: one round per version that was ever SUBMITTED, read off the
-- version's own stamps. Only the latest round of a version is on record there,
-- so earlier rounds of a version sent back and resubmitted are not recovered,
-- and a draft whose last round requested changes lost that comment when it was
-- revised (`stampFor('draft')` clears it), so it gets no row. A person's upload
-- (published, never submitted) gets none either: its "approval" is the
-- synthetic one this table exists to stop recording.
CREATE TABLE IF NOT EXISTS "document_version_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "version_id" uuid NOT NULL,
  "requested_by" text NOT NULL,
  "requested_by_actor" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL,
  "reviewer_user_ids" text[] NOT NULL DEFAULT '{}',
  "outcome" text NOT NULL DEFAULT 'requested',
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "comment" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "document_version_reviews_version_fkey"
    FOREIGN KEY ("version_id", "document_id") REFERENCES "document_versions" ("id", "document_id") ON DELETE CASCADE,
  CONSTRAINT "document_version_reviews_actor_known" CHECK ("requested_by_actor" IN ('human', 'agent')),
  CONSTRAINT "document_version_reviews_outcome_known"
    CHECK ("outcome" IN ('requested', 'approved', 'changes_requested', 'rejected')),
  CONSTRAINT "document_version_reviews_decision_complete"
    CHECK (("outcome" = 'requested') = ("decided_by" IS NULL AND "decided_at" IS NULL)),
  CONSTRAINT "document_version_reviews_refusal_has_comment"
    CHECK ("outcome" NOT IN ('changes_requested', 'rejected') OR "comment" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_version_reviews_open_per_version"
  ON "document_version_reviews" ("version_id") WHERE "outcome" = 'requested';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_version_reviews_document"
  ON "document_version_reviews" ("organization_id", "document_id");
--> statement-breakpoint
INSERT INTO "document_version_reviews"
  ("organization_id", "document_id", "version_id", "requested_by", "requested_by_actor", "requested_at",
   "outcome", "decided_by", "decided_at", "comment")
SELECT
  v."organization_id", v."document_id", v."id", v."submitted_by", v."submitted_by_actor", v."submitted_at",
  CASE
    WHEN v."state" = 'in_review' THEN 'requested'
    WHEN v."state" IN ('changes_requested', 'rejected') THEN v."state"
    ELSE 'approved'
  END,
  CASE WHEN v."state" = 'in_review' THEN NULL ELSE COALESCE(v."approved_by", v."reviewed_by") END,
  CASE WHEN v."state" = 'in_review' THEN NULL ELSE COALESCE(v."approved_at", v."reviewed_at") END,
  v."review_comment"
FROM "document_versions" v
WHERE v."submitted_by" IS NOT NULL
  AND v."submitted_at" IS NOT NULL
  AND (
    v."state" = 'in_review'
    OR (v."state" IN ('changes_requested', 'rejected') AND v."reviewed_by" IS NOT NULL AND v."review_comment" IS NOT NULL)
    OR (v."state" IN ('approved', 'published', 'superseded') AND v."approved_by" IS NOT NULL AND v."approved_at" IS NOT NULL)
  )
  AND NOT EXISTS (SELECT 1 FROM "document_version_reviews" r WHERE r."version_id" = v."id");
--> statement-breakpoint
SELECT grid_secure_table('document_version_reviews', 'organization_id = grid_current_org()');
