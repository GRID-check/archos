-- Reverse 0164: the plan goes back to the German keys and values.
--
-- ORDER: roll the application back to the previous image BEFORE running this; the previous
-- build's readers know only the German spellings.
--
-- The same text rewrite, inverted, inside a plan_json fence or an `approve {…}` reply, on a
-- task's `plan.documents`, and on a proposal's `operations[].source`, with the Büroablage
-- CHECK back on `"buero"`. Idempotent.

-- The JSON text of a plan: the keys and the genre / depth values renamed AS TEXT, so the bytes
-- the writer produced (key order, spacing, escapes) are kept. A key only matches as a key:
-- `"key"` followed by a colon, and not preceded by a backslash (an escaped quote inside a
-- string is not one).
CREATE OR REPLACE FUNCTION grid_0163_json_text(t text, maps jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT key AS k, value #>> '{}' AS v FROM jsonb_each(maps -> 'keys') LOOP
    t := regexp_replace(t, '(?<!\\)"' || r.k || '"([[:space:]]*:)', '"' || r.v || '"\1', 'g');
  END LOOP;
  FOR r IN SELECT key AS k, value #>> '{}' AS v FROM jsonb_each(maps -> 'genre') LOOP
    t := regexp_replace(t, '(?<!\\)("genre"[[:space:]]*:[[:space:]]*)"' || r.k || '"', '\1"' || r.v || '"', 'g');
  END LOOP;
  FOR r IN SELECT key AS k, value #>> '{}' AS v FROM jsonb_each(maps -> 'depth') LOOP
    t := regexp_replace(t, '(?<!\\)("depth"[[:space:]]*:[[:space:]]*)"' || r.k || '"', '\1"' || r.v || '"', 'g');
  END LOOP;
  RETURN t;
END
$$;

--> statement-breakpoint
-- A message's text: the plan_json fence of a plan preview (only the fence), or the whole of an
-- `approve {…}` reply (the edits the plan card sent back, which are JSON).
CREATE OR REPLACE FUNCTION grid_0163_content(c text, maps jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
BEGIN
  m := regexp_match(c, '^(.*?```plan_json[ \t]*\r?\n)(.*?)(\r?\n```.*)$');
  IF m IS NOT NULL THEN
    RETURN m[1] || grid_0163_json_text(m[2], maps) || m[3];
  END IF;
  IF c ~ '^[[:space:]]*approve[[:space:]]+[{]' THEN
    RETURN grid_0163_json_text(c, maps);
  END IF;
  RETURN c;
END
$$;

--> statement-breakpoint
-- The Unterlagen frozen on a task: `plan.documents.{grundlage,ausgeschlossen}`.
CREATE OR REPLACE FUNCTION grid_0163_plan(p jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  docs jsonb;
  r record;
BEGIN
  IF jsonb_typeof(p -> 'documents') IS DISTINCT FROM 'object' THEN RETURN p; END IF;
  docs := p -> 'documents';
  FOR r IN SELECT key AS k, value #>> '{}' AS v FROM jsonb_each(maps -> 'docKeys') LOOP
    IF docs ? r.k THEN
      docs := (docs - r.k) || jsonb_build_object(r.v, CASE WHEN docs ? r.v THEN docs -> r.v ELSE docs -> r.k END);
    END IF;
  END LOOP;
  RETURN jsonb_set(p, '{documents}', docs);
END
$$;

--> statement-breakpoint
-- The shelf a proposed file operation names: `payload.operations[].source`.
CREATE OR REPLACE FUNCTION grid_0163_operations(p jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(p -> 'operations') IS DISTINCT FROM 'array' THEN RETURN p; END IF;
  RETURN jsonb_set(p, '{operations}', coalesce((
    SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(o) = 'object' AND jsonb_typeof(o -> 'source') = 'string'
                       AND (maps -> 'source') ? (o ->> 'source')
                  THEN jsonb_set(o, '{source}', maps -> 'source' -> (o ->> 'source'))
                  ELSE o END ORDER BY ord)
      FROM jsonb_array_elements(p -> 'operations') WITH ORDINALITY AS t(o, ord)), '[]'::jsonb));
END
$$;

--> statement-breakpoint
UPDATE "messages"
   SET content = grid_0163_content(content, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)
 WHERE content ~ '"(basis|documents|excluded)"[[:space:]]*:|"genre"[[:space:]]*:[[:space:]]*"(checklist|comparison|file_note|inspection_report|report)"|"depth"[[:space:]]*:[[:space:]]*"(expert_report|quick_check)"'
   AND (content ~ '```plan_json' OR content ~ '^[[:space:]]*approve[[:space:]]+[{]')
   AND content IS DISTINCT FROM grid_0163_content(content, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
-- The answered plan card keeps its reply on the message that asked (`metadata.promptState`).
UPDATE "messages"
   SET metadata = jsonb_set(metadata, '{promptState,response}',
                            to_jsonb(grid_0163_content(metadata #>> '{promptState,response}', '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)))
 WHERE jsonb_typeof(metadata #> '{promptState,response}') = 'string'
   AND (metadata #>> '{promptState,response}') ~ '"(basis|documents|excluded)"[[:space:]]*:|"genre"[[:space:]]*:[[:space:]]*"(checklist|comparison|file_note|inspection_report|report)"|"depth"[[:space:]]*:[[:space:]]*"(expert_report|quick_check)"'
   AND (metadata #>> '{promptState,response}') ~ '^[[:space:]]*approve[[:space:]]+[{]'
   AND (metadata #>> '{promptState,response}') IS DISTINCT FROM grid_0163_content(metadata #>> '{promptState,response}', '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
UPDATE "tasks" SET plan = grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)
 WHERE plan -> 'documents' ?| ARRAY['basis', 'excluded']
   AND plan IS DISTINCT FROM grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
UPDATE "task_definitions" SET plan = grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)
 WHERE plan -> 'documents' ?| ARRAY['basis', 'excluded']
   AND plan IS DISTINCT FROM grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
UPDATE "task_runs" SET plan = grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)
 WHERE plan -> 'documents' ?| ARRAY['basis', 'excluded']
   AND plan IS DISTINCT FROM grid_0163_plan(plan, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
-- The Büroablage CHECK reads `source` out of the payload, so it goes while the payloads are
-- rewritten and comes back for the other spelling: NOT VALID first, then VALIDATE as its own
-- statement, so the validation scan takes the weaker lock. The name is kept (migration 0164
-- renames it).
ALTER TABLE "proposed_changes" DROP CONSTRAINT IF EXISTS proposed_changes_archiv_move;

--> statement-breakpoint
UPDATE "proposed_changes" SET payload = grid_0163_operations(payload, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb)
 WHERE kind = 'file_operation'
   AND jsonb_typeof(payload -> 'operations') = 'array'
   AND payload IS DISTINCT FROM grid_0163_operations(payload, '{"depth": {"expert_report": "gutachten", "quick_check": "kurzpruefung"}, "docKeys": {"basis": "grundlage", "excluded": "ausgeschlossen"}, "genre": {"checklist": "checkliste", "comparison": "vergleich", "file_note": "aktenvermerk", "inspection_report": "pruefbericht", "report": "bericht"}, "keys": {"basis": "grundlage", "documents": "unterlagen", "excluded": "ausgeschlossen"}, "source": {"office": "buero", "project": "projekt"}}'::jsonb);

--> statement-breakpoint
ALTER TABLE "proposed_changes" ADD CONSTRAINT proposed_changes_archiv_move
  CHECK (
    "scope" = 'project'
    -- COALESCE: a missing key reads NULL, and a CHECK that is NULL passes.
    OR COALESCE(
      "kind" = 'file_operation'
      AND "payload"->>'operation' = 'move'
      AND jsonb_typeof("payload"->'operations') = 'array'
      AND jsonb_path_exists("payload", '$.operations[0]')
      AND NOT jsonb_path_exists("payload", '$.operations[*] ? (!(@.source == "buero"))'),
      false
    )
  ) NOT VALID;

--> statement-breakpoint
ALTER TABLE "proposed_changes" VALIDATE CONSTRAINT proposed_changes_archiv_move;

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0163_operations(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0163_plan(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0163_content(text, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0163_json_text(text, jsonb);
