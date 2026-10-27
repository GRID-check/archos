"""Query embeddings, computed once per (model, text) and shared by every caller that asks meanwhile.

The knowledge tool fans one query out across every collection in scope, and the
turn-start warm-up (``warm_query``) races the turn's own search for the same
question; without this each of them paid the remote embedding round trip again.
"""

import threading
from collections.abc import Callable

from .env import env_int

# @environment_variable AIQ_QUERY_EMBED_CACHE_SIZE
# @category Knowledge Layer
# @type int
# @default 512
# @required false
# Maximum cached query embeddings per retriever (LRU).
EMBED_CACHE_MAX = env_int("AIQ_QUERY_EMBED_CACHE_SIZE", 512, minimum=0)


class _InflightEmbedding:
    """One query embedding being computed, and what it came to.

    Every caller that finds it waits on ``done`` and then reads the outcome
    here, never the LRU: a failure is re-raised to all of them at once, so a
    down embedding API fails every waiter after ONE bounded call instead of
    handing the key to the next waiter and serialising the failures, and a
    success reaches them even if the LRU evicted it in between.
    """

    __slots__ = ("done", "embedding", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.embedding: list[float] | None = None
        self.error: BaseException | None = None

    def result(self) -> list[float]:
        self.done.wait()
        if self.error is not None:
            raise self.error
        assert self.embedding is not None
        return self.embedding


class QueryEmbeddingCache:
    """An LRU of query vectors, keyed by (embed model, query), with one computation in flight per key.

    Keyed by the model too, so a model change never serves stale vectors.
    """

    def __init__(self, max_entries: int = EMBED_CACHE_MAX) -> None:
        self.max_entries = max_entries
        self._cache: dict[tuple[str, str], list[float]] = {}
        self._order: list[tuple[str, str]] = []
        self._lock = threading.Lock()
        self._inflight: dict[tuple[str, str], _InflightEmbedding] = {}

    def embed(self, key: tuple[str, str], compute: Callable[[], list[float]]) -> list[float]:
        """The vector for ``key``: cached, awaited from the caller computing it, or computed here.

        A caller that finds the key in flight shares that computation's
        outcome: its vector, or its exception re-raised. ``compute`` is bounded
        by the embed model's own timeout and retries, so the wait is.
        """
        # With the LRU off (``max_entries`` 0) the owner's entry is evicted as
        # it lands, but the in-flight record still carries the vector to every
        # waiter: parallel searches for one query embed it once.
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._order.remove(key)
                self._order.append(key)
                return cached
            pending = self._inflight.get(key)
            if pending is None:
                owned = self._inflight[key] = _InflightEmbedding()
        if pending is not None:
            return pending.result()
        return self._compute_as_owner(key, compute, owned)

    def seed(self, key: tuple[str, str], embedding: list[float]) -> None:
        """Hold ``embedding`` for ``key`` as if it had been computed, past the LRU bound (a harness's fixed queries)."""
        with self._lock:
            self._cache[key] = embedding
            self._order.append(key)

    def _compute_as_owner(
        self, key: tuple[str, str], compute: Callable[[], list[float]], record: _InflightEmbedding
    ) -> list[float]:
        """Compute the embedding ``record`` stands for, cache it, and release every waiter."""
        try:
            embedding = compute()
        except BaseException as exc:
            record.error = exc
            raise
        else:
            record.embedding = embedding
            with self._lock:
                self._cache[key] = embedding
                self._order.append(key)
                while len(self._order) > self.max_entries:
                    self._cache.pop(self._order.pop(0), None)
            return embedding
        finally:
            with self._lock:
                self._inflight.pop(key, None)
            record.done.set()
