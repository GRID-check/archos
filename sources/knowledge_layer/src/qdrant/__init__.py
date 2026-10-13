"""The Qdrant vector store (ADR-0104): the only package that imports ``qdrant_client``.

``config`` says which store a process reads and writes; ``schema`` owns the
physical collections; ``scope`` builds every read filter (ADR-0105); ``store``
holds the client and the writes; ``search`` runs the ranked reads.
"""
