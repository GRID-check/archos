---
status: accepted
date: 2026-10-13
decision-makers:
consulted:
informed:
---

# Qdrant replaces Chroma as the vector store, reached through qdrant-client

## Context and Problem Statement

Every chunk lives in one Chroma server (`chromadb/chroma:1.5.9`, one replica,
a 20Gi PVC, `deploy/pulumi/src/data/chroma.ts`). Open-source Chroma is single
node, so that pod is a retrieval and ingest outage whenever it moves. On
2026-10-12 one dead Chroma pod drained the API's thread pool, because the
chromadb client sets no HTTP timeout (`docs/contributing/gotchas.md`).

Chroma also has no lexical index, no fetch-by-filter we use, no cheap metadata
update and no auth. About a third of the knowledge layer exists to compensate
for that:
- the `$contains` channel
- the Postgres German FTS mirror
- `exp(-d)` score recovery
- the 3× over-fetch with post-filters
- an embedded dummy query in `read_passage`

The full inventory is in
[`qdrant-retrieval-design.md`](../architecture/qdrant-retrieval-design.md) §2.

ADR-0072 named this case: "Revisit if Piloti needs a vector store that ChromaDB
cannot serve … a new adapter behind the same seam and an ADR superseding this
one."

## Decision Drivers

* Self-hosted on Kubernetes, open source only.
* Horizontal scale and replica failover for ≤10k users across many offices.
* Hybrid dense and German lexical search, filtering and grouping done
  server-side, not reassembled in Python.
* Few moving parts: a small team runs this.
* Migration without re-parsing, re-captioning or re-embedding.

## Considered Options

* Qdrant, reached through `qdrant-client` directly.
* Qdrant, reached through `llama-index-vector-stores-qdrant`.
* Milvus.
* Keep Chroma (do nothing).

## Decision Outcome

Chosen option: "Qdrant, reached through `qdrant-client` directly". It is an
Apache-2.0 single binary that replicates over Raft. Its Query API does the
hybrid, fusion, boosting and grouping work we currently do by hand, including
German BM25 server-side in the open-source build. The direct client is the only
way to reach those features (the LlamaIndex store uses none of them).

### Consequences

* Good, because:
  * Replicas survive a node loss; retrieval stops depending on one pod.
  * Hybrid search, RRF, score boosting and `group_by` run in one server call.
    The `$contains` channel, `exp(-d)` recovery and per-collection fan-out are
    deleted.
  * The migration copies the stored vectors and text; nothing is re-embedded.
  * `qdrant-client` has native timeouts; the private reach-in goes away.
* Neutral, because LlamaIndex stays for loaders and chunking, and the
  `BaseRetriever`/`BaseIngestor` seam stays.
* Bad, because open-source Qdrant has no resharding, auto-rebalancing or
  automatic re-replication. Shard counts are fixed at creation, and node changes
  are manual API calls we must script and drill.
* Bad, because Qdrant must be upgraded minor by minor. Falling behind means
  stepping through every minor.
* Bad, because we write and own a StatefulSet, snapshot CronJob and metrics
  scrape. The commercial operator is the alternative we decline.
* Bad, because the adapter's roughly 40 direct chromadb calls are rewritten,
  not swapped.

### Confirmation

Before acceptance: the spike gates G1–G6 in the design doc §10 pass, with the
answer-suite reports attached to the PR.

After acceptance:
* `sources/knowledge_layer/tests/test_qdrant_import_boundary.py` allows
  `qdrant_client` only under `knowledge_layer/qdrant/`. Extending it to forbid
  `chromadb` everywhere is part of step 5 of the rollout, which removes Chroma.
* The Qdrant tests run against `qdrant/qdrant:v1.19.2` as a CI service
  container and fail, rather than skip, when it is missing on CI.
* `task be:eval:answer-suite` runs before and after every retrieval change, as
  AGENTS.md already requires.

## Pros and Cons of the Options

### Qdrant through `llama-index-vector-stores-qdrant`

* Good, because it is the smallest code change.
* Bad, because 0.10.4 sends dense and sparse as two requests and fuses them
  client-side. It uses no prefetch, server-side fusion, formula, `group_by`,
  MMR or server BM25, and it hides chunk text inside a `_node_content` string
  that no full-text index can read. We would pay for Qdrant and use it like
  Chroma.

### Milvus

* Good, because it scales elastically with an open-source operator, and its
  BM25 full-text engine is stronger than Qdrant's sparse-vector BM25.
* Bad, because it brings coordinators, query, data and streaming nodes plus
  etcd and object storage: a system built for billions of vectors, run by a team
  that needs millions. It has no official Chroma migration path.

### Keep Chroma

* Bad, because it stays single node, and every workaround in the design doc §2
  stays with it.

## More Information

* The design this decision serves:
  [`qdrant-retrieval-design.md`](../architecture/qdrant-retrieval-design.md).
* Companion decision: [ADR-0104](0104-retrieval-scope-is-a-payload-filter-compiled-in-one-place.md)
  (scope as a payload filter).
* On acceptance this supersedes
  [ADR-0072](0072-the-knowledge-layer-has-one-backend-llamaindex.md). The seam
  survives; "one backend: LlamaIndex over Chroma" does not.
* Revisit if the point count passes about 500M, or if write throughput outgrows
  a manually balanced 6-shard layout. Milvus's elastic scaling is the answer to
  that problem, which we do not have.
