-- Down of 0159: the German keys, tokens and building ids again, exactly as they were.
--
-- Reverses `projects.profile` and `projects.profile_prompt_view`. A key the table
-- does not know is kept. Rows written in English after 0159 are written back in
-- German too, which is what the code before 0159 reads.

CREATE OR REPLACE FUNCTION grid_0159_names() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $names$
SELECT $json$
{
 "keys": {
  "deviating_development_plan": "abweichender_bebauungsplan",
  "contaminated_land": "altlast",
  "build_to_plot_boundary": "anbau_grundgrenze",
  "bed_count": "anzahl_betten",
  "unit_count": "anzahl_einheiten",
  "children_count": "anzahl_kinder",
  "employees": "arbeitnehmer",
  "workplace": "arbeitsstaette",
  "elevator": "aufzug",
  "building_lines": "baufluchtlinien",
  "existing_year_built": "baujahr_bestand",
  "tree_stock": "baumbestand",
  "construction_method": "bauweise",
  "construction_method_description": "bauweise_beschreibung",
  "building_name": "bauwerk_name",
  "building_type": "bauwerkstyp",
  "development_density": "bebauungsdichte",
  "development_plan": "bebauungsplan",
  "development_plan_notes": "bebauungsplan_besonderes",
  "development_pattern": "bebauungsweise",
  "existing_gfa_above_ground": "bestand_bgf_oberirdisch",
  "existing_escape_level_m": "bestand_fluchtniveau_m",
  "existing_storeys_above_ground": "bestand_geschosse_oberirdisch",
  "existing_storeys_below_ground": "bestand_geschosse_unterirdisch",
  "existing_measures": "bestand_massnahmen",
  "existing_or_new": "bestand_neubau",
  "existing_use": "bestand_nutzung",
  "existing_age": "bestandsalter",
  "commercial_facility": "betriebsanlage",
  "gfa_above_ground": "bgf_oberirdisch",
  "education_type": "bildung_typ",
  "fire_load": "brandlast",
  "fire_safety_systems": "brandschutz_anlagen",
  "federal_state": "bundesland",
  "heritage_protection": "denkmalschutz",
  "ev_charge_points": "e_ladepunkte",
  "units_over_400": "einheiten_ueber_400",
  "shopping_centre": "einkaufszentrum",
  "construction_status": "errichtungsstatus",
  "servicing": "erschliessung",
  "district_heating": "fernwaerme",
  "district_heating_status": "fernwaerme_status",
  "district_heating_zone": "fernwaerme_zone",
  "fireplaces": "feuerstaetten",
  "zoning": "flaechenwidmung",
  "zoning_original": "flaechenwidmung_orig",
  "building_line": "fluchtlinie",
  "escape_level": "fluchtniveau",
  "escape_level_m": "fluchtniveau_m",
  "funding": "foerderung",
  "guest_beds": "gaestebetten",
  "garage_area": "garagenflaeche",
  "garage_position": "garagenlage",
  "building_class": "gebaeudeklasse",
  "building_position": "gebaeudestellung",
  "hazardous_substances": "gefaehrliche_stoffe",
  "hazard_zones": "gefahrenzonen",
  "storeys_above_ground": "geschosse_oberirdisch",
  "storeys_below_ground": "geschosse_unterirdisch",
  "healthcare_type": "gesundheit_typ",
  "major_renovation": "groessere_renovierung",
  "plot_boundary": "grundgrenze",
  "main_use": "hauptnutzung",
  "high_rise_details": "hohe_gebaeude_details",
  "sewer": "kanal",
  "allotment_garden_area": "kleingartengebiet",
  "conditioning": "konditionierung",
  "context_description": "kontext_beschreibung",
  "context_plot": "kontext_grundstueck",
  "context_conflicts": "kontext_konflikte",
  "context_special_solutions": "kontext_sonderloesungen",
  "context_other": "kontext_sonstiges",
  "context_goals": "kontext_ziele",
  "cooling": "kuehlung",
  "noise_situation": "laermsituation",
  "ventilation": "lueftung",
  "max_building_height": "max_gebaeudehoehe",
  "units_under_400": "ne_unter_400",
  "uses": "nutzungen",
  "use_units": "nutzungseinheiten",
  "oib_edition": "oib_ausgabe",
  "persons_max": "personen_max",
  "project_phase": "projektphase",
  "public_access": "publikumsverkehr",
  "demolition_concept": "rueckbaukonzept",
  "protected_area": "schutzgebiet",
  "protection_zone": "schutzzone",
  "old_town_protection_zone": "schutzzone_altstadt",
  "safety_category": "sicherheitskategorie",
  "site_address": "standort_adresse",
  "site_details": "standort_details",
  "parking_spaces": "stellplaetze",
  "parking_relevant": "stellplatz_relevant",
  "parking_regulation": "stellplatzregulativ",
  "technical_description": "technik_beschreibung",
  "further_technology": "technik_weitere",
  "livestock": "tierhaltung",
  "structural_intervention": "tragstruktur_eingriff",
  "drinking_water": "trinkwasser",
  "serving_places": "verabreichungsplaetze",
  "sales_area": "verkaufsflaeche",
  "infiltration": "versickerung",
  "work_type": "vorhabensart",
  "heat_supply": "waermeversorgung",
  "water_rights": "wasserrecht",
  "land_designation": "widmung",
  "dwelling_units": "wohneinheiten",
  "residential_form": "wohnform",
  "certification": "zertifizierung",
  "zone_area": "zone_flaeche",
  "zone_position": "zone_lage",
  "fire_brigade_access": "zufahrt_feuerwehr",
  "access_three_sides": "zugang_drei_seiten"
 },
 "tokens": {
  "federal_state": {
   "vienna": "wien",
   "lower_austria": "niederoesterreich",
   "upper_austria": "oberoesterreich",
   "styria": "steiermark",
   "carinthia": "kaernten",
   "tyrol": "tirol",
   "outside_austria": "ausserhalb_oesterreichs"
  },
  "project_phase": {
   "basic_evaluation": "grundlagenermittlung",
   "preliminary_design": "vorentwurf",
   "design": "entwurf",
   "submission_planning": "einreichplanung",
   "execution_planning": "ausfuehrungsplanung",
   "tendering": "ausschreibung_vergabe",
   "construction": "ausfuehrung",
   "completion_handover": "fertigstellung_uebergabe",
   "existing_operation": "bestand_betrieb"
  },
  "work_type": {
   "new_build": "neubau",
   "extension": "zubau",
   "conversion": "umbau",
   "refurbishment": "sanierung",
   "change_of_use": "nutzungsaenderung",
   "demolition": "abbruch",
   "external_works": "aussenanlagen"
  },
  "zoning": {
   "residential": "wohngebiet",
   "mixed": "gemischt",
   "core": "kerngebiet",
   "commercial": "betriebsgebiet",
   "special": "sondergebiet",
   "green_special": "gruenland_sonder",
   "other": "sonstige",
   "open": "offen"
  },
  "development_pattern": {
   "open": "offen",
   "semi_detached": "gekuppelt",
   "closed": "geschlossen",
   "undecided": "noch_offen"
  },
  "hazard_zones": {
   "flood_hq30": "hw_hq30",
   "flood_hq100": "hw_hq100",
   "torrent_yellow": "wildbach_gelb",
   "torrent_red": "wildbach_rot",
   "landslide": "rutschung",
   "contaminated_land": "altlast",
   "tree_stock": "baumbestand",
   "protected_area": "schutzgebiet",
   "none": "keine",
   "open": "offen"
  },
  "noise_situation": {
   "quiet": "ruhig",
   "urban": "innerstaedtisch",
   "road": "strasse",
   "rail": "bahn",
   "air": "flug",
   "commercial": "gewerbe",
   "open": "offen"
  },
  "servicing": {
   "yes": "ja",
   "partial": "teilweise",
   "no": "nein",
   "open": "offen"
  },
  "district_heating_status": {
   "available": "verfuegbar",
   "connection_area": "anschlussgebiet",
   "unavailable": "nicht_verfuegbar",
   "open": "offen"
  },
  "building_type": {
   "building": "gebaeude",
   "small": "klein",
   "other": "sonstig"
  },
  "construction_status": {
   "new_build": "neubau",
   "existing": "bestand"
  },
  "existing_measures": {
   "envelope_refurbishment": "huelle_sanierung",
   "interior_conversion": "umbau_innen",
   "storey_addition": "aufstockung",
   "extension": "zubau",
   "change_of_use": "nutzungsaenderung",
   "core_refurbishment": "kernsanierung",
   "partial_demolition": "teilabbruch"
  },
  "building_position": {
   "freestanding": "freistehend",
   "attached": "angebaut",
   "terraced": "reihenhaus"
  },
  "construction_method": {
   "masonry_solid": "mauerwerk_massivbau",
   "reinforced_concrete": "stahlbeton",
   "timber": "holzbau",
   "steel": "stahlbau",
   "open": "offen"
  },
  "conditioning": {
   "heated": "beheizt",
   "heated_cooled": "beheizt_gekuehlt",
   "partly_conditioned": "teilkonditioniert",
   "unconditioned": "unkonditioniert"
  },
  "uses": {
   "residential": "wohnen",
   "office": "buero",
   "retail": "handel",
   "catering": "gastro",
   "lodging": "beherbergung",
   "assembly": "versammlung",
   "education": "bildung",
   "healthcare": "gesundheit",
   "production": "produktion",
   "agriculture": "landwirtschaft",
   "technical": "technik"
  },
  "zone_position": {
   "above_ground": "oberirdisch",
   "below_ground": "unterirdisch",
   "both": "beides"
  },
  "residential_form": {
   "conventional": "klassisch",
   "assisted": "betreut",
   "care_home": "heim",
   "student": "studierende"
  },
  "education_type": {
   "school": "schule",
   "university": "hochschule",
   "after_school_care": "hort"
  },
  "healthcare_type": {
   "practice": "ordination",
   "hospital": "krankenhaus",
   "nursing_home": "pflegeheim"
  },
  "garage_position": {
   "underground": "tiefgarage",
   "above_ground_enclosed": "oberirdisch_geschlossen",
   "covered_open": "ueberdacht_offen",
   "open_air": "freistellplaetze"
  },
  "heat_supply": {
   "heat_pump": "waermepumpe",
   "district_heating": "fernwaerme",
   "biomass": "biomasse",
   "open": "offen"
  },
  "further_technology": {
   "ventilation": "lueftung",
   "cooling": "kuehlung",
   "infiltration": "versickerung",
   "none": "keine",
   "open": "offen"
  },
  "fire_safety_systems": {
   "fire_alarm": "bma",
   "smoke_extraction": "rwa",
   "pressurisation": "druckbelueftung",
   "none": "keine",
   "open": "offen"
  },
  "main_use": {
   "residential": "wohnen",
   "office": "buero",
   "lodging": "beherbergung",
   "assembly": "versammlung",
   "healthcare": "gesundheit",
   "agriculture": "landwirtschaft",
   "manufacturing": "produzierend",
   "storage": "lager",
   "other": "sonstiges"
  },
  "certification": {
   "none": "keine",
   "open": "offen"
  },
  "existing_or_new": {
   "existing": "bestand",
   "new_build": "neubau",
   "extension_and_conversion": "zu_und_umbau"
  },
  "land_designation": {
   "building_land": "bauland",
   "traffic_area": "verkehrsflaeche",
   "open_land": "freiland",
   "core": "kerngebiet",
   "mixed": "gemischt"
  },
  "funding": {
   "housing_subsidy": "wohnbaufoerderung",
   "refurbishment_subsidy": "sanierungsfoerderung",
   "none": "keine",
   "open": "offen"
  }
 },
 "tokenBase": {},
 "rules": {
  "building_class": "gebaeudeklasse"
 },
 "buildingFrom": "^bldg([0-9]+)$",
 "buildingTo": "bw\\1"
}
$json$::jsonb
$names$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION grid_0159_key(names jsonb, k text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  parts text[];
  renamed text[];
  i integer;
BEGIN
  IF k IS NULL OR k = '' THEN RETURN k; END IF;
  parts := string_to_array(k, '@');
  renamed := ARRAY[coalesce(names #>> ARRAY['keys', parts[1]], parts[1])];
  IF array_length(parts, 1) >= 2 THEN
    renamed := renamed || regexp_replace(parts[2], names->>'buildingFrom', names->>'buildingTo');
    FOR i IN 3 .. array_length(parts, 1) LOOP
      renamed := renamed || coalesce(names #>> ARRAY['tokens', 'uses', parts[i]], parts[i]);
    END LOOP;
  END IF;
  RETURN array_to_string(renamed, '@');
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_token(names jsonb, base text, token text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(names #>> ARRAY['tokens', coalesce(names #>> ARRAY['tokenBase', base], base), token], token)
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_value(names jsonb, k text, v jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  base text := split_part(k, '@', 1);
BEGIN
  IF names->'tokens' -> coalesce(names #>> ARRAY['tokenBase', base], base) IS NULL THEN RETURN v; END IF;
  IF jsonb_typeof(v) = 'string' THEN
    RETURN to_jsonb(grid_0159_token(names, base, v #>> '{}'));
  ELSIF jsonb_typeof(v) = 'array' THEN
    RETURN coalesce((
      SELECT jsonb_agg(
        CASE WHEN jsonb_typeof(e) = 'string' THEN to_jsonb(grid_0159_token(names, base, e #>> '{}')) ELSE e END
        ORDER BY ord)
      FROM jsonb_array_elements(v) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);
  END IF;
  RETURN v;
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_evidence(names jsonb, evidence jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
BEGIN
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'array' THEN RETURN evidence; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(e) = 'object' AND e->>'kind' = 'derivation' THEN
          CASE WHEN jsonb_typeof(e->'inputs') = 'array' THEN
            jsonb_set(
              CASE WHEN jsonb_typeof(e->'rule') = 'string'
                   THEN jsonb_set(e, '{rule}', to_jsonb(coalesce(names #>> ARRAY['rules', e->>'rule'], e->>'rule')))
                   ELSE e END,
              '{inputs}',
              coalesce((
                SELECT jsonb_agg(
                  CASE
                    WHEN jsonb_typeof(i) = 'object' AND jsonb_typeof(i->'key') = 'string' THEN
                      CASE WHEN i ? 'value'
                           THEN jsonb_set(jsonb_set(i, '{key}', to_jsonb(grid_0159_key(names, i->>'key'))), '{value}', grid_0159_value(names, i->>'key', i->'value'))
                           ELSE jsonb_set(i, '{key}', to_jsonb(grid_0159_key(names, i->>'key'))) END
                    ELSE i
                  END ORDER BY iord)
                FROM jsonb_array_elements(e->'inputs') WITH ORDINALITY AS it(i, iord)), '[]'::jsonb))
          WHEN jsonb_typeof(e->'rule') = 'string' THEN
            jsonb_set(e, '{rule}', to_jsonb(coalesce(names #>> ARRAY['rules', e->>'rule'], e->>'rule')))
          ELSE e END
        ELSE e
      END ORDER BY ord)
    FROM jsonb_array_elements(evidence) WITH ORDINALITY AS t(e, ord)), '[]'::jsonb);
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_entry(names jsonb, k text, entry jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  result jsonb := entry;
BEGIN
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RETURN entry; END IF;
  IF entry ? 'value' THEN
    result := jsonb_set(result, '{value}', grid_0159_value(names, k, entry->'value'));
  END IF;
  IF jsonb_typeof(entry->'evidence') = 'array' THEN
    result := jsonb_set(result, '{evidence}', grid_0159_evidence(names, entry->'evidence'));
  END IF;
  IF jsonb_typeof(entry->'alternatives') = 'array' THEN
    result := jsonb_set(result, '{alternatives}', coalesce((
      SELECT jsonb_agg(
        CASE WHEN jsonb_typeof(a) = 'object' THEN
          CASE WHEN a ? 'evidence' AND jsonb_typeof(a->'evidence') = 'array'
               THEN jsonb_set(CASE WHEN a ? 'value' THEN jsonb_set(a, '{value}', grid_0159_value(names, k, a->'value')) ELSE a END,
                              '{evidence}', grid_0159_evidence(names, a->'evidence'))
               ELSE CASE WHEN a ? 'value' THEN jsonb_set(a, '{value}', grid_0159_value(names, k, a->'value')) ELSE a END END
        ELSE a END ORDER BY ord)
      FROM jsonb_array_elements(entry->'alternatives') WITH ORDINALITY AS t(a, ord)), '[]'::jsonb));
  END IF;
  RETURN result;
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_section(names jsonb, section jsonb, as_entry boolean) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(jsonb_object_agg(d.newkey, d.newval), '{}'::jsonb)
  FROM (
    SELECT DISTINCT ON (s.newkey) s.newkey, s.newval
    FROM (
      SELECT grid_0159_key(names, e.k) AS newkey,
             CASE WHEN as_entry THEN grid_0159_entry(names, e.k, e.v) ELSE grid_0159_value(names, e.k, e.v) END AS newval,
             (grid_0159_key(names, e.k) = e.k) AS already
      FROM jsonb_each(section) AS e(k, v)
    ) s
    ORDER BY s.newkey, s.already DESC
  ) d
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_profile(names jsonb, p jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  result jsonb := p;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN p; END IF;
  IF jsonb_typeof(p->'facts') = 'object' THEN
    result := jsonb_set(result, '{facts}', grid_0159_section(names, p->'facts', true));
  END IF;
  IF jsonb_typeof(p->'assumptions') = 'object' THEN
    result := jsonb_set(result, '{assumptions}', grid_0159_section(names, p->'assumptions', true));
  END IF;
  IF jsonb_typeof(p->'goals') = 'object' THEN
    result := jsonb_set(result, '{goals}', grid_0159_section(names, p->'goals', false));
  END IF;
  IF jsonb_typeof(p->'unknowns') = 'array' THEN
    result := jsonb_set(result, '{unknowns}', coalesce((
      SELECT jsonb_agg(
        CASE WHEN jsonb_typeof(u) = 'string' THEN to_jsonb(grid_0159_key(names, u #>> '{}')) ELSE u END
        ORDER BY ord)
      FROM jsonb_array_elements(p->'unknowns') WITH ORDINALITY AS t(u, ord)), '[]'::jsonb));
  END IF;
  RETURN result;
END
$f$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION grid_0159_view_line(names jsonb, line text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  m text[] := regexp_match(line, '^(- )([a-z0-9_]+(?:@[a-z0-9_]+)*)(.*)$');
  renamed text;
  tb text;
  rest text;
  entry record;
BEGIN
  IF m IS NULL THEN RETURN line; END IF;
  renamed := grid_0159_key(names, m[2]);
  tb := coalesce(names #>> ARRAY['tokenBase', split_part(m[2], '@', 1)], split_part(m[2], '@', 1));
  rest := m[3];
  IF names->'tokens'->tb IS NOT NULL THEN
    FOR entry IN SELECT key, value FROM jsonb_each_text(names->'tokens'->tb) LOOP
      rest := regexp_replace(rest, '(?<==|: |alternativ: |,)' || entry.key || '(?![a-z0-9_])', entry.value, 'g');
    END LOOP;
  END IF;
  RETURN m[1] || renamed || rest;
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0159_view(names jsonb, view text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT string_agg(grid_0159_view_line(names, t.line), E'\n' ORDER BY t.ord)
  FROM regexp_split_to_table(view, E'\n') WITH ORDINALITY AS t(line, ord)
$f$;
--> statement-breakpoint
UPDATE "projects" AS p
SET "profile" = n.profile,
    "profile_prompt_view" = n.view,
    "profile_version" = p."profile_version" + 1
FROM (
  SELECT "id",
         grid_0159_profile(grid_0159_names(), "profile") AS profile,
         CASE WHEN "profile_prompt_view" IS NULL THEN NULL
              ELSE grid_0159_view(grid_0159_names(), "profile_prompt_view") END AS view
  FROM "projects"
) n
WHERE n."id" = p."id"
  AND (n.profile IS DISTINCT FROM p."profile" OR n.view IS DISTINCT FROM p."profile_prompt_view");
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_view(jsonb, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_view_line(jsonb, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_profile(jsonb, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_section(jsonb, jsonb, boolean);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_entry(jsonb, text, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_evidence(jsonb, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_value(jsonb, text, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_token(jsonb, text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_key(jsonb, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_0159_names();
