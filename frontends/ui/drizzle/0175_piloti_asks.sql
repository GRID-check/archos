-- 0175: a question another agent asks Piloti on a person's behalf (ADR-0122).
--
-- ## What was missing
--
-- An external agent connected through the agent door (ADR-0121) could do
-- everything the person can do in the workspace, and could not do the one
-- thing a colleague does most: ask Piloti. A turn ran only from a browser or
-- from a wake (ADR-0106). `POST /api/piloti-asks` (the MCP operation
-- `piloti-ask-create`, and the A2A door's `SendMessage`) now starts a headless
-- turn as the person, waits about forty seconds for the answer, and otherwise
-- hands back an id to poll.
--
-- ## The row is the task
--
-- One row per ask. Its id is the turn id (the question's message id) and the
-- A2A `Task.id`, so the turn's outcome (`/api/internal/turns/outcome`) finds
-- it by primary key. `conversation_id` is the person's own private thread the
-- turn ran in (the A2A `contextId`); the answer is a message there, derived by
-- id, never copied here. `state` uses the A2A task-state words.
--
-- `reason` is set exactly when the ask failed or was rejected (the budget, a
-- busy thread, a server that refused the question). `ended_at` is set exactly
-- when the state is terminal.
--
-- ## RLS
--
-- A tenant table keyed by its organization. The composite foreign key ties the
-- row to its conversation's organization, so a row cannot name another
-- tenant's thread. Listed in `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "piloti_asks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "state" text DEFAULT 'submitted' NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  CONSTRAINT "piloti_asks_conversation_fkey"
    FOREIGN KEY ("conversation_id", "organization_id")
    REFERENCES "conversations"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT piloti_asks_state_known
    CHECK ("state" IN ('submitted', 'working', 'completed', 'canceled', 'failed', 'rejected')),
  CONSTRAINT piloti_asks_reason_when_refused
    CHECK (("state" IN ('failed', 'rejected')) = ("reason" IS NOT NULL)),
  CONSTRAINT piloti_asks_reason_length
    CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT piloti_asks_ended_when_terminal
    CHECK (("state" IN ('submitted', 'working')) = ("ended_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_asks_requester_created"
  ON "piloti_asks" ("organization_id", "requested_by", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_asks_conversation"
  ON "piloti_asks" ("conversation_id");
--> statement-breakpoint
SELECT grid_secure_table('piloti_asks', 'organization_id = grid_current_org()');
