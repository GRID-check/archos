"""The German spellings the research plan carried before the English names.

One table per vocabulary, read-only. The plan travels as text (the
``plan_json`` fence in a stored message), as edits the plan card sends back
(``approve {...}``), and as a checkpointed ``PlanResponse``; a browser tab, a
pod or a checkpoint from before the rename still holds the old spellings.
Nothing writes these: every reader maps them to the English name on the way in.
"""

from __future__ import annotations

from typing import Any

#: ``genre`` values, and the ``answer_type`` values that shared them.
LEGACY_PLAN_GENRE: dict[str, str] = {
    "pruefbericht": "inspection_report",
    "aktenvermerk": "file_note",
    "vergleich": "comparison",
    "checkliste": "checklist",
    "bericht": "report",
}

#: ``depth`` values.
LEGACY_PLAN_DEPTH: dict[str, str] = {
    "kurzpruefung": "quick_check",
    "gutachten": "expert_report",
}

#: Keys of the plan object (and of the ``plan_json`` fence).
LEGACY_PLAN_KEYS: dict[str, str] = {
    "grundlage": "basis",
    "ausgeschlossen": "excluded",
    "unterlagen": "documents",
}


def modernize_plan(raw: Any) -> Any:
    """A plan object with the English keys and values, whichever spelling it came in.

    Anything that is not a mapping is returned untouched. A key present in both
    spellings keeps the English one.
    """
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    for old, new in LEGACY_PLAN_KEYS.items():
        if old in out:
            value = out.pop(old)
            out.setdefault(new, value)
    genre = out.get("genre")
    if isinstance(genre, str):
        out["genre"] = LEGACY_PLAN_GENRE.get(genre, genre)
    depth = out.get("depth")
    if isinstance(depth, str):
        out["depth"] = LEGACY_PLAN_DEPTH.get(depth, depth)
    return out
