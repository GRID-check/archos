-- 0150: whom an Anmerkung or a reply in its thread mentions.
--
-- ## What was missing
--
-- A person could bring Piloti into a mark's thread with „@Piloti“, and nobody
-- else. To ask a colleague about a mark they had to leave the Prüfansicht and
-- write to them somewhere else, and the colleague was never told where to look.
-- The composer now offers the chat's own „@“ picker on a mark and in its thread,
-- and whoever is picked is told in the Postfach, at the mark.
--
-- ## The columns
--
-- `mentions` on `document_annotations` (whom the mark's text mentions) and on
-- `document_annotation_replies` (whom the reply mentions): the chat's mention
-- shape, `[{"targetId": "<user id or agent:piloti>", "display": "<name>"}]`.
-- What the server KEPT, never what the browser sent: a mention stands only
-- while its „@Name“ still stands in the text, the name is the one the
-- organization's directory has, and the person may open the document
-- (`lib/annotations/mentions.ts`). Stored, rather than read out of the text
-- again, because a text that merely looks like „@Anna“ mentions nobody: the
-- renderer draws a chip only where a stored mention says so, the same rule
-- that decided who was told.
--
-- Default `[]`, so every mark and reply written before this mentions nobody.
-- An array of at most ten, the bound one chat message has
-- (`MAX_MENTIONS_PER_MESSAGE`). `CASE`, because Postgres does not promise to
-- read an `AND` left to right and the length of a scalar is an error.
--
-- ## RLS
--
-- No new table: both are under `grid_secure_table` since 0138, and a column
-- inherits its table's policy.

ALTER TABLE "document_annotations"
  ADD COLUMN IF NOT EXISTS "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies"
  ADD COLUMN IF NOT EXISTS "mentions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_annotations" DROP CONSTRAINT IF EXISTS document_annotations_mentions_bounded;
--> statement-breakpoint
ALTER TABLE "document_annotations" ADD CONSTRAINT document_annotations_mentions_bounded
  CHECK (CASE WHEN jsonb_typeof("mentions") = 'array' THEN jsonb_array_length("mentions") <= 10 ELSE false END);
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" DROP CONSTRAINT IF EXISTS document_annotation_replies_mentions_bounded;
--> statement-breakpoint
ALTER TABLE "document_annotation_replies" ADD CONSTRAINT document_annotation_replies_mentions_bounded
  CHECK (CASE WHEN jsonb_typeof("mentions") = 'array' THEN jsonb_array_length("mentions") <= 10 ELSE false END);
