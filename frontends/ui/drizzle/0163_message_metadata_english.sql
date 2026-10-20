-- 0163: the names stored in a message's metadata become English.
--
-- ## What is stored, and what changes
--
-- `messages.metadata` holds, besides prose, a handful of closed vocabularies the
-- readers branch on and the dictionaries look up. They were German identifiers
-- (`erfuellt`, `baurecht`, `laeuft`, `aufstellflaeche`, …); the code now writes
-- and reads English ones, and this rewrites what is already stored:
--
--   findings.items[]                  status   erfuellt|nicht_erfuellt|offen|nicht_anwendbar
--                                              -> met|not_met|open|not_applicable
--                                     grounding belegt|abgeleitet|offen -> sourced|derived|open
--   answerMeta / answer_meta.callout  kind     hinweis|achtung|frist|tipp -> note|warning|deadline|tip
--   run_ledger                        status, phases[].phase, steps[].phase, error.completedBefore[]
--                                     (planen … abgelegt, angelegt … unterbrochen) and the key
--                                     `grundlage` -> `basis`
--   citations.sources[]               kind (baurecht|buero|projekt|messung), lane (baurecht_oib …),
--                                     binding_status (bindend …), rank (bundesgesetz …),
--                                     and the key `punkt` -> `clause`
--   provenance                        thinkingSteps[].traceLanes[] key and kind; turnEvent.key
--                                     `status.retrieval.punkt` -> `status.retrieval.clause` with its
--                                     value `punkt` -> `clause`; degradedReasons `grundlage_unread`
--                                     -> `basis_unread`; retrievalLedger[].key; quoteStamps[] `punkt`
--   cards[]                           fire_access_plan.aufstellflaeche/gebaeudeklasse ->
--                                     staging_area/building_class, guardrail_check.context
--                                     (balkon|stiege|fenster|dachterrasse), building_section markers
--                                     kind `fluchtniveau` -> `escape_level`, document_draft.path root
--                                     `/entwuerfe/` -> `/drafts/`, document_grid / file_operation_proposal
--                                     `source` projekt|buero -> project|office; the same inside a
--                                     `surface` card's components
--   citation_events.detail.lanes      the lane keys (the citation-health ledger counts sources per lane)
--
-- The word lists are the ones in `src/aiq_agent/common/findings.py`, `plan_vocabulary.py`,
-- `frontends/ui/src/features/chat/lib/source-kinds.ts` (LEGACY_LANE, LEGACY_SOURCE_KIND),
-- `lib/runs/run-ledger-types.ts` and `shared/cards/legacy.ts`: one table per vocabulary, and
-- the readers keep reading the German spellings for one release (rows in flight, a pod that has
-- not rolled yet, browser storage), so this migration is not on the critical path of a deploy.
--
-- ## Idempotent, and read-only for everything else
--
-- Every map is applied to a value only where its current value is one of the OLD names, so a
-- re-run changes nothing, and a row that already holds English names is not written (the
-- `IS DISTINCT FROM` below). Only rows whose metadata text contains an old name are even
-- computed (the regular expression below, quotes included, so prose that merely contains
-- the word does not match). `prompt`, `provenance` text and every other key stay as they were.
--
-- ## Lock and size
--
-- ONE statement over the table: a row is rewritten once however many families it holds.
-- This repo has no batching pattern for a data migration (a migration is one transaction,
-- and 0097, the nearest precedent, rewrites `messages` the same way), so there is no loop here
-- either; at the measured ~400k messages the work is the regular-expression filter plus one
-- rewrite per affected row, and it holds row locks on those rows only (no table lock), the
-- same as 0097. Run it before the rolling deploy of the build that writes English names, or
-- after, as the readers accept both.
--
-- ## RLS
--
-- Untouched, and not in `BOUNDARY_MIGRATIONS`: no table is created, dropped or renamed. It
-- runs as the owner, which row-level security does not restrict (the tables are not FORCEd),
-- so every tenant's rows are rewritten. The helper functions exist only for the length of
-- this migration. Verified by `scripts/rls-test-db.sh` against captured rows.


