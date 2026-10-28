"""``profile_names`` is held to ``legacy-names.json``, the source the TypeScript twin and the migrations share."""

from __future__ import annotations

import json
from pathlib import Path

from aiq_agent import profile_names

REPO = Path(__file__).resolve().parents[4]
NAMES_JSON = REPO / "apps/workspace/bff/project-profile/legacy-names.json"


def _names() -> dict:
    return json.loads(NAMES_JSON.read_text(encoding="utf-8"))


def test_the_tables_are_the_json_the_typescript_side_reads() -> None:
    names = _names()
    assert profile_names.LEGACY_PROFILE_KEYS == names["keys"]
    assert profile_names.LEGACY_PROFILE_TOKENS == names["tokens"]
    assert profile_names.LEGACY_DERIVATION_RULES == names["rules"]
    assert names["building"] == {
        "legacyPrefix": profile_names.LEGACY_BUILDING_PREFIX,
        "prefix": profile_names.BUILDING_PREFIX,
    }


def test_keys_are_renamed_with_their_building_and_zone() -> None:
    normalize = profile_names.normalize_profile_key
    assert normalize("bundesland") == "federal_state"
    assert normalize("geschosse_oberirdisch@bw12") == "storeys_above_ground@bldg12"
    assert normalize("wohneinheiten@bw1@wohnen") == "dwelling_units@bldg1@residential"
    assert normalize("federal_state") == "federal_state"
    assert normalize("agent_invented@bw1") == "agent_invented@bldg1"
    assert normalize(normalize("nutzungen@bw1")) == "uses@bldg1"


def test_tokens_are_renamed_by_their_key_and_other_words_pass() -> None:
    assert profile_names.normalize_profile_token("bundesland", "wien") == "vienna"
    assert profile_names.normalize_profile_token("federal_state", "salzburg") == "salzburg"
    assert profile_names.normalize_profile_value("nutzungen@bw1", "wohnen,buero") == "residential,office"
    assert profile_names.normalize_profile_value("bebauungsplan", "ja") == "ja"


def test_a_prompt_view_is_renamed_line_by_line() -> None:
    view = "\n".join(
        [
            "PROJECT_CONTEXT v1",
            "",
            "confirmed:",
            "- bundesland=wien",
            "- nutzungen@bw1=wohnen,buero",
            "- project_name=Haus Wien",
            "",
            "unknown:",
            "- bgf_oberirdisch@bw1",
            "",
            "contested:",
            "- bundesland: wien | alternativ: tirol (a.pdf, S. 1)",
        ]
    )
    assert profile_names.normalize_prompt_view(view).splitlines() == [
        "PROJECT_CONTEXT v1",
        "",
        "confirmed:",
        "- federal_state=vienna",
        "- uses@bldg1=residential,office",
        "- project_name=Haus Wien",
        "",
        "unknown:",
        "- gfa_above_ground@bldg1",
        "",
        "contested:",
        "- federal_state: vienna | alternativ: tyrol (a.pdf, S. 1)",
    ]
    already_new = "confirmed:\n- federal_state=vienna\n- country=at"
    assert profile_names.normalize_prompt_view(already_new) == already_new
