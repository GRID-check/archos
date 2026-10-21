-- Reverse 0177. ORDER: roll the frontend back first; the older build looks an
-- open call up without the person.
--
-- Lossy: of several open proposals for one call in one conversation, made for
-- different people, the oldest stays and the later ones are deleted, as 0175
-- folded them, so the narrower index can be built.
DELETE FROM "proposed_changes" AS later
  USING "proposed_changes" AS earlier
  WHERE later."kind" = 'operation' AND later."status" = 'proposed'
    AND earlier."kind" = 'operation' AND earlier."status" = 'proposed'
    AND later."organization_id" = earlier."organization_id"
    AND later."origin_conversation_id" = earlier."origin_conversation_id"
    AND later."payload"->>'operation' = earlier."payload"->>'operation'
    AND later."payload"->'input' = earlier."payload"->'input'
    AND (later."created_at", later."id") > (earlier."created_at", earlier."id");
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_proposed_changes_open_operation";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_proposed_changes_open_operation"
  ON "proposed_changes" (
    "organization_id",
    "origin_conversation_id",
    (("payload"->>'operation')),
    (md5(("payload"->'input')::text))
  )
  WHERE "kind" = 'operation' AND "status" = 'proposed' AND "origin_conversation_id" IS NOT NULL;