CREATE OR REPLACE FUNCTION grid_0162_v(v jsonb, m jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'string' AND m ? (v #>> '{}') THEN m -> (v #>> '{}') ELSE v END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_field(o jsonb, f text, m jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(o) = 'object' AND o ? f THEN jsonb_set(o, ARRAY[f], grid_0162_v(o -> f, m)) ELSE o END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_rename(o jsonb, pair jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(o) = 'object' AND (pair ->> 0) <> (pair ->> 1) AND o ? (pair ->> 0)
              THEN (o - (pair ->> 0)) || jsonb_build_object(
                     pair ->> 1, CASE WHEN o ? (pair ->> 1) THEN o -> (pair ->> 1) ELSE o -> (pair ->> 0) END)
              ELSE o END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_each(a jsonb, m jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(a) = 'array'
              THEN coalesce((SELECT jsonb_agg(grid_0162_v(e, m) ORDER BY ord)
                               FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
              ELSE a END
$$;

--> statement-breakpoint
-- A path whose root is the first of the pair gets the second one.
CREATE OR REPLACE FUNCTION grid_0162_path(o jsonb, pair jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(o) = 'object' AND jsonb_typeof(o -> 'path') = 'string'
                   AND left(o ->> 'path', length(pair ->> 0)) = (pair ->> 0)
              THEN jsonb_set(o, '{path}', to_jsonb((pair ->> 1) || substr(o ->> 'path', length(pair ->> 0) + 1)))
              ELSE o END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_findings(f jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f -> 'items') IS DISTINCT FROM 'array' THEN RETURN f; END IF;
  RETURN jsonb_set(f, '{items}', coalesce((
    SELECT jsonb_agg(grid_0162_field(grid_0162_field(item, 'status', maps -> 'status'), 'grounding', maps -> 'grounding') ORDER BY ord)
      FROM jsonb_array_elements(f -> 'items') WITH ORDINALITY AS t(item, ord)), '[]'::jsonb));
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_answer_meta(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(a -> 'callout') IS DISTINCT FROM 'object' THEN RETURN a; END IF;
  RETURN jsonb_set(a, '{callout}', grid_0162_field(a -> 'callout', 'kind', maps -> 'callout'));
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_phased(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(a) = 'array'
              THEN coalesce((SELECT jsonb_agg(grid_0162_field(e, 'phase', maps -> 'runPhase') ORDER BY ord)
                               FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
              ELSE a END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_run_ledger(l jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' THEN RETURN l; END IF;
  l := grid_0162_field(l, 'status', maps -> 'runStatus');
  IF l ? 'phases' THEN l := jsonb_set(l, '{phases}', grid_0162_phased(l -> 'phases', maps)); END IF;
  IF l ? 'steps' THEN l := jsonb_set(l, '{steps}', grid_0162_phased(l -> 'steps', maps)); END IF;
  IF jsonb_typeof(l -> 'error') = 'object' AND l -> 'error' ? 'completedBefore' THEN
    l := jsonb_set(l, '{error,completedBefore}', grid_0162_each(l #> '{error,completedBefore}', maps -> 'runPhase'));
  END IF;
  RETURN grid_0162_rename(l, maps -> 'basisKey');
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_source(s jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT grid_0162_rename(
    grid_0162_field(grid_0162_field(grid_0162_field(grid_0162_field(s,
      'kind', maps -> 'kind'), 'lane', maps -> 'lane'), 'binding_status', maps -> 'binding'), 'rank', maps -> 'rank'),
    maps -> 'clause')
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_sources(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(a) = 'array'
              THEN coalesce((SELECT jsonb_agg(grid_0162_source(e, maps) ORDER BY ord)
                               FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
              ELSE a END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_keyed(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(a) = 'array'
              THEN coalesce((SELECT jsonb_agg(grid_0162_field(e, 'key', maps -> 'turnKey') ORDER BY ord)
                               FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
              ELSE a END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_stamps(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(a) = 'array'
              THEN coalesce((SELECT jsonb_agg(grid_0162_rename(e, maps -> 'clause') ORDER BY ord)
                               FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb)
              ELSE a END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_lane(l jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT grid_0162_field(grid_0162_field(l, 'key', maps -> 'lane'), 'kind', maps -> 'kind')
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_turn_event(t jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(t) IS DISTINCT FROM 'object' THEN RETURN t; END IF;
  t := grid_0162_field(t, 'key', maps -> 'turnKey');
  IF (t ->> 'key') IN ('status.retrieval.punkt', 'status.retrieval.clause') AND jsonb_typeof(t -> 'values') = 'object' THEN
    t := jsonb_set(t, '{values}', grid_0162_rename(t -> 'values', maps -> 'turnValue'));
  END IF;
  RETURN t;
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_step(s jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN s; END IF;
  IF jsonb_typeof(s -> 'traceLanes') = 'array' THEN
    s := jsonb_set(s, '{traceLanes}', coalesce((
      SELECT jsonb_agg(grid_0162_lane(l, maps) ORDER BY ord)
        FROM jsonb_array_elements(s -> 'traceLanes') WITH ORDINALITY AS t(l, ord)), '[]'::jsonb));
  END IF;
  IF s ? 'turnEvent' THEN s := jsonb_set(s, '{turnEvent}', grid_0162_turn_event(s -> 'turnEvent', maps)); END IF;
  RETURN s;
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_provenance(p jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN p; END IF;
  IF jsonb_typeof(p -> 'thinkingSteps') = 'array' THEN
    p := jsonb_set(p, '{thinkingSteps}', coalesce((
      SELECT jsonb_agg(grid_0162_step(s, maps) ORDER BY ord)
        FROM jsonb_array_elements(p -> 'thinkingSteps') WITH ORDINALITY AS t(s, ord)), '[]'::jsonb));
  END IF;
  IF p ? 'degradedReasons' THEN p := jsonb_set(p, '{degradedReasons}', grid_0162_each(p -> 'degradedReasons', maps -> 'degraded')); END IF;
  IF p ? 'retrievalLedger' THEN p := jsonb_set(p, '{retrievalLedger}', grid_0162_keyed(p -> 'retrievalLedger', maps)); END IF;
  IF p ? 'quoteStamps' THEN p := jsonb_set(p, '{quoteStamps}', grid_0162_stamps(p -> 'quoteStamps', maps)); END IF;
  RETURN p;
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_card(c jsonb, ty text, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RETURN c; END IF;
  CASE ty
    WHEN 'fire_access_plan' THEN
      RETURN grid_0162_rename(grid_0162_rename(c, maps -> 'staging'), maps -> 'buildingClass');
    WHEN 'guardrail_check' THEN
      RETURN grid_0162_field(c, 'context', maps -> 'context');
    WHEN 'building_section' THEN
      IF jsonb_typeof(c -> 'markers') IS DISTINCT FROM 'array' THEN RETURN c; END IF;
      RETURN jsonb_set(c, '{markers}', coalesce((
        SELECT jsonb_agg(grid_0162_field(m, 'kind', maps -> 'markerKind') ORDER BY ord)
          FROM jsonb_array_elements(c -> 'markers') WITH ORDINALITY AS t(m, ord)), '[]'::jsonb));
    WHEN 'document_draft' THEN
      RETURN grid_0162_path(c, maps -> 'draftRoot');
    WHEN 'document_grid' THEN
      IF jsonb_typeof(c -> 'documents') IS DISTINCT FROM 'array' THEN RETURN c; END IF;
      RETURN jsonb_set(c, '{documents}', coalesce((
        SELECT jsonb_agg(grid_0162_field(d, 'source', maps -> 'docSource') ORDER BY ord)
          FROM jsonb_array_elements(c -> 'documents') WITH ORDINALITY AS t(d, ord)), '[]'::jsonb));
    WHEN 'file_operation_proposal' THEN
      IF jsonb_typeof(c -> 'operations') IS DISTINCT FROM 'array' THEN RETURN c; END IF;
      RETURN jsonb_set(c, '{operations}', coalesce((
        SELECT jsonb_agg(grid_0162_field(o, 'source', maps -> 'docSource') ORDER BY ord)
          FROM jsonb_array_elements(c -> 'operations') WITH ORDINALITY AS t(o, ord)), '[]'::jsonb));
    ELSE
      RETURN c;
  END CASE;
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_cards(a jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN RETURN a; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(
             CASE
               WHEN jsonb_typeof(card) = 'object' AND card ->> 'type' = 'surface' AND jsonb_typeof(card -> 'components') = 'array'
               THEN jsonb_set(card, '{components}', coalesce((
                      SELECT jsonb_agg(grid_0162_card(comp, comp ->> 'component', maps) ORDER BY cord)
                        FROM jsonb_array_elements(card -> 'components') WITH ORDINALITY AS u(comp, cord)), '[]'::jsonb))
               WHEN jsonb_typeof(card) = 'object' THEN grid_0162_card(card, card ->> 'type', maps)
               ELSE card
             END ORDER BY ord)
      FROM jsonb_array_elements(a) WITH ORDINALITY AS t(card, ord)), '[]'::jsonb);
END
$$;

--> statement-breakpoint
-- The citation-health ledger counts sources per lane in `detail.lanes`, keyed by lane.
CREATE OR REPLACE FUNCTION grid_0162_lane_counts(d jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(d -> 'lanes') = 'object'
              THEN jsonb_set(d, '{lanes}', coalesce((
                     SELECT jsonb_object_agg(coalesce(maps -> 'lane' ->> k, k), v)
                       FROM jsonb_each(d -> 'lanes') AS t(k, v)), '{}'::jsonb))
              ELSE d END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0162_metadata(m jsonb, maps jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' THEN RETURN m; END IF;
  IF m ? 'findings' THEN m := jsonb_set(m, '{findings}', grid_0162_findings(m -> 'findings', maps)); END IF;
  IF m ? 'answerMeta' THEN m := jsonb_set(m, '{answerMeta}', grid_0162_answer_meta(m -> 'answerMeta', maps)); END IF;
  IF m ? 'answer_meta' THEN m := jsonb_set(m, '{answer_meta}', grid_0162_answer_meta(m -> 'answer_meta', maps)); END IF;
  IF m ? 'run_ledger' THEN m := jsonb_set(m, '{run_ledger}', grid_0162_run_ledger(m -> 'run_ledger', maps)); END IF;
  IF jsonb_typeof(m -> 'citations') = 'object' AND m -> 'citations' ? 'sources' THEN
    m := jsonb_set(m, '{citations,sources}', grid_0162_sources(m #> '{citations,sources}', maps));
  ELSIF jsonb_typeof(m -> 'citations') = 'array' THEN
    m := jsonb_set(m, '{citations}', grid_0162_sources(m -> 'citations', maps));
  END IF;
  FOREACH k IN ARRAY ARRAY['sources', 'read_sources'] LOOP
    IF jsonb_typeof(m -> k) = 'array' THEN m := jsonb_set(m, ARRAY[k], grid_0162_sources(m -> k, maps)); END IF;
  END LOOP;
  IF m ? 'degraded_reasons' THEN m := jsonb_set(m, '{degraded_reasons}', grid_0162_each(m -> 'degraded_reasons', maps -> 'degraded')); END IF;
  IF m ? 'retrieval_ledger' THEN m := jsonb_set(m, '{retrieval_ledger}', grid_0162_keyed(m -> 'retrieval_ledger', maps)); END IF;
  IF m ? 'quote_stamps' THEN m := jsonb_set(m, '{quote_stamps}', grid_0162_stamps(m -> 'quote_stamps', maps)); END IF;
  IF m ? 'cards' THEN m := jsonb_set(m, '{cards}', grid_0162_cards(m -> 'cards', maps)); END IF;
  IF m ? 'provenance' THEN m := jsonb_set(m, '{provenance}', grid_0162_provenance(m -> 'provenance', maps)); END IF;
  RETURN m;
END
$$;

--> statement-breakpoint
WITH changed AS (
  SELECT id, grid_0162_metadata(metadata, '{"basisKey": ["grundlage", "basis"], "binding": {"auslegend": "interpretive", "bindend": "binding", "unbekannt": "unknown", "verbindlich_erklaert": "declared_binding"}, "buildingClass": ["gebaeudeklasse", "building_class"], "callout": {"achtung": "warning", "frist": "deadline", "hinweis": "note", "tipp": "tip"}, "clause": ["punkt", "clause"], "context": {"balkon": "balcony", "dachterrasse": "roof_terrace", "fenster": "window", "stiege": "staircase"}, "degraded": {"grundlage_unread": "basis_unread"}, "docSource": {"buero": "office", "projekt": "project"}, "draftRoot": ["/entwuerfe/", "/drafts/"], "grounding": {"abgeleitet": "derived", "belegt": "sourced", "offen": "open"}, "kind": {"baurecht": "building_law", "buero": "office", "messung": "measurement", "projekt": "project"}, "lane": {"baurecht": "building_law", "baurecht_basis": "building_law_base", "baurecht_bund": "building_law_federal", "baurecht_land": "building_law_state", "baurecht_oib": "building_law_oib", "baurecht_oib_begriffe": "building_law_oib_definitions", "baurecht_oib_diff": "building_law_oib_amendment", "baurecht_oib_erlaeuterung": "building_law_oib_explanatory_note", "baurecht_oib_leitfaden": "building_law_oib_guide", "baurecht_oib_referenz": "building_law_oib_reference", "baurecht_ris": "building_law_ris", "baurecht_verordnung": "building_law_ordinance", "behoerde": "authority", "buero": "office", "buero_piloti": "office_piloti", "messung": "measurement", "norm_extern": "external_standard", "projekt": "project"}, "markerKind": {"fluchtniveau": "escape_level"}, "rank": {"behoerdliche_info": "authority_info", "bundesgesetz": "federal_law", "landesgesetz": "state_law", "norm_extern": "external_standard", "verordnung": "ordinance"}, "runPhase": {"abgelegt": "filed", "planen": "planning", "pruefen": "checking", "recherchieren": "researching", "schreiben": "writing"}, "runStatus": {"abgebrochen": "cancelled", "angelegt": "created", "fehlgeschlagen": "failed", "fertig": "done", "laeuft": "running", "unterbrochen": "interrupted", "wartet": "waiting"}, "staging": ["aufstellflaeche", "staging_area"], "status": {"erfuellt": "met", "nicht_anwendbar": "not_applicable", "nicht_erfuellt": "not_met", "offen": "open"}, "turnKey": {"status.retrieval.punkt": "status.retrieval.clause"}, "turnValue": ["punkt", "clause"]}'::jsonb) AS metadata
    FROM "messages"
   WHERE metadata IS NOT NULL
     AND metadata::text ~ '"(abgebrochen|abgelegt|abgeleitet|achtung|angelegt|aufstellflaeche|auslegend|balkon|baurecht|baurecht_basis|baurecht_bund|baurecht_land|baurecht_oib|baurecht_oib_begriffe|baurecht_oib_diff|baurecht_oib_erlaeuterung|baurecht_oib_leitfaden|baurecht_oib_referenz|baurecht_ris|baurecht_verordnung|behoerde|behoerdliche_info|belegt|bindend|buero|buero_piloti|bundesgesetz|dachterrasse|erfuellt|fehlgeschlagen|fenster|fertig|fluchtniveau|frist|gebaeudeklasse|grundlage|grundlage_unread|hinweis|laeuft|landesgesetz|messung|nicht_anwendbar|nicht_erfuellt|norm_extern|offen|planen|projekt|pruefen|punkt|recherchieren|schreiben|status.retrieval.punkt|stiege|tipp|unbekannt|unterbrochen|verbindlich_erklaert|verordnung|wartet)"|/entwuerfe/'
)
UPDATE "messages" AS m
   SET metadata = c.metadata
  FROM changed c
 WHERE m.id = c.id
   AND m.metadata IS DISTINCT FROM c.metadata;

--> statement-breakpoint
UPDATE "citation_events" AS e
   SET detail = grid_0162_lane_counts(e.detail, '{"basisKey": ["grundlage", "basis"], "binding": {"auslegend": "interpretive", "bindend": "binding", "unbekannt": "unknown", "verbindlich_erklaert": "declared_binding"}, "buildingClass": ["gebaeudeklasse", "building_class"], "callout": {"achtung": "warning", "frist": "deadline", "hinweis": "note", "tipp": "tip"}, "clause": ["punkt", "clause"], "context": {"balkon": "balcony", "dachterrasse": "roof_terrace", "fenster": "window", "stiege": "staircase"}, "degraded": {"grundlage_unread": "basis_unread"}, "docSource": {"buero": "office", "projekt": "project"}, "draftRoot": ["/entwuerfe/", "/drafts/"], "grounding": {"abgeleitet": "derived", "belegt": "sourced", "offen": "open"}, "kind": {"baurecht": "building_law", "buero": "office", "messung": "measurement", "projekt": "project"}, "lane": {"baurecht": "building_law", "baurecht_basis": "building_law_base", "baurecht_bund": "building_law_federal", "baurecht_land": "building_law_state", "baurecht_oib": "building_law_oib", "baurecht_oib_begriffe": "building_law_oib_definitions", "baurecht_oib_diff": "building_law_oib_amendment", "baurecht_oib_erlaeuterung": "building_law_oib_explanatory_note", "baurecht_oib_leitfaden": "building_law_oib_guide", "baurecht_oib_referenz": "building_law_oib_reference", "baurecht_ris": "building_law_ris", "baurecht_verordnung": "building_law_ordinance", "behoerde": "authority", "buero": "office", "buero_piloti": "office_piloti", "messung": "measurement", "norm_extern": "external_standard", "projekt": "project"}, "markerKind": {"fluchtniveau": "escape_level"}, "rank": {"behoerdliche_info": "authority_info", "bundesgesetz": "federal_law", "landesgesetz": "state_law", "norm_extern": "external_standard", "verordnung": "ordinance"}, "runPhase": {"abgelegt": "filed", "planen": "planning", "pruefen": "checking", "recherchieren": "researching", "schreiben": "writing"}, "runStatus": {"abgebrochen": "cancelled", "angelegt": "created", "fehlgeschlagen": "failed", "fertig": "done", "laeuft": "running", "unterbrochen": "interrupted", "wartet": "waiting"}, "staging": ["aufstellflaeche", "staging_area"], "status": {"erfuellt": "met", "nicht_anwendbar": "not_applicable", "nicht_erfuellt": "not_met", "offen": "open"}, "turnKey": {"status.retrieval.punkt": "status.retrieval.clause"}, "turnValue": ["punkt", "clause"]}'::jsonb)
 WHERE e.detail -> 'lanes' ?| ARRAY['baurecht', 'baurecht_basis', 'baurecht_bund', 'baurecht_land', 'baurecht_oib', 'baurecht_oib_begriffe', 'baurecht_oib_diff', 'baurecht_oib_erlaeuterung', 'baurecht_oib_leitfaden', 'baurecht_oib_referenz', 'baurecht_ris', 'baurecht_verordnung', 'behoerde', 'buero', 'buero_piloti', 'messung', 'norm_extern', 'projekt']
   AND e.detail IS DISTINCT FROM grid_0162_lane_counts(e.detail, '{"basisKey": ["grundlage", "basis"], "binding": {"auslegend": "interpretive", "bindend": "binding", "unbekannt": "unknown", "verbindlich_erklaert": "declared_binding"}, "buildingClass": ["gebaeudeklasse", "building_class"], "callout": {"achtung": "warning", "frist": "deadline", "hinweis": "note", "tipp": "tip"}, "clause": ["punkt", "clause"], "context": {"balkon": "balcony", "dachterrasse": "roof_terrace", "fenster": "window", "stiege": "staircase"}, "degraded": {"grundlage_unread": "basis_unread"}, "docSource": {"buero": "office", "projekt": "project"}, "draftRoot": ["/entwuerfe/", "/drafts/"], "grounding": {"abgeleitet": "derived", "belegt": "sourced", "offen": "open"}, "kind": {"baurecht": "building_law", "buero": "office", "messung": "measurement", "projekt": "project"}, "lane": {"baurecht": "building_law", "baurecht_basis": "building_law_base", "baurecht_bund": "building_law_federal", "baurecht_land": "building_law_state", "baurecht_oib": "building_law_oib", "baurecht_oib_begriffe": "building_law_oib_definitions", "baurecht_oib_diff": "building_law_oib_amendment", "baurecht_oib_erlaeuterung": "building_law_oib_explanatory_note", "baurecht_oib_leitfaden": "building_law_oib_guide", "baurecht_oib_referenz": "building_law_oib_reference", "baurecht_ris": "building_law_ris", "baurecht_verordnung": "building_law_ordinance", "behoerde": "authority", "buero": "office", "buero_piloti": "office_piloti", "messung": "measurement", "norm_extern": "external_standard", "projekt": "project"}, "markerKind": {"fluchtniveau": "escape_level"}, "rank": {"behoerdliche_info": "authority_info", "bundesgesetz": "federal_law", "landesgesetz": "state_law", "norm_extern": "external_standard", "verordnung": "ordinance"}, "runPhase": {"abgelegt": "filed", "planen": "planning", "pruefen": "checking", "recherchieren": "researching", "schreiben": "writing"}, "runStatus": {"abgebrochen": "cancelled", "angelegt": "created", "fehlgeschlagen": "failed", "fertig": "done", "laeuft": "running", "unterbrochen": "interrupted", "wartet": "waiting"}, "staging": ["aufstellflaeche", "staging_area"], "status": {"erfuellt": "met", "nicht_anwendbar": "not_applicable", "nicht_erfuellt": "not_met", "offen": "open"}, "turnKey": {"status.retrieval.punkt": "status.retrieval.clause"}, "turnValue": ["punkt", "clause"]}'::jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_metadata(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_lane_counts(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_cards(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_card(jsonb, text, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_provenance(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_step(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_turn_event(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_lane(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_stamps(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_keyed(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_sources(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_source(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_run_ledger(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_phased(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_answer_meta(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_findings(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_path(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_each(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_rename(jsonb, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_field(jsonb, text, jsonb);

--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0162_v(jsonb, jsonb);
