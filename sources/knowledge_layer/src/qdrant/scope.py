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
    {"field": {"$gt"|"$gte"|"$lt"|"$lte": v}}     -> range (integer and datetime fields only)
    {"$and": [node, ...]}  /  {"$or": [node, ...]} -> groups

A read is over chunks unless it says otherwise. A folder card's point
(``kind = folder``, ADR-0127) sits in its folder's scope beside the chunks, so
:func:`scope_filter` leaves it out of every read by default and admits it only
to a read that asks for ``kind="folder"``; a delete of a whole scope asks for
``kind="any"``. A chunk carries no ``kind`` at all, which the ``must_not``
keeps: nothing was backfilled.

``$ne`` and ``$nin`` keep a point that lacks the field, as
``test_page_chunk_exclusion.py`` pins: the base corpus's ``chunking $ne page``
must not drop chunks written before ``chunking`` existed. A field that is not
indexed raises, because strict mode would refuse it at the server anyway and
a refusal deep in a search reads as "nothing found". A range on a keyword or
boolean field raises for the same reason: Qdrant would refuse it, and a range
over strings is not what the caller meant. One range operator per condition;
a closed interval is ``{"$and": [{"f": {"$gte": a}}, {"f": {"$lte": b}}]}``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from typing import Literal

from qdrant_client import models

from aiq_agent.profile_names import legacy_profile_token

from .payload import coerce_field
from .schema import DATETIME_FIELDS
from .schema import FOLDER_KIND
from .schema import INDEXED_FIELDS
from .schema import INTEGER_FIELDS
from .schema import KIND_FIELD
from .schema import LEGACY_CHUNKING
from .schema import LEGACY_FIELDS
from .schema import PROJECT_FACTS_FIELD
from .schema import SCOPE_FIELD
from .schema import TEXT_FIELDS

#: Which points a read is over: chunks (every read's default), folder card points, or both
#: (only a write or a delete that names a whole scope).
PointKind = Literal["chunk", "folder", "any"]

_RANGE_OPERATORS = {"$gt": "gt", "$gte": "gte", "$lt": "lt", "$lte": "lte"}
_OPERATORS = frozenset({"$eq", "$ne", "$in", "$nin", *_RANGE_OPERATORS})


def _range(field: str, op: str, value: Any) -> models.FieldCondition:
    """``field`` compared by ``op`` to ``value``: an integer range, or a datetime range for a datetime field."""
    bound = _RANGE_OPERATORS[op]
    if field in DATETIME_FIELDS:
        moment = coerce_field(field, value)
        if moment is None:
            raise ValueError(f"Filter on {field!r}: {op} needs an ISO 8601 date, got {value!r}")
        return models.FieldCondition(key=field, range=models.DatetimeRange(**{bound: moment}))
    if field not in INTEGER_FIELDS:
        raise ValueError(f"Filter on {field!r}: {op} needs an integer or datetime field")
    number = coerce_field(field, value)
    if number is None:
        raise ValueError(f"Filter on {field!r}: {op} needs a number, got {value!r}")
    return models.FieldCondition(key=field, range=models.Range(**{bound: number}))


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
    if field not in INDEXED_FIELDS or field in TEXT_FIELDS:
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
    if op in _RANGE_OPERATORS:
        return models.Filter(must=[_range(field, op, value)])
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


def _is_folder() -> models.FieldCondition:
    return models.FieldCondition(key=KIND_FIELD, match=models.MatchValue(value=FOLDER_KIND))


def kind_filter(kind: PointKind = "chunk") -> models.Filter:
    """Only points of ``kind``, over a whole collection: for the one read that lists scopes, not one of them."""
    if kind == "chunk":
        return models.Filter(must_not=[_is_folder()])
    if kind == "folder":
        return models.Filter(must=[_is_folder()])
    return models.Filter()


def scope_filter(
    scopes: Sequence[str],
    filters: dict[str, Any] | None = None,
    *extra: models.Condition,
    kind: PointKind = "chunk",
) -> models.Filter:
    """The filter for a read over ``scopes``: the scope, the caller's filter, any extra conditions, and the kind.

    ``kind`` defaults to chunks: a folder card's point never reaches a chunk read,
    a count or a facet unless the caller asks for ``"folder"`` (or ``"any"``).
    """
    if kind not in ("chunk", "folder", "any"):
        raise ValueError(f"Unknown point kind {kind!r}")
    must: list[Any] = [scope_condition(scopes)]
    if filters:
        must.append(translate(filters))
    must.extend(extra)
    if kind == "folder":
        must.append(_is_folder())
    return models.Filter(must=must, must_not=[_is_folder()] if kind == "chunk" else None)
