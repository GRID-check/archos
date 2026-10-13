---
status: proposed
date: 2026-10-13
decision-makers:
consulted:
informed:
---

# Retrieval scope is a payload filter compiled in one place, not a collection

## Context and Problem Statement

Today a collection is the unit of scope and the only security boundary for
vectors:
- `archiv_<orgId>`
- `proj_<uuid>`
- `<proj>_r<folder>` for a restricted folder (ADR-0087)
- `s_<conversation>`, TTL-reaped after 24 h
- `oib_knowledge`

No chunk carries an office, project, folder or document id; identity is
`(collection, file_name)`. Three costs follow from that:

1. **Cost grows with collections.** Cross-project search is one HTTP search per
   project collection, 8 projects per page in waves of 4, merged by raw scores
   that are not comparable across collections (ADR-0094; `register.py:703-722`).
2. **Placement is access control.** Moving a document into or out of a
   restricted folder purges and re-embeds it, with a lag window (ADR-0087).
3. **Mutable facts never reach the index.** `doc_class`, tags, Fassung status,
   folder and project facts live in Postgres, so every filter on them is a
   post-filter over a 3× over-fetch.

Qdrant's guidance is the opposite layout: a few collections by data shape, with
the tenant as an indexed payload field (`is_tenant`). Its docs say
collection-per-tenant "is rarely the most efficient approach". Dust hit the
wall at about 1000 collections and consolidated.

## Decision Drivers

* Office isolation and restricted folders must hold by construction: a new tool
  must inherit them without knowing they exist (the reason ADR-0087 chose
  collections).
* One ranking across an office's projects.
* Human edits (tags, Fassung, folder, restriction) take effect without
  re-embedding.

## Considered Options

* A few collections by data shape. Scope is payload, compiled from the signed
  envelope by one function.
* One Qdrant collection per scope, mirroring today.
* A few collections, with each tool building its own filter.

## Decision Outcome

Chosen option: "A few collections, scope compiled by one function".

- Three collections: `corpus_chunks`, `office_chunks`, `office_documents`.
- Every point carries `office_id` (indexed `is_tenant`), `project_id`,
  `folder_ancestors[]`, `restriction_id`, `document_id`, `document_version_id`
  and the mirrored mutable facts.
- `compile_scope(envelope, purpose) -> Filter` is the only producer of query
  filters, and every filter it returns carries `office_id`.
- Postgres stays the authority for mutable facts. They are mirrored onto points
  with `set_payload` by `document_id` or `project_id`, with a version guard.

### Consequences

* Good, because cross-project search becomes one query ranked across the whole
  office, with `group_by project_id`, facet counts and project-fact pre-filters
  (design doc §7).
* Good, because a folder restriction or move is a payload update, effective at
  the next query. The placement re-ingest goes away.
* Good, because post-filters and over-fetch go away; the collection count stays
  at three for ever. The TTL reaper becomes a delete-by-filter.
* Bad, because isolation now rests on code, not on separate indexes. A bug in
  `compile_scope`, or a client that bypasses it, leaks across offices. The
  confirmation below exists for that.
* Bad, because the mirrored facts can drift from Postgres. They need a version
  guard and the reconcile sweep.
* Neutral, because the signed envelope keeps its shape but carries ids instead
  of collection names. The BFF and Python contract fixture
  (`tests/fixtures/collection_scope/scope_header.json`) changes once.

### Confirmation

* An import-linter contract: only `knowledge_layer/qdrant/` imports
  `qdrant_client`, and only `compile_scope` builds a `models.Filter` for a read.
* A property test: 50k random envelopes over a seeded multi-office collection,
  zero results with a foreign `office_id` or an uncleared `restriction_id`.
* Strict mode with `unindexed_filtering_retrieve: false`, so a filter on an
  unindexed field fails instead of scanning.
* Read API pods hold the read-only key; only ingest workers can write.

## Pros and Cons of the Options

### One collection per scope

* Good, because isolation is physical.
* Bad, because every cost above stays, and each collection carries its own
  shards, segments and HNSW graph. That puts tens of thousands of conversation
  collections at 10k users.

### Shared collections, each tool builds its filter

* Bad, because it is the deny-list ADR-0087 rejected: about ten read paths
  would each have to remember the restriction rule.

## More Information

* Design: [`qdrant-retrieval-design.md`](../architecture/qdrant-retrieval-design.md)
  §§3–7.
* Store decision: [ADR-0103](0103-qdrant-replaces-chroma-reached-through-qdrant-client.md).
* On acceptance this amends ADR-0006 (scopes stay logical; collections stop
  being per scope) and ADR-0087 (a restricted folder is a `restriction_id`, not
  a collection). The audience rules of ADR-0094 are unchanged; only their
  execution moves.
* Revisit if one office outgrows a shared shard (about 20k points is Qdrant's
  promotion threshold). Tiered multitenancy then gives it a dedicated shard
  without changing this decision, provided the collection was created with
  custom sharding.
