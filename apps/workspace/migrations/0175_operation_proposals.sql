-- A fourth kind of proposed change (ADR-0105, ADR-0122): `operation`, any WRITE
-- operation of the agent catalog (`lib/agent-api`) that Piloti calls through
-- the MCP surface. Piloti never applies it; a person accepts it, and it then
-- runs as that person through the operation's own route, so the route's
-- authorization decides. The payload is `{ operation, input, summary }`.
--
-- Only the kind CHECK moves. The lifecycle CHECKs, the unique card index and
-- the RLS policy are kind-agnostic. Idempotent: the constraint is dropped
-- before it is added.
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_kind_known;
--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_kind_known
  CHECK ("kind" IN ('file_operation', 'memory', 'project_profile', 'operation'));
