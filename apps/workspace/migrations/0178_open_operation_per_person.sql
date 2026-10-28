-- 0177: one open operation call is one proposal PER PERSON in a conversation
-- (ADR-0105, ADR-0122).
--
-- 0175 made the same operation with the same input, in one conversation, one
-- open proposal. In a conversation two people ask in, that folded B's call into
-- A's card: B's turn got back a proposal filed on A's behalf (`on_behalf_of` is
-- A), so the inbox, the audit trail and the decision's score named the wrong
-- person, and B's Piloti reported a card B never got. The person the call is
-- made for is part of what names it: the index gains `on_behalf_of`, and the
-- service's look-up (`findOpenOperationProposal`) matches it too.
--
-- Widening a unique index cannot conflict with the rows it already holds, so
-- nothing is folded. Idempotent: the index is dropped before it is created.
DROP INDEX IF EXISTS "uniq_proposed_changes_open_operation";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_proposed_changes_open_operation"
  ON "proposed_changes" (
    "organization_id",
    "origin_conversation_id",
    "on_behalf_of",
    (("payload"->>'operation')),
    (md5(("payload"->'input')::text))
  )
  WHERE "kind" = 'operation' AND "status" = 'proposed' AND "origin_conversation_id" IS NOT NULL;
