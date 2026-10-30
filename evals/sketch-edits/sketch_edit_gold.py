"""The gold answers (the checker must pass these) and the negatives (it must catch these), by task."""

from __future__ import annotations

from sketch_edit_lib import with_intents
from sketch_edit_tasks import BLUE  # noqa: F401
from sketch_edit_tasks import GREEN  # noqa: F401
from sketch_edit_tasks import ORANGE  # noqa: F401
from sketch_edit_tasks import VIOLET  # noqa: F401
from sketch_edit_tasks import YELLOW  # noqa: F401
from sketch_edit_tasks import C  # noqa: F401
from sketch_edit_tasks import S  # noqa: F401
from sketch_edit_tasks import T  # noqa: F401

# ---------------------------------------------------------------- gold answers (the checker must pass these)

GOLD: dict[str, dict] = {
    "reorder-circulation": {
        "ops": [
            {"op": "update", "id": "eingang", "set": {"x": 0, "y": 160}},
            {"op": "update", "id": "garderobe", "set": {"x": 220, "y": 160}},
            {"op": "update", "id": "flur", "set": {"x": 440, "y": 160}},
            {"op": "update", "id": "gruppe1", "set": {"x": 660, "y": 20}},
            {"op": "update", "id": "gruppe2", "set": {"x": 660, "y": 160}},
            {"op": "update", "id": "wc", "set": {"x": 660, "y": 300}},
        ]
    },
    "add-escape-route": {
        "ops": [
            {
                "op": "add",
                "element": {
                    "type": "arrow",
                    "id": "fw1",
                    "x": 80,
                    "y": 80,
                    "points": [[0, 0], [0, 80]],
                    "start": {"id": "b1"},
                    "end": {"id": "flur"},
                    "strokeStyle": "dashed",
                    "label": {"text": "Fluchtweg"},
                },
            },
            {
                "op": "add",
                "element": {
                    "type": "arrow",
                    "id": "fw2",
                    "x": 600,
                    "y": 220,
                    "points": [[0, 0], [80, 0]],
                    "start": {"id": "flur"},
                    "end": {"id": "th"},
                    "strokeStyle": "dashed",
                },
            },
        ]
    },
    "frames-per-storey": {
        "ops": [
            {"op": "update", "id": "schlafen", "set": {"x": 0, "y": 200}},
            {"op": "update", "id": "kueche", "set": {"x": 220, "y": 0}},
            {"op": "update", "id": "bad", "set": {"x": 440, "y": 200}},
            {"op": "update", "id": "kind", "set": {"x": 220, "y": 200}},
            {
                "op": "add",
                "element": {"type": "frame", "id": "f_eg", "name": "EG", "children": ["diele", "kueche", "wohnen"]},
            },
            {
                "op": "add",
                "element": {"type": "frame", "id": "f_og", "name": "OG", "children": ["schlafen", "kind", "bad"]},
            },
        ]
    },
    "street-and-access": {
        "ops": [
            {
                "op": "add",
                "element": {"type": "text", "id": "street", "x": 220, "y": 440, "text": "Lindenstraße", "fontSize": 20},
            },
            {
                "op": "add",
                "element": {
                    "type": "arrow",
                    "id": "access",
                    "x": 310,
                    "y": 410,
                    "points": [[0, 0], [0, -150]],
                    "end": {"id": "haus"},
                    "label": {"text": "Zufahrt"},
                },
            },
        ]
    },
    "list-to-bubbles": {
        "ops": [
            {"op": "add", "element": S("wohnen", 0, 0, "Wohnen", bg=GREEN)},
            {"op": "add", "element": S("essen", 240, 0, "Essen", bg=GREEN)},
            {"op": "add", "element": S("kochen", 480, 0, "Kochen", bg=GREEN)},
            {"op": "add", "element": S("arbeiten", 0, 200, "Arbeiten", bg=YELLOW)},
            {"op": "add", "element": S("schlafen", 240, 200, "Schlafen", bg=BLUE)},
            {"op": "add", "element": S("bad", 480, 200, "Bad", bg=BLUE)},
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "j1",
                    "x": 160,
                    "y": 40,
                    "points": [[0, 0], [80, 0]],
                    "start": {"id": "wohnen"},
                    "end": {"id": "essen"},
                },
            },
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "j2",
                    "x": 400,
                    "y": 40,
                    "points": [[0, 0], [80, 0]],
                    "start": {"id": "essen"},
                    "end": {"id": "kochen"},
                },
            },
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "j3",
                    "x": 400,
                    "y": 240,
                    "points": [[0, 0], [80, 0]],
                    "start": {"id": "schlafen"},
                    "end": {"id": "bad"},
                },
            },
        ]
    },
    "variant-b-beside-a": {
        "ops": [
            {"op": "add", "element": S("b_eingang", 300, 0, "Eingang", type="rectangle", bg=GREEN)},
            {"op": "add", "element": S("b_essen", 300, 120, "Essen", type="rectangle", bg=GREEN)},
            {"op": "add", "element": S("b_kueche", 300, 240, "Küche", type="rectangle", bg=GREEN)},
            {"op": "add", "element": S("b_wohnen", 300, 360, "Wohnen", type="rectangle", bg=GREEN)},
            {
                "op": "add",
                "element": {
                    "type": "frame",
                    "id": "var_b",
                    "name": "Variante B (empfohlen)",
                    "children": ["b_eingang", "b_essen", "b_kueche", "b_wohnen"],
                },
            },
        ]
    },
    "mark-revision-changes": {
        "ops": [
            {"op": "update", "id": "abst", "set": {"strokeStyle": "dashed", "label": {"text": "Abstellraum (neu)"}}},
            {"op": "update", "id": "gwc", "set": {"strokeStyle": "dashed", "label": {"text": "Gäste-WC (entfällt)"}}},
        ]
    },
    "remove-duplicates": {
        "ops": [
            {"op": "remove", "id": "c3"},
            {"op": "remove", "id": "beh1b"},
            {"op": "remove", "id": "warten2"},
            {"op": "remove", "id": "title2"},
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "c3n",
                    "x": 160,
                    "y": 200,
                    "points": [[0, 0], [80, 0]],
                    "start": {"id": "beh1"},
                    "end": {"id": "labor"},
                },
            },
        ]
    },
    "dimension-trap": {
        "ops": [],
        "note": "Eine Skizze ist nicht maßstäblich und trägt keine Flächen; "
        "die Flächen gehören mit Quelle in eine Tabelle.",
    },
    "insert-between": {
        "ops": [
            {"op": "update", "id": "garage", "set": {"x": 440}},
            {"op": "remove", "id": "k1"},
            {"op": "remove", "id": "k3"},
            {"op": "add", "element": S("hwr", 220, 0, "Hauswirtschaft", w=180, bg=ORANGE)},
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "h1",
                    "x": 160,
                    "y": 40,
                    "points": [[0, 0], [60, 0]],
                    "start": {"id": "kueche"},
                    "end": {"id": "hwr"},
                },
            },
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "h2",
                    "x": 400,
                    "y": 40,
                    "points": [[0, 0], [40, 0]],
                    "start": {"id": "hwr"},
                    "end": {"id": "garage"},
                },
            },
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "k3n",
                    "x": 200,
                    "y": 220,
                    "points": [[0, 0], [320, -140]],
                    "start": {"id": "eingang"},
                    "end": {"id": "garage"},
                },
            },
        ]
    },
    "recolour-and-rename": {
        "ops": [
            {"op": "update", "id": "schlafen", "set": {"backgroundColor": BLUE}},
            {"op": "update", "id": "kind", "set": {"backgroundColor": BLUE, "label": {"text": "Kinderzimmer"}}},
            {"op": "update", "id": "bad", "set": {"backgroundColor": BLUE}},
        ]
    },
    "callout-note": {
        "ops": [
            {"op": "add", "element": T(-240, 200, "Südlage,\nAbendsonne", 16, id="note")},
            {
                "op": "add",
                "element": {
                    "type": "arrow",
                    "id": "na",
                    "x": -120,
                    "y": 220,
                    "points": [[0, 0], [120, 0]],
                    "end": {"id": "terrasse"},
                },
            },
        ]
    },
    "rewire-connection": {
        "ops": [
            {"op": "remove", "id": "r2"},
            {
                "op": "add",
                "element": {
                    "type": "line",
                    "id": "r2n",
                    "x": 380,
                    "y": 140,
                    "points": [[0, 0], [70, -70]],
                    "start": {"id": "flur"},
                    "end": {"id": "schlafen"},
                },
            },
        ]
    },
}

