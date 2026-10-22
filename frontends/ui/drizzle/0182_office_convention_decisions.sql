-- 0182: a person's decision on one line of the office's conventions (ADR-0129).
--
-- ## What was missing
--
-- `office_conventions` (0181) is counted, never authored: replaced whole on
-- every refresh. A person could not say "this line is right, keep it" or "this
-- one is wrong, never use it". A decision is authored, so it cannot live on
-- the derived row; it would be replaced with the next count.
--
-- ## The row
--
-- One per organization and line. `line_key` is the stable key of the line
-- (`lib/office-conventions/lines.ts`): the kind and the value, never the
-- counts. `line` is the line as it was when decided, so a confirmed line is
-- still handed to the agent after a recount no longer shows it, and a declined
-- one can be listed and taken back. Taking a decision back deletes the row.
--
-- ## RLS
--
-- A tenant table keyed by its organization. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "office_convention_decisions" (
  "organization_id" text NOT NULL,
  "line_key" text NOT NULL,
  "decision" text NOT NULL,
  "line" jsonb NOT NULL,
  "decided_by" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "office_convention_decisions_pkey" PRIMARY KEY ("organization_id", "line_key"),
  CONSTRAINT office_convention_decisions_decision_known CHECK ("decision" IN ('confirmed', 'declined')),
  CONSTRAINT office_convention_decisions_key_bounded CHECK (char_length("line_key") BETWEEN 1 AND 300),
  CONSTRAINT office_convention_decisions_line_object CHECK (jsonb_typeof("line") = 'object')
);
--> statement-breakpoint
SELECT grid_secure_table('office_convention_decisions', 'organization_id = grid_current_org()');
