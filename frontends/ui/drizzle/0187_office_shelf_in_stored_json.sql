-- 0187: the office shelf is `office_shelf` in the JSON a message or a task stores, too.
--
-- ## What is stored, and what changes
--
-- 0170 renamed the shelf value `archiv` -> `office_shelf` in the `scope` COLUMNS. The same value
-- also travels inside stored JSON, as a `"shelf"` member, and no migration rewrote it there:
--
--   messages.metadata        citations.sources[].shelf, and any other object a turn stored with
--                            its shelf (the Herleitung's hits, a run's documents)
--   messages.metadata        promptState.response: the reader's `approve {…}` reply, as text
--   messages.content         the ```plan_json fence and the `approve {…}` reply, as text
--   tasks.plan               plan.documents[].shelf
--   task_definitions.plan    plan.documents[].shelf
--   task_runs.plan           plan.documents[].shelf
--
-- The readers mapped `archiv` on the way in (`LEGACY_SHELF_VALUES` in
-- `frontends/ui/src/features/chat/lib/source-kinds.ts`). This migration rewrites what is stored,
-- and the same change deletes that reader. The browser's cached copies are dropped by
-- `CHAT_MESSAGES_SHAPE` 4 (`features/chat/stores/chat-storage.ts`) and read again from here.
--
-- ## Text, so nesting does not matter
--
-- The value is replaced where it follows a `"shelf"` key: in a jsonb column's text form, which
-- Postgres writes canonically as `"shelf": "archiv"`, and in JSON held as text (a plan fence, a
-- reply), where the quotes may be escaped (`\"shelf\": \"archiv\"`) and the spacing is the
-- writer's. Nothing else is touched: `"archiv"` that is not a shelf's value, a key named
-- `bookshelf`, prose.
--
-- ## Idempotent, and read-only for everything else
--
-- Only rows whose text holds the old pair are written, and a re-run finds none.
--
-- ## Order
--
-- Database first, then frontend: the build this ships with no longer reads `archiv`, the build
-- before it reads both. The Kubernetes deploy already runs the migration Job before the frontend
-- (`deploy/pulumi/index.ts`), and Compose's `grid-migrate` before the app.
--
-- ## Lock and size
--
-- One statement per column, row locks on the matching rows only, no table lock: the pattern of
-- 0163 and 0164 on the same tables. The filter is a regular expression over the text form, the
-- same cost 0163 paid over `messages`.
--
-- ## RLS
--
-- Untouched, and not in `BOUNDARY_MIGRATIONS`: no table is created, dropped or renamed. It runs
-- as the owner, so every tenant's rows are rewritten. The helper function exists only for the
-- length of this migration.

CREATE OR REPLACE FUNCTION grid_0187_shelf(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
           regexp_replace(t, '("shelf"[[:space:]]*:[[:space:]]*)"archiv"', '\1"office_shelf"', 'g'),
           '(\\"shelf\\"[[:space:]]*:[[:space:]]*)\\"archiv\\"', '\1\\"office_shelf\\"', 'g')
$$;

--> statement-breakpoint
UPDATE "messages" SET metadata = grid_0187_shelf(metadata::text)::jsonb
 WHERE metadata::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"archiv';

--> statement-breakpoint
UPDATE "messages" SET content = grid_0187_shelf(content)
 WHERE content ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"archiv';

--> statement-breakpoint
UPDATE "tasks" SET plan = grid_0187_shelf(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"archiv';

--> statement-breakpoint
UPDATE "task_definitions" SET plan = grid_0187_shelf(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"archiv';

--> statement-breakpoint
UPDATE "task_runs" SET plan = grid_0187_shelf(plan::text)::jsonb
 WHERE plan::text ~ '"shelf\\?"[[:space:]]*:[[:space:]]*\\?"archiv';

--> statement-breakpoint
DROP FUNCTION grid_0187_shelf(text);
