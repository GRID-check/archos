"""The German names the project profile used to store, and what they are called now.

ONE normalizer for the whole vocabulary, the Python twin of
``apps/workspace/bff/project-profile/legacy-names.ts``: a stored key
(``bundesland``), a select token (``wien``), the building instance id (``bw1``)
and the derivation rule (``gebaeudeklasse``).

Migrations 0159-0162 rewrote every row. What still arrives with the old names for
one release is data an older pod wrote while the deploy rolled: a prompt view, a
request-context envelope a long-running job still carries, a stored norm
registry. Everything that reads such data calls this module on the way in;
nothing writes an old name again. ``packages/agent/tests/common/test_profile_names.py``
holds the tables to ``legacy-names.json``, which the TypeScript side and the
migrations are generated from. When the last such data has drained, delete this
module, the JSON, the TypeScript twin and their specs.
"""

from __future__ import annotations

import re

LEGACY_PROFILE_KEYS: dict[str, str] = {
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
    "grundstueck_ez": "plot_register_number",
    "grundstuecksflaeche": "plot_area",
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
    "zugang_drei_seiten": "access_three_sides",
}

#: NEW base key -> {old token -> new token}, for the select questions whose tokens were German.
LEGACY_PROFILE_TOKENS: dict[str, dict[str, str]] = {
    "federal_state": {
        "wien": "vienna",
        "niederoesterreich": "lower_austria",
        "oberoesterreich": "upper_austria",
        "steiermark": "styria",
        "kaernten": "carinthia",
        "tirol": "tyrol",
        "ausserhalb_oesterreichs": "outside_austria",
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
        "bestand_betrieb": "existing_operation",
    },
    "work_type": {
        "neubau": "new_build",
        "zubau": "extension",
        "umbau": "conversion",
        "sanierung": "refurbishment",
        "nutzungsaenderung": "change_of_use",
        "abbruch": "demolition",
        "aussenanlagen": "external_works",
    },
    "zoning": {
        "wohngebiet": "residential",
        "gemischt": "mixed",
        "kerngebiet": "core",
        "betriebsgebiet": "commercial",
        "sondergebiet": "special",
        "gruenland_sonder": "green_special",
        "sonstige": "other",
        "offen": "open",
    },
    "development_pattern": {
        "offen": "open",
        "gekuppelt": "semi_detached",
        "geschlossen": "closed",
        "noch_offen": "undecided",
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
        "offen": "open",
    },
    "noise_situation": {
        "ruhig": "quiet",
        "innerstaedtisch": "urban",
        "strasse": "road",
        "bahn": "rail",
        "flug": "air",
        "gewerbe": "commercial",
        "offen": "open",
    },
    "servicing": {
        "ja": "yes",
        "teilweise": "partial",
        "nein": "no",
        "offen": "open",
    },
    "district_heating_status": {
        "verfuegbar": "available",
        "anschlussgebiet": "connection_area",
        "nicht_verfuegbar": "unavailable",
        "offen": "open",
    },
    "building_type": {
        "gebaeude": "building",
        "klein": "small",
        "sonstig": "other",
    },
    "construction_status": {
        "neubau": "new_build",
        "bestand": "existing",
    },
    "existing_measures": {
        "huelle_sanierung": "envelope_refurbishment",
        "umbau_innen": "interior_conversion",
        "aufstockung": "storey_addition",
        "zubau": "extension",
        "nutzungsaenderung": "change_of_use",
        "kernsanierung": "core_refurbishment",
        "teilabbruch": "partial_demolition",
    },
    "building_position": {
        "freistehend": "freestanding",
        "angebaut": "attached",
        "reihenhaus": "terraced",
    },
    "construction_method": {
        "mauerwerk_massivbau": "masonry_solid",
        "stahlbeton": "reinforced_concrete",
        "holzbau": "timber",
        "stahlbau": "steel",
        "offen": "open",
    },
    "conditioning": {
        "beheizt": "heated",
        "beheizt_gekuehlt": "heated_cooled",
        "teilkonditioniert": "partly_conditioned",
        "unkonditioniert": "unconditioned",
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
        "technik": "technical",
    },
    "zone_position": {
        "oberirdisch": "above_ground",
        "unterirdisch": "below_ground",
        "beides": "both",
    },
    "residential_form": {
        "klassisch": "conventional",
        "betreut": "assisted",
        "heim": "care_home",
        "studierende": "student",
    },
    "education_type": {
        "schule": "school",
        "hochschule": "university",
        "hort": "after_school_care",
    },
    "healthcare_type": {
        "ordination": "practice",
        "krankenhaus": "hospital",
        "pflegeheim": "nursing_home",
    },
    "garage_position": {
        "tiefgarage": "underground",
        "oberirdisch_geschlossen": "above_ground_enclosed",
        "ueberdacht_offen": "covered_open",
        "freistellplaetze": "open_air",
    },
    "heat_supply": {
        "waermepumpe": "heat_pump",
        "fernwaerme": "district_heating",
        "biomasse": "biomass",
        "offen": "open",
    },
    "further_technology": {
        "lueftung": "ventilation",
        "kuehlung": "cooling",
        "versickerung": "infiltration",
        "keine": "none",
        "offen": "open",
    },
    "fire_safety_systems": {
        "bma": "fire_alarm",
        "rwa": "smoke_extraction",
        "druckbelueftung": "pressurisation",
        "keine": "none",
        "offen": "open",
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
        "sonstiges": "other",
    },
    "certification": {
        "keine": "none",
        "offen": "open",
    },
    "existing_or_new": {
        "bestand": "existing",
        "neubau": "new_build",
        "zu_und_umbau": "extension_and_conversion",
    },
    "land_designation": {
        "bauland": "building_land",
        "verkehrsflaeche": "traffic_area",
        "freiland": "open_land",
        "kerngebiet": "core",
        "gemischt": "mixed",
    },
    "funding": {
        "wohnbaufoerderung": "housing_subsidy",
        "sanierungsfoerderung": "refurbishment_subsidy",
        "keine": "none",
        "offen": "open",
    },
}

