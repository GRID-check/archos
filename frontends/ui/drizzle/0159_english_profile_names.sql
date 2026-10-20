-- 0159: the project profile's keys, tokens and building ids in English.
--
-- ## What
--
-- `projects.profile` (facts, assumptions, goals, unknowns) and the prompt view
-- the agent reads (`projects.profile_prompt_view`) name the intake's answers in
-- German: `bundesland`, `geschosse_oberirdisch@bw1`, `nutzungen@bw1@wohnen`, the
-- tokens `wien`, `holzbau`, `neubau`, the building instance id `bw1` and the
-- derivation rule `gebaeudeklasse` inside a fact's evidence. They become
-- `federal_state`, `storeys_above_ground@bldg1`, `uses@bldg1@residential`, the
-- tokens `vienna`, `timber`, `new_build`, `bldg1` and `building_class`.
--
-- The names are in `frontends/ui/src/lib/project-profile/legacy-names.json`, the
-- one table the TypeScript normalizer (`legacy-names.ts`), its Python twin
-- (`aiq_agent/profile_names.py`) and this migration share. The copy below is
-- held to the file by `tests/aiq_agent/common/test_profile_names.py`. The
-- tokens are listed per NEW base key: `offen` is `open` for a zoning and for a
-- construction method, but `ja` is only `yes` for `servicing`, so a token is
-- renamed by the key it sits under, never on its own.
--
-- ## Re-runnable, and read-only for everything else
--
-- A key that is not in the table (a fact an agent invented, `country`,
-- `project_name`) is kept as it is. A row whose profile and view would not
-- change is not written at all, so a second run touches nothing. When a profile
-- holds both spellings of one key, the English one wins, as the normalizer does.
-- `profile_version` is bumped on every row that changes, so a wizard that loaded
-- the profile before this ran fails its optimistic write with a 409 and reloads
-- instead of saving the German names back over it. `profile_display` holds
-- German labels, not keys, and `profile_updated_at` is left alone: the content
-- a person sees is the same.
--
-- ## One release of tolerance
--
-- An older pod may still write the German names after this has run. Every reader
-- accepts them (`salvageProjectProfile`, `applyProjectProfilePatch`,
-- `loadProjectPromptView`, the agent's `normalize_prompt_view`) and nothing
-- writes them again. The next release deletes that tolerance.
--
-- ## RLS
--
-- Untouched: no table is created, dropped or renamed. It runs as the owner,
-- which row-level security does not restrict, so every tenant's rows are
-- rewritten. The helper functions exist only for the length of this migration.

CREATE OR REPLACE FUNCTION grid_0159_names() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $names$
SELECT $json$
{
 "keys": {
  "abweichender_bebauungsplan": "deviating_development_plan",
  "altlast": "contaminated_land",
  "anbau_grundgrenze": "build_to_plot_boundary",
  "anzahl_betten": "bed_count",
  "anzahl_einheiten": "unit_count",
  "anzahl_kinder": "children_count",
  "arbeitnehmer": "employees",
  "arbeitsstaette": "workplace",
  "aufzug": "elevator",
  "baufluchtlinien": "building_lines",
  "baujahr_bestand": "existing_year_built",
  "baumbestand": "tree_stock",
  "bauweise": "construction_method",
  "bauweise_beschreibung": "construction_method_description",
  "bauwerk_name": "building_name",
  "bauwerkstyp": "building_type",
  "bebauungsdichte": "development_density",
  "bebauungsplan": "development_plan",
  "bebauungsplan_besonderes": "development_plan_notes",
  "bebauungsweise": "development_pattern",
  "bestand_bgf_oberirdisch": "existing_gfa_above_ground",
  "bestand_fluchtniveau_m": "existing_escape_level_m",
  "bestand_geschosse_oberirdisch": "existing_storeys_above_ground",
  "bestand_geschosse_unterirdisch": "existing_storeys_below_ground",
  "bestand_massnahmen": "existing_measures",
  "bestand_neubau": "existing_or_new",
  "bestand_nutzung": "existing_use",
  "bestandsalter": "existing_age",
  "betriebsanlage": "commercial_facility",
  "bgf_oberirdisch": "gfa_above_ground",
  "bildung_typ": "education_type",
  "brandlast": "fire_load",
  "brandschutz_anlagen": "fire_safety_systems",
  "bundesland": "federal_state",
  "denkmalschutz": "heritage_protection",
  "e_ladepunkte": "ev_charge_points",
  "einheiten_ueber_400": "units_over_400",
  "einkaufszentrum": "shopping_centre",
  "errichtungsstatus": "construction_status",
  "erschliessung": "servicing",
  "fernwaerme": "district_heating",
  "fernwaerme_status": "district_heating_status",
  "fernwaerme_zone": "district_heating_zone",
  "feuerstaetten": "fireplaces",
  "flaechenwidmung": "zoning",
  "flaechenwidmung_orig": "zoning_original",
  "fluchtlinie": "building_line",
  "fluchtniveau": "escape_level",
  "fluchtniveau_m": "escape_level_m",
  "foerderung": "funding",
  "gaestebetten": "guest_beds",
  "garagenflaeche": "garage_area",
  "garagenlage": "garage_position",
  "gebaeudeklasse": "building_class",
  "gebaeudestellung": "building_position",
  "gefaehrliche_stoffe": "hazardous_substances",
  "gefahrenzonen": "hazard_zones",
  "geschosse_oberirdisch": "storeys_above_ground",
  "geschosse_unterirdisch": "storeys_below_ground",
  "gesundheit_typ": "healthcare_type",
  "groessere_renovierung": "major_renovation",
  "grundgrenze": "plot_boundary",
  "hauptnutzung": "main_use",
  "hohe_gebaeude_details": "high_rise_details",
  "kanal": "sewer",
  "kleingartengebiet": "allotment_garden_area",
  "konditionierung": "conditioning",
  "kontext_beschreibung": "context_description",
  "kontext_grundstueck": "context_plot",
  "kontext_konflikte": "context_conflicts",
  "kontext_sonderloesungen": "context_special_solutions",
  "kontext_sonstiges": "context_other",
  "kontext_ziele": "context_goals",
  "kuehlung": "cooling",
  "laermsituation": "noise_situation",
  "lueftung": "ventilation",
  "max_gebaeudehoehe": "max_building_height",
  "ne_unter_400": "units_under_400",
  "nutzungen": "uses",
  "nutzungseinheiten": "use_units",
  "oib_ausgabe": "oib_edition",
  "personen_max": "persons_max",
  "projektphase": "project_phase",
  "publikumsverkehr": "public_access",
  "rueckbaukonzept": "demolition_concept",
  "schutzgebiet": "protected_area",
  "schutzzone": "protection_zone",
  "schutzzone_altstadt": "old_town_protection_zone",
  "sicherheitskategorie": "safety_category",
  "standort_adresse": "site_address",
  "standort_details": "site_details",
  "stellplaetze": "parking_spaces",
  "stellplatz_relevant": "parking_relevant",
  "stellplatzregulativ": "parking_regulation",
  "technik_beschreibung": "technical_description",
  "technik_weitere": "further_technology",
  "tierhaltung": "livestock",
  "tragstruktur_eingriff": "structural_intervention",
  "trinkwasser": "drinking_water",
  "verabreichungsplaetze": "serving_places",
  "verkaufsflaeche": "sales_area",
  "versickerung": "infiltration",
  "vorhabensart": "work_type",
  "waermeversorgung": "heat_supply",
  "wasserrecht": "water_rights",
  "widmung": "land_designation",
  "wohneinheiten": "dwelling_units",
  "wohnform": "residential_form",
  "zertifizierung": "certification",
  "zone_flaeche": "zone_area",
  "zone_lage": "zone_position",
  "zufahrt_feuerwehr": "fire_brigade_access",
  "zugang_drei_seiten": "access_three_sides"
 },
 "tokens": {
  "federal_state": {
   "wien": "vienna",
   "niederoesterreich": "lower_austria",
   "oberoesterreich": "upper_austria",
   "steiermark": "styria",
   "kaernten": "carinthia",
   "tirol": "tyrol",
   "ausserhalb_oesterreichs": "outside_austria"
  },
  "project_phase": {
   "grundlagenermittlung": "basic_evaluation",
   "vorentwurf": "preliminary_design",
   "entwurf": "design",
   "einreichplanung": "submission_planning",
   "ausfuehrungsplanung": "execution_planning",
   "ausschreibung_vergabe": "tendering",
   "ausfuehrung": "construction",
   "fertigstellung_uebergabe": "completion_handover",
   "bestand_betrieb": "existing_operation"
  },
  "work_type": {
   "neubau": "new_build",
   "zubau": "extension",
   "umbau": "conversion",
   "sanierung": "refurbishment",
   "nutzungsaenderung": "change_of_use",
   "abbruch": "demolition",
   "aussenanlagen": "external_works"
  },
  "zoning": {
   "wohngebiet": "residential",
   "gemischt": "mixed",
   "kerngebiet": "core",
   "betriebsgebiet": "commercial",
   "sondergebiet": "special",
   "gruenland_sonder": "green_special",
   "sonstige": "other",
   "offen": "open"
  },
  "development_pattern": {
   "offen": "open",
   "gekuppelt": "semi_detached",
   "geschlossen": "closed",
   "noch_offen": "undecided"
  },
  "hazard_zones": {
   "hw_hq30": "flood_hq30",
   "hw_hq100": "flood_hq100",
   "wildbach_gelb": "torrent_yellow",
   "wildbach_rot": "torrent_red",
   "rutschung": "landslide",
   "altlast": "contaminated_land",
   "baumbestand": "tree_stock",
   "schutzgebiet": "protected_area",
   "keine": "none",
   "offen": "open"
  },
  "noise_situation": {
   "ruhig": "quiet",
   "innerstaedtisch": "urban",
   "strasse": "road",
   "bahn": "rail",
   "flug": "air",
   "gewerbe": "commercial",
   "offen": "open"
  },
  "servicing": {
   "ja": "yes",
   "teilweise": "partial",
   "nein": "no",
   "offen": "open"
  },
  "district_heating_status": {
   "verfuegbar": "available",
   "anschlussgebiet": "connection_area",
   "nicht_verfuegbar": "unavailable",
   "offen": "open"
  },
  "building_type": {
   "gebaeude": "building",
   "klein": "small",
   "sonstig": "other"
  },
  "construction_status": {
   "neubau": "new_build",
   "bestand": "existing"
  },
  "existing_measures": {
   "huelle_sanierung": "envelope_refurbishment",
   "umbau_innen": "interior_conversion",
   "aufstockung": "storey_addition",
   "zubau": "extension",
   "nutzungsaenderung": "change_of_use",
   "kernsanierung": "core_refurbishment",
   "teilabbruch": "partial_demolition"
  },
  "building_position": {
   "freistehend": "freestanding",
   "angebaut": "attached",
   "reihenhaus": "terraced"
  },
  "construction_method": {
   "mauerwerk_massivbau": "masonry_solid",
   "stahlbeton": "reinforced_concrete",
   "holzbau": "timber",
   "stahlbau": "steel",
   "offen": "open"
  },
  "conditioning": {
   "beheizt": "heated",
   "beheizt_gekuehlt": "heated_cooled",
   "teilkonditioniert": "partly_conditioned",
   "unkonditioniert": "unconditioned"
  },
  "uses": {
   "wohnen": "residential",
   "buero": "office",
   "handel": "retail",
   "gastro": "catering",
   "beherbergung": "lodging",
   "versammlung": "assembly",
   "bildung": "education",
   "gesundheit": "healthcare",
   "produktion": "production",
   "landwirtschaft": "agriculture",
   "technik": "technical"
  },
  "zone_position": {
   "oberirdisch": "above_ground",
   "unterirdisch": "below_ground",
   "beides": "both"
  },
  "residential_form": {
   "klassisch": "conventional",
   "betreut": "assisted",
   "heim": "care_home",
   "studierende": "student"
  },
  "education_type": {
   "schule": "school",
   "hochschule": "university",
   "hort": "after_school_care"
  },
  "healthcare_type": {
   "ordination": "practice",
   "krankenhaus": "hospital",
   "pflegeheim": "nursing_home"
  },
  "garage_position": {
   "tiefgarage": "underground",
   "oberirdisch_geschlossen": "above_ground_enclosed",
   "ueberdacht_offen": "covered_open",
   "freistellplaetze": "open_air"
  },
  "heat_supply": {
   "waermepumpe": "heat_pump",
   "fernwaerme": "district_heating",
   "biomasse": "biomass",
   "offen": "open"
  },
  "further_technology": {
   "lueftung": "ventilation",
   "kuehlung": "cooling",
   "versickerung": "infiltration",
   "keine": "none",
   "offen": "open"
  },
  "fire_safety_systems": {
   "bma": "fire_alarm",
   "rwa": "smoke_extraction",
   "druckbelueftung": "pressurisation",
   "keine": "none",
   "offen": "open"
  },
  "main_use": {
   "wohnen": "residential",
   "buero": "office",
   "beherbergung": "lodging",
   "versammlung": "assembly",
   "gesundheit": "healthcare",
   "landwirtschaft": "agriculture",
   "produzierend": "manufacturing",
   "lager": "storage",
   "sonstiges": "other"
  },
  "certification": {
   "keine": "none",
   "offen": "open"
  },
  "existing_or_new": {
   "bestand": "existing",
   "neubau": "new_build",
   "zu_und_umbau": "extension_and_conversion"
  },
  "land_designation": {
   "bauland": "building_land",
   "verkehrsflaeche": "traffic_area",
   "freiland": "open_land",
   "kerngebiet": "core",
   "gemischt": "mixed"
  },
  "funding": {
   "wohnbaufoerderung": "housing_subsidy",
   "sanierungsfoerderung": "refurbishment_subsidy",
   "keine": "none",
   "offen": "open"
  }
 },
 "tokenBase": {
  "abweichender_bebauungsplan": "deviating_development_plan",
  "altlast": "contaminated_land",
  "anbau_grundgrenze": "build_to_plot_boundary",
  "anzahl_betten": "bed_count",
  "anzahl_einheiten": "unit_count",
  "anzahl_kinder": "children_count",
  "arbeitnehmer": "employees",
  "arbeitsstaette": "workplace",
  "aufzug": "elevator",
  "baufluchtlinien": "building_lines",
  "baujahr_bestand": "existing_year_built",
  "baumbestand": "tree_stock",
  "bauweise": "construction_method",
  "bauweise_beschreibung": "construction_method_description",
  "bauwerk_name": "building_name",
  "bauwerkstyp": "building_type",
  "bebauungsdichte": "development_density",
  "bebauungsplan": "development_plan",
  "bebauungsplan_besonderes": "development_plan_notes",
  "bebauungsweise": "development_pattern",
  "bestand_bgf_oberirdisch": "existing_gfa_above_ground",
  "bestand_fluchtniveau_m": "existing_escape_level_m",
  "bestand_geschosse_oberirdisch": "existing_storeys_above_ground",
  "bestand_geschosse_unterirdisch": "existing_storeys_below_ground",
  "bestand_massnahmen": "existing_measures",
  "bestand_neubau": "existing_or_new",
  "bestand_nutzung": "existing_use",
  "bestandsalter": "existing_age",
  "betriebsanlage": "commercial_facility",
  "bgf_oberirdisch": "gfa_above_ground",
  "bildung_typ": "education_type",
  "brandlast": "fire_load",
  "brandschutz_anlagen": "fire_safety_systems",
  "bundesland": "federal_state",
  "denkmalschutz": "heritage_protection",
  "e_ladepunkte": "ev_charge_points",
  "einheiten_ueber_400": "units_over_400",
  "einkaufszentrum": "shopping_centre",
  "errichtungsstatus": "construction_status",
  "erschliessung": "servicing",
  "fernwaerme": "district_heating",
  "fernwaerme_status": "district_heating_status",
  "fernwaerme_zone": "district_heating_zone",
  "feuerstaetten": "fireplaces",
  "flaechenwidmung": "zoning",
  "flaechenwidmung_orig": "zoning_original",
  "fluchtlinie": "building_line",
  "fluchtniveau": "escape_level",
  "fluchtniveau_m": "escape_level_m",
  "foerderung": "funding",
  "gaestebetten": "guest_beds",
  "garagenflaeche": "garage_area",
  "garagenlage": "garage_position",
  "gebaeudeklasse": "building_class",
  "gebaeudestellung": "building_position",
  "gefaehrliche_stoffe": "hazardous_substances",
  "gefahrenzonen": "hazard_zones",
  "geschosse_oberirdisch": "storeys_above_ground",
  "geschosse_unterirdisch": "storeys_below_ground",
  "gesundheit_typ": "healthcare_type",
  "groessere_renovierung": "major_renovation",
  "grundgrenze": "plot_boundary",
  "hauptnutzung": "main_use",
  "hohe_gebaeude_details": "high_rise_details",
  "kanal": "sewer",
  "kleingartengebiet": "allotment_garden_area",
  "konditionierung": "conditioning",
  "kontext_beschreibung": "context_description",
  "kontext_grundstueck": "context_plot",
  "kontext_konflikte": "context_conflicts",
  "kontext_sonderloesungen": "context_special_solutions",
  "kontext_sonstiges": "context_other",
  "kontext_ziele": "context_goals",
  "kuehlung": "cooling",
  "laermsituation": "noise_situation",
  "lueftung": "ventilation",
  "max_gebaeudehoehe": "max_building_height",
  "ne_unter_400": "units_under_400",
  "nutzungen": "uses",
  "nutzungseinheiten": "use_units",
  "oib_ausgabe": "oib_edition",
  "personen_max": "persons_max",
  "projektphase": "project_phase",
  "publikumsverkehr": "public_access",
  "rueckbaukonzept": "demolition_concept",
  "schutzgebiet": "protected_area",
  "schutzzone": "protection_zone",
  "schutzzone_altstadt": "old_town_protection_zone",
  "sicherheitskategorie": "safety_category",
  "standort_adresse": "site_address",
  "standort_details": "site_details",
  "stellplaetze": "parking_spaces",
  "stellplatz_relevant": "parking_relevant",
  "stellplatzregulativ": "parking_regulation",
  "technik_beschreibung": "technical_description",
  "technik_weitere": "further_technology",
  "tierhaltung": "livestock",
  "tragstruktur_eingriff": "structural_intervention",
  "trinkwasser": "drinking_water",
  "verabreichungsplaetze": "serving_places",
  "verkaufsflaeche": "sales_area",
  "versickerung": "infiltration",
  "vorhabensart": "work_type",
  "waermeversorgung": "heat_supply",
  "wasserrecht": "water_rights",
  "widmung": "land_designation",
  "wohneinheiten": "dwelling_units",
  "wohnform": "residential_form",
  "zertifizierung": "certification",
  "zone_flaeche": "zone_area",
  "zone_lage": "zone_position",
  "zufahrt_feuerwehr": "fire_brigade_access",
  "zugang_drei_seiten": "access_three_sides"
 },
 "rules": {
  "gebaeudeklasse": "building_class"
 },
 "buildingFrom": "^bw([0-9]+)$",
 "buildingTo": "bldg\\1"
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
