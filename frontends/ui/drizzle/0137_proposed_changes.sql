-- 0137: proposed_changes — a change to the workspace Piloti proposes and a
-- person applies, kept as a server object (ADR-0105;
-- docs/architecture/proposed-changes.md).
--
-- ## What was missing
--
-- Piloti's file operations (move, rename, create a folder, assign) arrived as
-- a card, and the card executed them FROM THE BROWSER once someone accepted
-- it: the decision lived in the chat message (`cardInteractions`), the outcome
-- of each item lived nowhere, and a reload or a second tab could run the same
-- moves twice. The proposal is now a row. The server applies it in the
-- deciding person's session, through the same services the Files pane uses,
-- and records what each item did.
--
-- ## The row
--
-- `kind` says what `payload` is; `file_operation` is the only kind today, its
-- payload the contract's `fileOperationPayloadSchema`
-- (`lib/proposals/types.ts`): documents and folders by NAME and PATH, never by
-- id, because the agent's inventory has none and a name that no longer
-- resolves must fail visibly when the change is applied.
--
-- `proposed_by_kind` is `piloti` today; the column exists so a person's
-- proposal needs no migration. `on_behalf_of` is always a person: whose turn
-- proposed it (the signed envelope's user, ADR-0054 §4).
--
-- `origin_conversation_id` and `origin_message_id` say where the card sits.
-- The conversation is a foreign key, with the organization (the composite key
-- 0032 added), and the proposal goes with it: the card is
-- the proposal's only surface, and reading a proposal takes access to the
-- conversation it was made in. The message is not one, because the answer's
-- row is written at the end of the turn and the proposal during it.
--
-- ## The lifecycle
--
-- proposed → applied | partially_applied | failed | dismissed, each by
-- somebody at some time: `decided_by` and `decided_at` are set exactly when
-- the status has left `proposed`. `results` (one entry per item, in order) is
-- set exactly when the change was applied, whatever came of it, and is an
-- array.
--
-- Applying runs service calls that each take their own connection, so it
-- cannot hold a row lock across them (`transaction-shape.spec.ts`). The claim
-- is a committed write instead: `applying_by` / `applying_since`, set by a
-- compare-and-swap on `proposed` with no live claim, both or neither, and only
-- while the status is `proposed`. The settling update clears them. A second
-- click finds the claim and is refused; a claim left by a crash goes stale
-- after a few minutes (the service's window) and the proposal can be decided
-- again.
--
-- ## RLS
--
-- A tenant table: the organization, AND the project's organization, so a row
-- cannot be planted on another tenant's project. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "proposed_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "proposed_by_kind" text NOT NULL,
  "on_behalf_of" text NOT NULL,
  "origin_conversation_id" text,
  "origin_message_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "results" jsonb,
  "applying_by" text,
  "applying_since" timestamp with time zone,
  CONSTRAINT "proposed_changes_project_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "proposed_changes_conversation_fkey"
    FOREIGN KEY ("origin_conversation_id", "organization_id")
    REFERENCES "conversations"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT proposed_changes_kind_known
    CHECK ("kind" IN ('file_operation')),
  CONSTRAINT proposed_changes_status_known
    CHECK ("status" IN ('proposed', 'applied', 'partially_applied', 'failed', 'dismissed')),
  CONSTRAINT proposed_changes_proposer_known
    CHECK ("proposed_by_kind" IN ('piloti', 'person')),
  CONSTRAINT proposed_changes_payload_object
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT proposed_changes_decision_complete
    CHECK (
      ("status" <> 'proposed') = ("decided_by" IS NOT NULL)
      AND ("decided_by" IS NULL) = ("decided_at" IS NULL)
    ),
  CONSTRAINT proposed_changes_results_when_applied
    CHECK (("status" IN ('applied', 'partially_applied', 'failed')) = ("results" IS NOT NULL)),
  CONSTRAINT proposed_changes_results_array
    CHECK ("results" IS NULL OR jsonb_typeof("results") = 'array'),
  CONSTRAINT proposed_changes_claim_complete
    CHECK (("applying_by" IS NULL) = ("applying_since" IS NULL)),
  CONSTRAINT proposed_changes_claim_while_proposed
    CHECK ("applying_by" IS NULL OR "status" = 'proposed')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposed_changes_organization_id"
  ON "proposed_changes" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposed_changes_project_created"
  ON "proposed_changes" ("project_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proposed_changes_conversation"
  ON "proposed_changes" ("origin_conversation_id");
--> statement-breakpoint
SELECT grid_secure_table('proposed_changes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