#: The derivation rule names inside a fact's ``evidence``.
LEGACY_DERIVATION_RULES: dict[str, str] = {"gebaeudeklasse": "building_class"}

BUILDING_PREFIX = "bldg"
LEGACY_BUILDING_PREFIX = "bw"

_LEGACY_BUILDING_ID = re.compile(rf"^{LEGACY_BUILDING_PREFIX}(\d+)$")


def normalize_building_id(building_id: str) -> str:
    """``bw2`` -> ``bldg2``; anything else is returned as it came."""
    match = _LEGACY_BUILDING_ID.match(building_id)
    return f"{BUILDING_PREFIX}{match.group(1)}" if match else building_id


def normalize_profile_base_key(base: str) -> str:
    """A base key (no ``@``): the new name, or the key itself when it is not a legacy one."""
    return LEGACY_PROFILE_KEYS.get(base, base)


def normalize_profile_token(base_key: str, token: str) -> str:
    """One select token of a (new or old) base key; a token that is not legacy is returned as it came."""
    table = LEGACY_PROFILE_TOKENS.get(normalize_profile_base_key(base_key))
    return table.get(token, token) if table else token


def normalize_profile_key(key: str) -> str:
    """``geschosse_oberirdisch@bw1@wohnen`` -> ``storeys_above_ground@bldg1@residential``."""
    base, *scopes = key.split("@")
    renamed = normalize_profile_base_key(base)
    if not scopes:
        return renamed
    building, *zones = scopes
    return "@".join(
        [renamed, normalize_building_id(building), *(normalize_profile_token("uses", zone) for zone in zones)]
    )


def normalize_profile_value(key: str, value: str) -> str:
    """A stored token of ``key`` (scoped or not), or a comma-joined list of them."""
    base = normalize_profile_base_key(key.split("@", maxsplit=1)[0])
    if base not in LEGACY_PROFILE_TOKENS:
        return value
    return ",".join(normalize_profile_token(base, token.strip()) for token in value.split(","))


_VIEW_LINE = re.compile(r"^(- )([a-z0-9_]+(?:@[a-z0-9_]+)*)(.*)$", re.MULTILINE)
_VIEW_VALUE = re.compile(r"(=|: |alternativ: )([a-z0-9_,]+)")


def normalize_prompt_view(view: str) -> str:
    """The profile prompt view with every legacy key and token on its ``- key=value`` lines renamed.

    The BFF stores and serves this text; an older pod can still have written the German names.
    """

    def rename_line(match: re.Match[str]) -> str:
        lead, key, rest = match.groups()
        renamed = normalize_profile_key(key)
        base = renamed.split("@")[0]

        def rename_value(value: re.Match[str]) -> str:
            return value.group(1) + ",".join(
                normalize_profile_token(base, token) for token in value.group(2).split(",")
            )

        return f"{lead}{renamed}{_VIEW_VALUE.sub(rename_value, rest)}"

    return _VIEW_LINE.sub(rename_line, view)


def legacy_profile_token(base_key: str, token: str) -> str:
    """The German token the vector store still holds for an English one (``vienna`` -> ``wien``).

    Points in Qdrant written before the payload rename keep German fact tokens until the operator
    rewrite (``docs/deployment/qdrant-payload-rename-runbook.md``); a filter or boost over the
    English ones asks for these too (``knowledge_layer.qdrant.scope`` and ``boost``). Delete
    with the fallback.
    """
    table = LEGACY_PROFILE_TOKENS.get(normalize_profile_base_key(base_key), {})
    return next((old for old, new in table.items() if new == token), token)
