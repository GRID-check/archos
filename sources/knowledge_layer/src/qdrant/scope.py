"""The one place a Qdrant read filter is built (ADR-0116).

Collections stopped being the boundary between scopes, so something else has
to be. :func:`scope_filter` is it: every read in the knowledge layer asks it
for its filter, and every filter it returns names the scopes the caller was
signed into. A filter without a scope cannot be built, so a new read path
inherits the boundary without knowing it exists, which is what ADR-0087 got
from separate collections.

The caller's own filter keeps the backend-neutral grammar the adapter has
always accepted::

    {"field": value}                              -> equality
    {"field": [v1, ...]}                          -> any of
    {"field": {"$eq"|"$ne": v}}                   -> (not) equal
    {"field": {"$in"|"$nin": [v1, ...]}}          -> (not) in
    {"$and": [node, ...]}  /  {"$or": [node, ...]} -> groups

``$ne`` and ``$nin`` keep a point that lacks the field, as
``test_page_chunk_exclusion.py`` pins: the base corpus's ``chunking $ne page``
must not drop chunks written before ``chunking`` existed. A field that is not
indexed raises, because strict mode would refuse it at the server anyway and
a refusal deep in a search reads as "nothing found".
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from qdrant_client import models

from aiq_agent.profile_names import legacy_profile_token

from .payload import coerce_field
from .schema import INDEXED_FIELDS
from .schema import LEGACY_CHUNKING
from .schema import LEGACY_FIELDS
from .schema import PROJECT_FACTS_FIELD
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELD

_OPERATORS = frozenset({"$eq", "$ne", "$in", "$nin"})


def _match(field: str, value: Any) -> models.FieldCondition:
    # A list is any of its values, whatever the field's type: coerced whole it
    # became the string "['a', 'b']" on a keyword field (the project facts'
    # lists) and matched nothing.
    if isinstance(value, (list, tuple, set)):
        return _match_any(field, value)
    coerced = coerce_field(field, value)
    if isinstance(coerced, list):
        return models.FieldCondition(key=field, match=models.MatchAny(any=coerced))
    return models.FieldCondition(key=field, match=models.MatchValue(value=coerced))


def _match_any(field: str, values: Any) -> models.FieldCondition:
    if not isinstance(values, (list, tuple, set)):
        raise ValueError(f"Filter on {field!r} expects a list, got {values!r}")
    coerced = [coerce_field(field, value) for value in values]
    flat: list[Any] = []
    for value in coerced:
        flat.extend(value if isinstance(value, list) else [value])
    unique = list(dict.fromkeys(value for value in flat if value is not None))
    return models.FieldCondition(key=field, match=models.MatchAny(any=unique))


def _legacy_value(field: str, value: Any) -> Any:
    """``value`` as a point written before the rename spells it (``clause`` -> ``punkt``, ``vienna`` -> ``wien``)."""
    if isinstance(value, (list, tuple, set)):
        return [_legacy_value(field, item) for item in value]
    if field == "chunking":
        return LEGACY_CHUNKING.get(value, value)
    if field.startswith(f"{PROJECT_FACTS_FIELD}.") and isinstance(value, str):
        return legacy_profile_token(field.removeprefix(f"{PROJECT_FACTS_FIELD}."), value)
    return value


def _legacy_condition(field: str, condition: Any) -> tuple[str, Any] | None:
    """``field: condition`` as a point not yet rewritten spells it, or None when it has no other spelling."""
    old_field = LEGACY_FIELDS.get(field, field)
    if isinstance(condition, dict) and len(condition) == 1:
        op, value = next(iter(condition.items()))
        old: Any = {op: _legacy_value(field, value)}
    else:
        old = _legacy_value(field, condition)
    if old_field == field and old == condition:
        return None
    return old_field, old


def _field(field: str, condition: Any) -> models.Filter:
    """One ``field: condition`` pair as a filter, matching a point under either spelling.

    A point written before the English rename (``schema.LEGACY_FIELDS``) keeps its German key
    and tokens until the operator rewrite, so a positive condition is "new spelling OR old
    spelling" and a negative one "neither". Remove with the legacy tables.
    """
    primary = _field_exact(field, condition)
    legacy = _legacy_condition(field, condition)
    if legacy is None:
        return primary
    old = _field_exact(*legacy)
    negative = isinstance(condition, dict) and next(iter(condition), None) in {"$ne", "$nin"}
    return models.Filter(must=[primary, old]) if negative else models.Filter(should=[primary, old])


def _field_exact(field: str, condition: Any) -> models.Filter:
    """One ``field: condition`` pair as a filter, in exactly the spelling given."""
    if field not in INDEXED_FIELDS or field == TEXT_FIELD:
        raise ValueError(f"Filter on {field!r}: not an indexed payload field")
    if not isinstance(condition, dict):
        return models.Filter(must=[_match(field, condition)])
    if len(condition) != 1 or next(iter(condition)) not in _OPERATORS:
        raise ValueError(f"Unsupported metadata filter condition for field {field!r}: {condition!r}")
    op, value = next(iter(condition.items()))
    if op == "$eq":
        return models.Filter(must=[_match(field, value)])
    if op == "$ne":
        return models.Filter(must_not=[_match(field, value)])
    if op == "$in":
        return models.Filter(must=[_match_any(field, value)])
    # $nin of nothing excludes nothing.
    return models.Filter(must_not=[_match_any(field, value)] if value else [])


def translate(node: dict[str, Any]) -> models.Filter:
    """A backend-neutral filter node as a Qdrant filter; unknown shapes raise."""
    if not node:
        raise ValueError("Unsupported metadata filter: empty group")
    parts: list[models.Filter] = []
    for key, condition in node.items():
        if key in {"$and", "$or"}:
            if not isinstance(condition, list) or not condition:
                raise ValueError(f"Unsupported metadata filter operator: {key!r} (expects a non-empty list)")
            children = [translate(child) for child in condition]
            parts.append(models.Filter(must=children) if key == "$and" else models.Filter(should=children))
        elif key.startswith("$"):
            raise ValueError(f"Unsupported metadata filter operator: {key!r}")
        else:
            parts.append(_field(key, condition))
    return parts[0] if len(parts) == 1 else models.Filter(must=parts)


def scope_condition(scopes: Sequence[str]) -> models.FieldCondition:
    """The condition admitting exactly ``scopes``; an empty or blank scope raises."""
    names = [scope for scope in scopes if isinstance(scope, str) and scope.strip()]
    if not names or len(names) != len(scopes):
        raise ValueError(f"A Qdrant read needs at least one non-empty scope, got {list(scopes)!r}")
    return models.FieldCondition(key=SCOPE_FIELD, match=models.MatchAny(any=list(dict.fromkeys(names))))


def scope_filter(
    scopes: Sequence[str],
    filters: dict[str, Any] | None = None,
    *extra: models.Condition,
) -> models.Filter:
    """The filter for a read over ``scopes``: the scope, the caller's filter, and any extra conditions."""
    must: list[Any] = [scope_condition(scopes)]
    if filters:
        must.append(translate(filters))
    must.extend(extra)
    return models.Filter(must=must)
