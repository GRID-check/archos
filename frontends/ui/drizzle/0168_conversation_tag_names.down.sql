-- Reverse 0168: the German topic keys come back, in the same order.
--
-- One to one, so nothing is lost. ORDER: roll the frontend back first; the
-- newer build tags with the English keys.
UPDATE "conversations"
  SET "tags" = ARRAY(
    SELECT "mapped"
    FROM (
      SELECT
        CASE "tag"
          WHEN 'fire_safety' THEN 'brandschutz'
          WHEN 'sound_insulation' THEN 'schallschutz'
          WHEN 'accessibility' THEN 'barrierefreiheit'
          WHEN 'energy' THEN 'energie'
          WHEN 'structural' THEN 'statik'
          WHEN 'safety_in_use' THEN 'nutzungssicherheit'
          WHEN 'general' THEN 'allgemein'
          ELSE "tag"
        END AS "mapped",
        min("ord") AS "first"
      FROM unnest("conversations"."tags") WITH ORDINALITY AS "u"("tag", "ord")
      GROUP BY 1
    ) "keyed"
    ORDER BY "first"
  )
  WHERE "tags" && ARRAY['fire_safety', 'sound_insulation', 'accessibility', 'energy', 'structural', 'safety_in_use', 'general']::text[];
