-- 0168: English topic tags on conversations.
--
--   brandschutz -> fire_safety        schallschutz -> sound_insulation
--   barrierefreiheit -> accessibility energie -> energy
--   statik -> structural              nutzungssicherheit -> safety_in_use
--   allgemein -> general              (hygiene stays)
--
-- `conversations.tags` is a text[] with a GIN index (0021), and the `&&` below
-- is what that index serves, so the statement visits only the conversations
-- that carry an old key. Each array is rewritten element by element, keeping
-- the order of first appearance and dropping a duplicate (an old key and its
-- new spelling can only meet when an older pod tagged a conversation after
-- this ran). `updated_at` is not touched: the Historie lists by it and a
-- renamed tag is not activity.
--
-- Idempotent: a conversation without an old key is not selected.
UPDATE "conversations"
  SET "tags" = ARRAY(
    SELECT "mapped"
    FROM (
      SELECT
        CASE "tag"
          WHEN 'brandschutz' THEN 'fire_safety'
          WHEN 'schallschutz' THEN 'sound_insulation'
          WHEN 'barrierefreiheit' THEN 'accessibility'
          WHEN 'energie' THEN 'energy'
          WHEN 'statik' THEN 'structural'
          WHEN 'nutzungssicherheit' THEN 'safety_in_use'
          WHEN 'allgemein' THEN 'general'
          ELSE "tag"
        END AS "mapped",
        min("ord") AS "first"
      FROM unnest("conversations"."tags") WITH ORDINALITY AS "u"("tag", "ord")
      GROUP BY 1
    ) "keyed"
    ORDER BY "first"
  )
  WHERE "tags" && ARRAY['brandschutz', 'schallschutz', 'barrierefreiheit', 'energie', 'statik', 'nutzungssicherheit', 'allgemein']::text[];