#: Bad answers the checker must fail, with the gate that must catch them.
NEGATIVES: list[tuple[str, dict, str]] = [
    (
        "dimension-trap",
        {"ops": [{"op": "update", "id": "wohnen", "set": {"label": {"text": "Wohnen 32 m²"}}}], "note": "ok"},
        "no_dimension_labels",
    ),
    (
        "callout-note",
        {
            "ops": [
                {"op": "add", "element": T(20, 200, "Südlage", 16, id="note")},
                {
                    "op": "add",
                    "element": {
                        "type": "arrow",
                        "id": "na",
                        "x": 0,
                        "y": 0,
                        "points": [[0, 0], [10, 10]],
                        "end": {"id": "terrasse"},
                    },
                },
            ]
        },
        "no_new_overlaps",
    ),
    (
        "add-escape-route",
        {
            "ops": [
                {
                    "op": "add",
                    "element": {
                        "type": "arrow",
                        "id": "fw",
                        "x": 80,
                        "y": 80,
                        "points": [[0, 0], [0, 80]],
                        "start": {"id": "buero1"},
                        "end": {"id": "flur"},
                    },
                }
            ]
        },
        "fence_valid",
    ),
    # Removal takes the bound line along (the shipped cascade): the Behandlung–Labor connection is lost.
    ("remove-duplicates", {"ops": [{"op": "remove", "id": "beh1b"}]}, "connections_kept"),
    # An added arrow 900 px from its shape is no longer a failure to catch: the server routes every bound arrow.
    ("recolour-and-rename", {"ops": [{"op": "update", "id": "kind", "set": {"fontFamily": 3}}]}, "ops_valid"),
    (
        "frames-per-storey",
        {
            "ops": [
                {
                    "op": "add",
                    "element": {"type": "frame", "id": "f_eg", "name": "EG", "children": ["diele", "kueche", "wohnen"]},
                },
                {
                    "op": "add",
                    "element": {"type": "frame", "id": "f_og", "name": "OG", "children": ["schlafen", "kind", "bad"]},
                },
            ]
        },
        "frames_disjoint",
    ),
]

# The answers above predate the intent every op now carries; give them one, then add the shipped rules' own.
NEGATIVES = [(task, with_intents(answer), gate) for task, answer, gate in NEGATIVES] + [
    ("recolour-and-rename", {"ops": [{"op": "update", "id": "kind", "set": {"backgroundColor": BLUE}}]}, "ops_valid"),
    (
        "rewire-connection",
        {"ops": [{"op": "rebind", "intent": "Schlafen vom Flur", "id": "c_ws", "start": "nirgends"}]},
        "ops_valid",
    ),
]
GOLD = {task: with_intents(answer) for task, answer in GOLD.items()}
