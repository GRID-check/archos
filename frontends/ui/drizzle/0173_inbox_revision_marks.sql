-- 0173: the inbox payload's `marksFassung` becomes `marksRevision`.
--
-- A "new revision" item (`document.new_revision`, written by the lifecycle's
-- announce effect) carries how many open marks sit on which numbered revision.
-- Only the payload key changes; the count is untouched. A payload that already
-- holds `marksRevision` (a new pod wrote it while this ran) keeps its own value
-- and just loses the old key. `updated_at` stays: the Eingang lists by it and a
-- renamed key is not news.
--
-- The reader accepts both spellings for one release (`lib/inbox/service.ts`).
-- Idempotent: a row without the old key is not selected.
UPDATE "inbox_items"
  SET "payload" = ("payload" - 'marksFassung')
    || CASE
         WHEN "payload" ? 'marksRevision' THEN '{}'::jsonb
         ELSE jsonb_build_object('marksRevision', "payload" -> 'marksFassung')
       END
  WHERE "payload" ? 'marksFassung';
