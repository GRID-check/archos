"""Structural reads: the chunks a filter admits, with no query vector and no ranking.

``read_passage`` and the family overview already know WHICH chunks they want
(a document's Punkt, a page, its outline); on the store this replaced they
still had to embed a label as a query to get them back. Here they are a scroll by filter
(design doc §6, "read_passage and the family overview"), so nothing is
embedded and nothing is ranked.

Order matters only where a fetch is cut. The reader sorts what it gets by its
own document order, whose leading term is ``reading_order`` (the start page as
an integer). A cut in ``reading_order`` that never splits a tie therefore
keeps exactly the chunks the reader's finer sort would have kept from the
whole set. Qdrant orders by an indexed integer field server-side; a point
written before the field existed has no value, and ``order_by`` would skip it,
so a set holding such a point is ordered here instead, from the ``page_label``
the field is derived from.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from collections.abc import Sequence
from typing import Any

from qdrant_client import models

from aiq_agent.knowledge.base import reading_order

from .schema import CHUNK_ID_FIELD
from .schema import READING_ORDER_FIELD
from .schema import TEXT_FIELD
from .search import Hit
from .store import QdrantStore
from .store import get_store

logger = logging.getLogger(__name__)

#: How many chunks a fetch reads when it must read a whole set (or a whole tie
#: group) to order it. A guard, not a budget: one document's chunks, or one
#: page's, stay far below it.
WHOLE_SET_CAP = 4096


def fetch(scope: str, filters: dict[str, Any] | None, limit: int, order_by: str | None = None) -> list[Hit]:
    """The chunks of ``scope`` that ``filters`` admits, as unranked hits (cosine 1.0: each one matches).

    Without ``order_by``: at most ``limit``, in point-id order. With
    ``order_by=reading_order``: the first ``limit`` in that order plus every
    chunk tied with the last of them.
    """
    if order_by not in (None, READING_ORDER_FIELD):
        raise ValueError(f"A structural fetch orders by {READING_ORDER_FIELD!r} only, not {order_by!r}")
    store = get_store()
    if limit <= 0 or not store.exists(scope):
        return []
    if order_by is None:
        records = list(store.scroll(scope, filters, limit=limit))
    elif _orders_server_side(store, scope, filters):
        records = _ordered_by_server(store, scope, filters, limit)
    else:
        records = _ordered_here(store, scope, filters, limit)
    return [_hit(record) for record in records]


def _orders_server_side(store: QdrantStore, scope: str, filters: dict[str, Any] | None) -> bool:
    """Whether every admitted point carries an indexed ``reading_order``, so Qdrant can order them."""
    if not store.has_index(scope, READING_ORDER_FIELD):
        return False
    missing = models.IsEmptyCondition(is_empty=models.PayloadField(key=READING_ORDER_FIELD))
    return store.count(scope, filters, missing) == 0


def _ordered_by_server(store: QdrantStore, scope: str, filters: dict[str, Any] | None, limit: int) -> list[Any]:
    """The first ``limit`` points by ``reading_order``, then the rest of the last one's tie group."""
    page = store.scroll_ordered(scope, filters, READING_ORDER_FIELD, limit)
    if len(page) < limit:
        return page
    boundary = _stored_order(page[-1])
    tie = {READING_ORDER_FIELD: boundary}
    tied = list(store.scroll(scope, {"$and": [filters, tie]} if filters else tie, limit=WHOLE_SET_CAP))
    _warn_if_capped(tied, scope)
    return [record for record in page if _stored_order(record) < boundary] + tied


def _ordered_here(store: QdrantStore, scope: str, filters: dict[str, Any] | None, limit: int) -> list[Any]:
    """The same cut, ordered client-side: for a set holding points written before ``reading_order``."""
    records = list(store.scroll(scope, filters, limit=WHOLE_SET_CAP))
    _warn_if_capped(records, scope)
    records.sort(key=_derived_order)
    return _first_with_ties(records, limit, _derived_order)


def _first_with_ties(ordered: Sequence[Any], limit: int, key: Callable[[Any], int]) -> list[Any]:
    """The first ``limit`` of ``ordered`` (sorted by ``key``) and everything tied with the last of them."""
    if len(ordered) <= limit:
        return list(ordered)
    boundary = key(ordered[limit - 1])
    return [item for item in ordered if key(item) <= boundary]


def _stored_order(record: Any) -> int:
    return int((record.payload or {})[READING_ORDER_FIELD])


def _derived_order(record: Any) -> int:
    """``reading_order`` as the write path derives it, so old and new points sort alike."""
    return reading_order((record.payload or {}).get("page_label"))


def _warn_if_capped(records: Sequence[Any], scope: str) -> None:
    if len(records) >= WHOLE_SET_CAP:
        logger.warning(
            "Structural fetch in %s hit the %d-chunk cap; its order past the cap is not kept", scope, WHOLE_SET_CAP
        )


def _hit(record: Any) -> Hit:
    payload = dict(record.payload or {})
    return Hit(str(payload.get(CHUNK_ID_FIELD) or record.id), str(payload.get(TEXT_FIELD) or ""), payload, 0.0, 1.0)
