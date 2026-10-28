-- Reverse 0187. ORDER: roll the frontend back first; the older build reads `archiv` and
-- `office_shelf` both, the newer one only `office_shelf`.
--
-- Lossy in the way 0170's reverse is: every stored `"shelf": "office_shelf"` becomes `archiv`,
-- including the ones a build after 0170 wrote that way to begin with. The older build reads
-- both spellings as the office shelf, so nothing it shows changes.

CREATE OR REPLACE FUNCTION tmp_0187_shelf_down(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(t, '("shelf"[[:space:]]*:[[:space:]]*)"office_shelf"', '\1"archiv"', 'g'),
           '(\\"shelf\\"[[:space:]]*:[[:space:]]*)\\"office_shelf\\"', '\1\\"archiv\\"', 'g')
$$;

--> statement-breakpoint
UPDATE "messages" SET metadata = tmp_0187_shelf_down(metadata::text)::jsonb
 WHERE metadata::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"office_shelf';

--> statement-breakpoint
UPDATE "messages" SET content = tmp_0187_shelf_down(content)
 WHERE content ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"office_shelf';

--> statement-breakpoint
UPDATE "tasks" SET plan = tmp_0187_shelf_down(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"office_shelf';

--> statement-breakpoint
UPDATE "task_definitions" SET plan = tmp_0187_shelf_down(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"office_shelf';

--> statement-breakpoint
UPDATE "task_runs" SET plan = tmp_0187_shelf_down(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"office_shelf';

--> statement-breakpoint
DROP FUNCTION tmp_0187_shelf_down(text);
