-- Reverse 0173: `marksRevision` is `marksFassung` again.
--
-- ORDER: roll the frontend back first; the newer build writes `marksRevision`.
-- A payload that already holds `marksFassung` (an older pod wrote it after 0173)
-- keeps its own value and loses the new key.
UPDATE "inbox_items"
  SET "payload" = ("payload" - 'marksRevision')
    || CASE
         WHEN "payload" ? 'marksFassung' THEN '{}'::jsonb
         ELSE jsonb_build_object('marksFassung', "payload" -> 'marksRevision')
       END
  WHERE "payload" ? 'marksRevision';
