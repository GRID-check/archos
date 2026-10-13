-- `piloti_changes`: every change Piloti APPLIED to an Anmerkung or a thread,
-- recorded with the turn that made it (ADR-0109).
--
-- What a proposal is to an unasked change (`proposed_changes`, 0137), this is
-- to an asked one: a server row the turn's card reads back, a colleague's
-- window shows, Langfuse can score, and undo works from. Before this, what a
-- turn changed lived only in its card, and undo was the browser replaying the
-- card's own copy.
--
-- * `before` / `after` are the mark's (or reply's) changeable fields as they
--   were and as Piloti left them. A `create` has no before, a `delete` no
--   after. Undo compares the object with `after` first, so a colleague's later
--   change is never undone (a compare-and-swap, not a replay).
-- * `annotation_id` has no foreign key on purpose: a `delete` must outlive the
--   mark it deleted, or it could never be undone. The record goes with its
--   DOCUMENT and with the conversation of the turn that made it.
-- * `on_behalf_of` is the person the turn acted for; undo is that person's
--   (or anyone who may edit the mark, as the service decides).
CREATE TABLE IF NOT EXISTS "piloti_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "annotation_id" uuid NOT NULL,
  "object_kind" text NOT NULL,
  "object_id" uuid NOT NULL,
  "op" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "origin_conversation_id" text NOT NULL,
  "origin_message_id" uuid NOT NULL,
  "on_behalf_of" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "undone_at" timestamp with time zone,
  "undone_by" text,
  CONSTRAINT "piloti_changes_document_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
  CONSTRAINT "piloti_changes_conversation_fkey"
    FOREIGN KEY ("origin_conversation_id", "organization_id")
    REFERENCES "conversations" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT piloti_changes_object_known
    CHECK ("object_kind" IN ('annotation', 'annotation_reply')),
  CONSTRAINT piloti_changes_op_known
    CHECK ("op" IN ('create', 'update', 'delete')),
  -- A reply is created and never changed or deleted by Piloti.
  CONSTRAINT piloti_changes_reply_is_created
    CHECK ("object_kind" <> 'annotation_reply' OR "op" = 'create'),
  -- A mark's own change names the mark as its object.
  CONSTRAINT piloti_changes_annotation_is_object
    CHECK ("object_kind" <> 'annotation' OR "object_id" = "annotation_id"),
  CONSTRAINT piloti_changes_states_by_op
    CHECK (
      ("op" = 'create' AND "before" IS NULL AND "after" IS NOT NULL)
      OR ("op" = 'update' AND "before" IS NOT NULL AND "after" IS NOT NULL)
      OR ("op" = 'delete' AND "before" IS NOT NULL AND "after" IS NULL)
    ),
  CONSTRAINT piloti_changes_states_are_objects
    CHECK (("before" IS NULL OR jsonb_typeof("before") = 'object') AND ("after" IS NULL OR jsonb_typeof("after") = 'object')),
  CONSTRAINT piloti_changes_undo_complete
    CHECK (("undone_at" IS NULL) = ("undone_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_changes_origin"
  ON "piloti_changes" ("organization_id", "origin_message_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piloti_changes_annotation"
  ON "piloti_changes" ("annotation_id", "created_at");
--> statement-breakpoint
SELECT grid_secure_table('piloti_changes',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.organization_id = grid_current_org())');
