"""The measurement harness for the Qdrant migration gates (design doc §10, G1b, G2, G6).

``task be:eval:qdrant-parity`` runs it. It indexes the SAME OIB corpus with the SAME
vectors into both stores and measures them through the production code paths:

* the Chroma path is ``LlamaIndexRetriever._retrieve_sync`` under
  ``AIQ_VECTOR_BACKEND=chroma`` (dense through LlamaIndex, the ``$contains`` passes,
  the Postgres German mirror, the Python RRF);
* the Qdrant path is the same method under ``AIQ_VECTOR_BACKEND=qdrant``
  (``qdrant/search.py`` ``hybrid_search``: one Query API call), over points copied
  out of that Chroma collection by ``qdrant/backfill.py``, the migration's own copy.

``runner`` is the CLI. The modules below it are split so the parts a test can pin
without a server (metrics, gates, oracles, truncation, the report) stay pure.
"""
