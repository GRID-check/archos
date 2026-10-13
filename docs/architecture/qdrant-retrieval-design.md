# Retrieval on Qdrant, from first principles

Status: **accepted 2026-10-13; slice 1 built, behind `AIQ_VECTOR_BACKEND`
(default `chroma`).** The two decisions it rests on are
[ADR-0104](../adr/0104-qdrant-replaces-chroma-reached-through-qdrant-client.md)
(the store and the client) and
[ADR-0105](../adr/0105-retrieval-scope-is-a-payload-filter-compiled-in-one-place.md)
(scope as a filter, not a collection). What is built, and where it departs
from the target below, is §12. The gates in §10 are what the flag flip to
`qdrant` waits on in each environment.

This is not a port. A port would copy today's collection-per-scope layout into
Qdrant and keep every workaround that layout made necessary. Instead, this doc
asks what retrieval has to do for an office, sorts each existing mechanism into
domain need or Chroma workaround, and designs the Qdrant version the way
Qdrant's own guidance recommends.

## 1. What retrieval has to do

Piloti answers from three bodies of text: the legal corpus (`baurecht`), the
office's own filing (`buero`, the Büroablage) and its projects (`projekt`).
Retrieval serves these questions, ordered from most to least frequent:

| Question an architect asks | Retrieval shape |
|---|---|
| "Was sagt die OIB-RL 2 zu Fluchtwegen?" | Hybrid semantic + lexical over the corpus, reranked, a few hits per Richtlinie |
| "Was steht in unserem Brandschutzkonzept zu Stiege 2?" | The same, over one project's documents, never another office's |
| "§ 3 Abs. 2", "OIB-RL 2 Punkt 5.1.1" | Exact-term lookup where the string is the signal |
| "Lies Punkt 5.1.1 ganz" | Fetch by structure (Richtlinie, Punkt, page): no ranking, no embedding |
| "Wie haben wir das beim letzten GK4-Holzbau gelöst?" | Office-wide, ranked across projects, filtered by project facts, one result per project |
| "Welche unserer Projekte hatten eine Auflage zur Fluchttreppe?" | The same, plus counts per project |
| "Welche Dokumente gibt es zu …" / list a folder | Listing and facets, no vector at all |

Everything must hold three invariants that Chroma never enforced. The code
enforced them, through collection names:

1. **Office isolation.** A search never returns another office's chunk.
2. **Restricted folders.** A chunk in a restricted folder reaches only people
   cleared for it (ADR-0087). Who counts as cleared is decided by the
   conversation's audience (ADR-0094).
3. **Fassung truth.** A document that a person marked as superseded drops out
   of answers unless someone asks for it (ADR-0099).

## 2. What we have today, sorted

These are the full findings of the 2026-10-13 audit, condensed. Paths are
relative to `sources/knowledge_layer/src/` unless they are absolute.

**Domain needs we keep**, whatever store sits underneath:
- the signed scope envelope (ADR-0047/0084)
- the audience rules (ADR-0094)
- the durable fair ingest queue (ADR-0076/0079)
- OIB hash gating plus `CHUNK_FORMAT_VERSION`
- the query-embedding cache and warm-up, since embedding costs 280–980 ms and
  the store only 50–230 ms (`turn-latency-measured-2026-09.md`)
- the cross-encoder rerank, the requery loop, the coverage judge, and the
  EN→DE glossary expansion
- `keyed_lock` plus retire-after-insert for concurrent re-ingest
- the orphan sweep (multi-store deletes are not atomic)

**Workarounds for Chroma or LlamaIndex-over-Chroma**, which go away:

| Mechanism | Where | Why it exists |
|---|---|---|
| `$contains` exact-term channel, priced by a `collection.get` per term | `llamaindex/hybrid.py`, `adapter.py:6291` | Chroma has no lexical index |
| Postgres `chunk_text` mirror for German FTS, with hits fetched back from Chroma by id | `src/aiq_agent/knowledge/chunk_text_store.py` | Same |
| Cosine recovered from `exp(-d)` | `adapter.py:998, 6393` | LlamaIndex's Chroma score scale |
| RRF *across collections*, rank padding | `register.py:616-850` | N collections give N incomparable score bands |
| 3× over-fetch, then post-filter on `doc_class`, title, folder | `register.py:48, 1132-1173, 2049` | Human-set metadata lives only in Postgres and cannot reach the store |
| `file_name $in/$nin` lists for folders and superseded Fassungen | `register.py:2100, 2115` | Chunks carry no folder or document id |
| `read_passage` embeds a dummy label query to fetch by filter | `read_passage.py:1036` | No fetch-by-filter path was used |
| File listing by scanning all metadatas, page size 5000 | `adapter.py` `_get_all_metadatas` | Chroma doubled as the file registry |
| `_bound_chroma_http` private reach-in | `adapter.py:296` | The chromadb client sets no timeout (2026-10-12 outage) |
| Single-replica StatefulSet | `deploy/pulumi/src/data/chroma.ts` | Open-source Chroma is single node |

**Accidents inherited from the NVIDIA template**, which go away:
- random LlamaIndex node ids, read back after insert
- metadata rendered into the embedded text, with an exclusion list to undo it
  (`adapter.py:778`)
- the 24 h prefix-based TTL reaper on `s_` collections
- no office, document or folder id on any chunk: identity is
  `(collection, file_name)` (`src/aiq_agent/knowledge/schema.py:166`,
  ADR-0087 l. 40)

**One consequence that is a design choice rather than an accident:** moving a
document across a restriction boundary purges and re-embeds it, because the
restriction *is* the collection (ADR-0087). Qdrant makes it a payload update
(§5).

## 3. Target shape

```mermaid
flowchart LR
  subgraph BFF["BFF (Next.js)"]
    AUD[audience + scope<br/>ADR-0094]
    ENV[signed envelope<br/>office, projects, folders]
  end
  subgraph PY["Knowledge layer (Python)"]
    SC[scope compiler<br/>envelope → Filter]
    QP[query pipelines<br/>search · exact · read · cross-project · list]
    ING[ingest worker]
    RR[rerank · requery · judge]
  end
  subgraph Q["Qdrant cluster (3 nodes)"]
    C1[(corpus_chunks<br/>global HNSW, RF 3)]
    C2[(office_chunks<br/>office_id is_tenant, RF 2)]
    C3[(office_documents<br/>one point per Fassung)]
  end
  PG[(Postgres<br/>document_metadata · projects<br/>authority for mutable facts)]
  AUD --> ENV --> SC --> QP
  QP --> C1 & C2 & C3
  QP --> RR
  ING --> C2 & C3
  PG -- set_payload on change --> C2 & C3
```

There are three collections, one per data shape. Clients reach each one only
through an alias (`corpus`, `office`, `documents`), so a rebuild is an atomic
alias switch.

| Collection | Holds | Why separate |
|---|---|---|
| `corpus_chunks_v1` | The legal corpus per country profile (`oib_knowledge` today) | No tenant. Every office reads it, so it gets a global HNSW, 1 shard and RF 3, and every node serves it locally |
| `office_chunks_v1` | Every chunk an office owns: Büroablage, projects, restricted folders, conversation uploads | One tenant-partitioned index, which is Qdrant's recommended multitenant layout. `office_id` is indexed `is_tenant`, so each office's data sits together on disk |
| `office_documents_v1` | One point per document Fassung: a summary vector plus document metadata | Document-level search, `with_lookup` joins for grouped results, "similar documents", facets |

What does *not* move: project memory, platform lessons and permit records keep
their `real[]` vectors in `grid_app`. They are small, transactional and
RLS-bound ([`semantic-notes.md`](semantic-notes.md)). The trigger to revisit is
any of them passing about 50k rows per office, or needing to be fused with
document hits in one ranking.

## 4. Points, vectors, payload

### Point identity

`point_id = UUIDv5(NAMESPACE, f"{document_version_id}:{chunk_ordinal}")`. It
is deterministic: re-ingesting a Fassung overwrites its own points and cannot
duplicate them, so no id needs reading back after insert. Retiring a Fassung is
one delete by `document_version_id`.

### Named vectors

| Name | Kind | Source | Storage |
|---|---|---|---|
| `dense` | 3072-d cosine | `openai/text-embedding-3-large`, unchanged from today | Quantized copy (TurboQuant 4-bit, or int8 if the spike says so) in RAM, originals on disk, rescoring on |
| `lexical` | sparse, `modifier: idf` | Server-side `qdrant/bm25`, `language: german`, built from `text` at upsert | Sparse index pinned in RAM |

The embedded text is built explicitly: chunk body plus a short header
(Richtlinie/Punkt title or document title). LlamaIndex no longer renders the
metadata dict into it, and the exclusion list goes away.

**Dimension.** OpenAI documents that the v3 embeddings can be shortened by
truncation plus L2 renormalisation, which is equivalent to the API's
`dimensions` parameter. A 1024-d vector can therefore be *derived from the
stored 3072-d one* with no API call. The spike measures recall at both
dimensions (gate G6). If 1024 holds, it becomes a second named vector filled
from the stored vectors, and `dense` is dropped afterwards (add and delete named
vectors, Qdrant 1.18).

### Payload

The payload is flat and typed. Chunk text is a top-level field. There is no
`_node_content` blob, which would duplicate the text and hide it from the
full-text index.

| Field | Type, index | Meaning |
|---|---|---|
| `office_id` | uuid, `is_tenant` | Owning office (`office_chunks`, `office_documents`) |
| `shelf` | keyword | `buero` / `projekt` / `session`; `baurecht` lives in `corpus` |
| `project_id` | uuid | Project, when shelf is `projekt` |
| `conversation_id` | uuid | Conversation, when shelf is `session` |
| `folder_id`, `folder_ancestors[]` | uuid | Folder and every ancestor, so "this folder and below" is one match |
| `restriction_id` | uuid, or absent | The restricted folder that governs access (ADR-0087). Absent means open |
| `document_id`, `document_version_id` | uuid | The document and its Fassung |
| `superseded` | bool | Mirror of `document_metadata.superseded_by` (ADR-0099) |
| `doc_class` | keyword | Dokumentart, as a person set it or ingestion suggested it |
| `tags[]`, `topics[]`, `disciplines[]` | keyword | Mirror of person-set tags (12 document types, 6 OIB disciplines) |
| `project_status` | keyword | `active` / `paused` / `closed` (ADR-0098) |
| `project_facts.*` | keyword / integer | Fingerprint: `bundesland`, `gebaeudeklasse`, `bauweise`, `nutzungen[]`, `vorhabensart` |
| `content_type`, `chunking` | keyword | text / table / image / drawing; punkt / section / page |
| `evidence` | bool | Replaces `chunking != page` and the YAML change-log list |
| `page`, `page_end`, `section_order` | integer | Locators; `section_order` is `is_principal` for ordered reads |
| `reading_order` | integer | The page a chunk starts on, 0 when it has none; derived at write time, what a structural fetch orders by (§6) |
| `richtlinie`, `punkt_id`, `punkt_path`, `punkt_depth` | keyword / integer | Corpus structure (corpus only) |
| `country`, `edition` | keyword | Corpus profile and OIB edition |
| `file_name`, `title` | keyword, `text` | Display, plus the title-contains filter |
| `text` | `text` index (`word` tokenizer, lowercased, `ascii_folding`, `phrase_matching`; no stemmer, so a phrase is the literal words) | Chunk body. Feeds phrase and exact queries. `word` keeps digits: `multilingual` drops them, and "5.1.1" or "43" matched nothing (§12) |
| `paragraph_refs[]` | keyword | Every `§ n` the text cites (`§ 3`, `§ 12.1`, `§ 3a`), derived at write time. No tokenizer keeps the `§`, so "§ 3" as a phrase is the token `3` and matches "Abs. 3" |
| `stand` | datetime, `is_principal` on documents | Document date, for recency |

Payload indexes are created *before* the first upsert (Qdrant builds the
filterable HNSW links at index time). **Strict mode** is on with
`unindexed_filtering_retrieve: false`, so a filter on an unindexed field fails
loudly instead of scanning.

### Mutable facts: Postgres stays the authority

`doc_class`, tags, topics, `superseded`, folder placement, restriction, and
project status and facts are all edited by people in Postgres. They are
**mirrored** onto points by filter, never re-embedded:
`set_payload(filter: document_id = X, payload: {...})`, or
`filter: project_id = P` for project facts.

- The write happens in the same request that changes the Postgres row, after
  the commit.
- The mirror carries a `meta_version`, and conditional updates (1.16) refuse to
  apply an older version over a newer one.
- The existing weekly reconcile (`frontends/ui/src/lib/platform/vector-reconcile.ts`)
  grows a payload check: it samples points per document, compares them with
  Postgres and repairs drift.

This removes the 3× over-fetch and the `$in`/`$nin` file lists. Each filter
becomes a pre-filter inside the vector search. The post-filters in
`register.py` stay as a backstop over hits that already match, because a
mirror can lag: a pre-filter may only narrow what the Postgres post-filter
allows, never widen it. A stale fact can therefore cost recall but cannot
show something wrong. The superseded exclusion is the one case where a stale
fact *would* show something wrong (a replaced Fassung back in the ranking), so
the Postgres list still drops those hits after retrieval.

## 5. Access: one scope compiler

Collection names stop being the security boundary, so something else has to be
one. That job goes to a single function:

```python
def compile_scope(envelope: SignedScope, *, purpose: Purpose) -> models.Filter
```

- **The input is the verified envelope only:** office id, reachable project
  ids, cleared restriction ids, conversation id, and shelves. This is the same
  envelope as today, carrying ids instead of collection names.
- **Every filter it returns carries `office_id`.** No code path can omit it.
- **Restricted folders become a filter:**
  `should: [restriction_id is_empty, restriction_id in cleared]`. A tool cannot
  forget the rule because it never writes the filter itself, which is what
  ADR-0087 wanted from separate collections.
- **Superseded Fassungen are excluded unless `purpose` asks for history.**

The ratchet, in descending order of strength:

1. Only `knowledge_layer/qdrant/` imports `qdrant_client`. An import-linter
   contract fails the build for any other importer.
2. The read API pods hold the **read-only API key**. Only ingest workers hold
   the write key.
3. A property test generates random envelopes over a seeded multi-office
   collection and asserts that no result ever has a foreign `office_id` or an
   uncleared `restriction_id` (gate G3).
4. Strict mode rejects unindexed filters.

JWT payload claims can no longer enforce this: Qdrant deprecated the payload
constraint in 1.15. Enforcement therefore stays in our code, which matches
ADR-0055 (one API and one typed client).

**Moving a document across a restriction boundary** becomes one `set_payload`
on `restriction_id`. The purge-and-re-embed placement job (ADR-0087) and its
lag window go away.

## 6. Query pipelines

Every pipeline is a single Query API call, and every one starts from
`compile_scope`. These are sketches; the spike tunes `limit`, weights and `k`.

**`knowledge_search` (hybrid).**

```text
prefetch:
  - query: <dense query vector>, using: dense, limit: 60, filter: scope
  - query: Document(text, model: qdrant/bm25, options: {language: german}),
    using: lexical, limit: 60, filter: scope
    params: { idf: { corpus: { office_id: O } } }   # per-office IDF, 1.19
query: { rrf: { k: 60, weights: [1, 1] } }           # weights tuned on the eval set
then (nested): formula boost
  $score + 0.05 * (doc_class in boosted) + gauss_decay(stand) for recency questions
group_by: document_id, group_size: 3, limit: 16       # replaces the soft per-file cap
```

- The corpus and office collections are queried in one `query_batch`. Their
  hits are fused in the application by RRF, because they are two indexes. The
  cross-encoder then reranks the fused pool, as today.
- Qdrant documents RRF's `k` default as 2, not the canonical 60, so it is
  always set explicitly.
- Fusion inside a prefetch is computed per shard, so fusion stays at the top
  level.

**Exact mode.** It runs as `filter: text phrase "…"` (or `text_any`) with no
vector, ordered by `section_order`. Qdrant has no regex. `match="exact"`
today uses `$regex` (`adapter.py:6006`), and the spike checks whether phrase
matching with `ascii_folding` covers its real queries (gate G1b). If it does
not, exact mode keeps reading the Postgres mirror, and the mirror stays for
that one job.

**`read_passage` and the family overview.** `scroll(filter: file_name = F and
the Punkt, page or outline clause, order_by: reading_order)`. No embedding and
no ranking. Built: `BaseRetriever.fetch`, `qdrant/reads.py`.

The order exists for the cut only. The reader sorts what it gets by page, then
Punkt number, then section, line and part, so no single integer can carry its
order, and none needs to: `reading_order` is the leading term of that sort
(the start page, as `Chunk.page_number or 0` reads it), and a cut in it that
never splits a tie keeps exactly the chunks the reader's own sort would have
kept from the whole set. The fetch reads the first N by `reading_order` and
then the rest of the last one's tie group. A point written before the field
existed has no value and `order_by` would skip it, so a set holding one (or a
collection without the index) is ordered client-side from `page_label`, which
the field is derived from. `ensure_collection` adds the missing index on the
next write; the backfill rewrites the payloads.

**Listing and facets.** `facet(key: doc_class | project_id | tags, filter:
scope)` returns the counts. The file list itself stays a Postgres read, because
Postgres is the registry.

**Similar documents.** `query(recommend: positive [document point], using:
summary, lookup_from: documents)` over `office_documents`.

## 7. Cross-project search

### Today

ADR-0094 search is a BFF loop (`frontends/ui/src/lib/cross-project/service.ts`):
- It takes up to 8 projects in hand-weighted fingerprint-similarity order and
  searches them in waves of 4.
- Each project costs one HTTP search per collection, plus one file-listing call
  for tags.
- The merged hits are sorted by **raw score**, although the knowledge layer's
  own merge states that scores are not comparable across collections
  (`register.py:703-722`).

The consequences:

| Limitation | Caused by |
|---|---|
| "Which projects had X" means paging `offset` 8 projects at a time; there is no office-wide top-k | Collection per project |
| Cost grows linearly in projects; "sign every project into scope" was rejected for that reason (ADR-0094 l. 288) | Collection per project |
| Raw-score merge across collections | Collection per project |
| Tag and project-fact filters run after retrieval, with 3× over-fetch | Tags and facts are not on chunks |
| Cleared restricted folders in shared chats are queried, then discarded | Restriction is a collection |
| Folder ACL change means re-ingest with a lag | Restriction is a collection |
| No counts ("6 von 8 Projekten in NÖ") | No shared index to facet |
| Projects past the 500 newest are invisible | `PROJECT_LIST_LIMIT` in the BFF, not the store |
| `gebaeudeklasse` is mostly empty, so similarity is starved | Data quality, not the store |

### On Qdrant

One query over `office_chunks`:

```text
filter: compile_scope(envelope, purpose=cross_project)
        # office_id = O, project_id in reach (or project_status = closed for wide chats),
        # restriction_id empty or cleared, superseded = false
        + optional: project_facts.bauweise = holz, doc_class = detail
prefetch: dense + lexical (as §6), rrf
formula:  $score + 0.10 * (project_facts.gebaeudeklasse = current.gk)
                 + 0.05 * (project_facts.bundesland = current.bl)
group_by: project_id, group_size: 3, limit: 20
with_lookup: documents                       # title, Fassung, date per hit
```

What this enables:

1. **Office-wide ranking in one call.** "Wie haben wir das gelöst?" ranks every
   reachable project by relevance. The 8-project page, the waves and offset
   paging go away, and so does the cost argument against wide reach.
2. **Comparable scores.** There is one index and one query, so the raw-score
   merge problem disappears rather than being worked around. The cross-encoder
   reranks the grouped top hits across projects, which today's path never does.
3. **Similarity as a relevance boost, not a walk order.** The fingerprint
   weights become formula terms on relevance. Today they decide which 8 projects
   get searched at all. The weights are still hand-set, but a wrong weight now
   nudges a ranking instead of hiding a project.
4. **Real filters.** "Alle Dachdetails von Holzbauten in NÖ" is a pre-filter
   (`doc_class`, `project_facts.bauweise`, `project_facts.bundesland`) inside
   the vector search. The retriage document asks for exactly this
   (`docs/audit/upload-and-filing-retriage-2026-10-06.md` l. 228).
5. **Counts.** `facet(project_id)` and `facet(project_facts.bundesland)` on the
   same filter give "6 von 8 Projekten in Mödling" without fetching passages.
6. **A cheap catalog.** The `<referenzprojekte>` list (ADR-0094 l. 134) can be
   ranked by a `recommend` over project-level vectors (the mean of a project's
   document summaries in `office_documents`). Today it uses the fingerprint
   alone.
7. **Restrictions without waste.** Uncleared restricted chunks are filtered
   out before scoring instead of fetched and discarded. A folder moved into or
   out of restriction is effective at the next query.

What stays as it is:
- the audience rules
- recording at hand-out and the 409 on an audience change
- the Jev hit judge

These are policy. They decide what goes into the envelope, and Qdrant only
executes it. Two things need product decisions this design does not take:

- Whether `read_passage` may open another project's document (today it cannot,
  `tools/cross_project/register.py:27-31`). Points carry `document_id` and the
  compiler can authorize per hit, so it becomes technically possible.
- Lifting the 500-project listing cap. For wide chats the envelope can say
  `project_status = closed` instead of listing ids, so the cap stops mattering
  there.

## 8. Client layer

`qdrant-client` (async, gRPC) is used directly inside `knowledge_layer/qdrant/`.
LlamaIndex stays for loaders, parsing and chunking only:

- `llama-index-vector-stores-qdrant` 0.10.4 issues dense and sparse as two
  requests and fuses them client-side (`relative_score_fusion`).
- It uses no `prefetch`, server-side fusion, formula, `group_by`, MMR or server
  BM25.
- It stores the node as a `_node_content` JSON string, so the text cannot carry
  a full-text index.
- Our adapter already bypasses its Chroma sibling about 40 times.

The `BaseRetriever` / `BaseIngestor` seam (ADR-0072) stays. The backend behind
it changes, which is the path ADR-0072 itself named for this case.

## 9. Deployment

| Setting | Value | Reason |
|---|---|---|
| Version | 1.19.x, upgraded minor by minor | Self-hosted cannot skip minors. Snapshots restore only into the same or next minor |
| Nodes | 3, one per data node, anti-affinity | 2 nodes cannot keep Raft quorum through one failure |
| Pulumi | Own StatefulSet in `deploy/pulumi/src/data/qdrant.ts`, modelled on `chroma.ts` | Data stores here are raw StatefulSets. `qdrant-helm` 1.19.2 serves as the oracle, diffed on each minor upgrade |
| Pod management | `Parallel` | OrderedReady can deadlock cluster bootstrap |
| Probes | readiness `/readyz`, liveness `/livez`, never liveness on `/readyz` | `/readyz` fails during Raft catch-up, and as liveness it cascades restarts |
| Grace period | 120 s; memory request = limit | WAL flush; OOM during optimization is the top reported failure |
| `office_chunks` | 6 shards, RF 2, `write_consistency_factor` 1 | OSS cannot reshard, so 6 fits 1/2/3/6 nodes. Consistency 1 keeps writes going while one peer is down (a rollout, a drain); at 2, writes to about 4 of the 6 shards failed then. The lagging replica catches up from the WAL when its peer returns, so a write is durable on both only after that; Chroma and the backfill are the net behind the window while Chroma is still written. Transient write failures are retried in the store (3 retries, 0.2/0.8/2 s), never a 4xx |
| `corpus_chunks` | 1 shard, RF 3 | Small and read by every query |
| Size, start | 4 vCPU / 16 GB per node, data PVC on the Lightbits class at 2× data | Today's whole store fits in a 20Gi PVC and 3–6 Gi RAM |
| Security | API key plus read-only key from Secrets, `enforce_internal_auth`, p2p TLS via cert-manager, NetworkPolicy on 6333/6334/6335 | Open-source Qdrant is open by default |
| Backups | CronJob: a snapshot of every shard of every collection to a SeaweedFS bucket (`snapshots_config` s3, `endpoint_url`); aliases recorded separately | No cluster-wide snapshot exists, and aliases are not in snapshots |
| Metrics | OTel collector Prometheus receiver, scraping each pod's `/metrics` | No Prometheus runs today. `/metrics` reports only the peer it is called on |
| Growth | Add a node, then `replicate_shard` / `move_shard`. A shape change means a new collection, a scroll-and-upsert copy of stored vectors, and an alias switch | No resharding or auto-rebalancing in OSS |
| Large office | Tiered multitenancy (1.16) promotes one office to its own shard. It requires custom sharding chosen at collection creation | Decided in the spike from the largest office's point count (Q4) |

New environment variables (`AIQ_QDRANT_URL`, `AIQ_QDRANT_API_KEY`,
`AIQ_QDRANT_READ_ONLY_KEY`) get their rows in
[`environment-variables.md`](../deployment/environment-variables.md) in the
change that adds them.

**Observability (ADR-0089).** Every pipeline call is a Langfuse span
`retrieve.<pipeline>` carrying, as metadata:
- the collection alias
- the prefetch limits
- the fusion and its weights
- the filter *fields* used (never values)
- the server-reported `time`, and hit and group counts

Isolation-test failures and strict-mode rejections are scores.

## 10. Spike: gates before anything is built

The spike runs on a copy of production data, which takes no re-embedding (§11).
Each gate is a number with the place it is measured.

| Gate | Pass when | Measured by |
|---|---|---|
| G1 answer quality | No regression on the answer suite; per-expectation diff reviewed | `task be:eval:answer-suite`, Chroma vs Qdrant |
| G1b lexical | Qdrant German BM25 recall ≥ Postgres `german` FTS on the lexical query set, including `§`, `5.1.1`, ALLCAPS codes and compounds; exact mode served by phrase match | `task be:eval:retrieval` lexical channel, extended with these queries |
| G2 latency | p95 store time per `knowledge_search` ≤ today's 230 ms with one Query API call | Langfuse `retrieve.knowledge_search` |
| G3 isolation | 50k random envelopes, zero foreign `office_id` or uncleared `restriction_id`; strict mode rejects an unindexed filter | New property test in the knowledge-layer suite |
| G4 operations | SeaweedFS snapshot upload and restore works; killing a pod mid-ingest at RF 2 loses no acknowledged write; node-replacement drill timed and written as a runbook | Spike runbook |
| G5 memory | A full backfill and optimization run stays under the memory limit without OOM | Pod metrics during backfill |
| G6 dimension | Recall at 1024-d derived from the stored 3072-d vectors is within 1 point of 3072-d | `be:eval:retrieval` dense channel on the production embedder |

Open questions the spike answers:

- **Q1.** Does `is_tenant` with `m: 0, payload_m: 16` keep project-filtered
  latency within G2, or does it need ACORN?
- **Q2.** Are chunk ids persisted anywhere outside the store (citations,
  `already_read`, Langfuse scores)? If yes, keep `legacy_chunk_id` on points for
  one release.
- **Q3.** Can Qdrant BM25 retire the Postgres `chunk_text` mirror entirely, or
  does exact mode keep it?
- **Q4.** How many points does the largest office hold, and is that enough to
  justify custom sharding now?

## 11. Migration: copy, don't re-index

Chroma holds the ids, the 3072-d embeddings, the chunk text and the metadata.
The backfill pages through each collection, as
`scripts/backfill_chunk_text.py` already does, and inserts what Qdrant lacks
(insert-only, so a point ingestion wrote keeps its ids; §12). Each
record is enriched with what the collection name only implied, read from
`grid_app`:

- collection → `office_id`, `project_id`, `folder_id`, `restriction_id`,
  `conversation_id`
- `file_name` → `document_id`, `document_version_id`
- the current tags, `doc_class`, `superseded`, and project status and facts

It makes no re-parse, no VLM call and no embedding call. The lexical sparse
vector is computed by Qdrant from `text` at upsert.

Rollout, each step behind a flag:

1. **Infrastructure.** StatefulSet, secrets, snapshots, metrics.
2. **Write path.** The scope compiler, the client, and ingest dual-writing
   Chroma and Qdrant.
3. **Backfill** of existing data, with counts per old collection and sampled
   text and metadata compared.
4. **Read switch** per pipeline: shadow-compare first, then the answer suite
   before and after, then cut over.
5. **Removal:** Chroma, the `$contains` channel, the mirror (if Q3 says so), the
   post-filters, the TTL reaper, `_bound_chroma_http`, `exp(-d)` recovery and
   the placement re-ingest. Chroma stays read-only for one week before deletion.

The cross-project BFF loop is rewritten on the new `cross_project` pipeline in
step 4. Its API to the agent tool (`project_lookup`) does not change.

## 12. Build status

### Built in slice 1

| Part | Where |
|---|---|
| The store: two collections behind aliases, dense + German BM25, TurboQuant, strict mode, payload indexes created before data | `sources/knowledge_layer/src/qdrant/schema.py`, `store.py` |
| Every read filter from one function, refusing an empty scope | `qdrant/scope.py` |
| Hybrid search in one Query API call (dense, BM25 with per-scope IDF, exact-term phrase channels, RRF k=60) and the true cosine per hit | `qdrant/search.py` — `hybrid_search` |
| Retrieval, exact search (`find_text`) and the health check reading Qdrant under `AIQ_VECTOR_BACKEND=qdrant`; the chunk contract unchanged | `llamaindex/adapter.py` — `_qdrant_chunks`, `_find_text_sync`, `health_check` |
| Every Chroma write mirrored (insert, retire, discard, delete file, delete collection), vectors copied, never re-embedded | `qdrant/mirror.py`, wired beside each Postgres text-mirror call in the adapter |
| Person-set facts (tags, topics, Dokumentart, Fassung, folder) mirrored onto points when they change | `aiq_agent/knowledge/factory.py` — `_mirror_facts` |
| Backfill with `--prune`, `--verify`, `--facts-only`, `--dry-run` | `qdrant/backfill.py`, `scripts/backfill_qdrant.py` |
| Cross-project search: a page of up to 40 projects in ONE grouped query, ordered by the fused ranking; Chroma falls back to the 8-project loop | `POST /v1/collections/search`; BFF `cross-project/service.ts` — `searchPageAtOnce` |
| Infrastructure: 3-peer StatefulSet, Raft bootstrap, API and read-only keys, snapshots to SeaweedFS with retention, NetworkPolicies, the policy-pack allowance for `Parallel`; Compose service behind `--profile qdrant` | `deploy/pulumi/src/data/qdrant.ts`, `deploy/compose/docker-compose.yaml` |
| Trace metadata: `vector_backend` on every `retrieve.knowledge_search` span | `register.py` |
| `knowledge_search` pre-filters under `qdrant`: `doc_class = X` (the stored class over the chunk's guess, as `_hit_doc_class` resolves), `superseded != true` on user shelves unless `file_name=` names a file, `folder` as one match on `folder_ancestors` (case-folded paths, `/`-bounded). No 3× over-fetch and no `file_name $in/$nin` lists for them. The Postgres post-filters stay as a backstop, and the Postgres superseded list still drops hits a lagging mirror let through. The span carries `prefiltered: [fields]` | `qdrant/prefilter.py`; `register.py` — `search` |
| Payload indexes added to an existing collection on first read or write (`ensure_payload_indexes`), so a new indexed field needs no rebuild | `qdrant/schema.py`, `store.py` — `exists`, `ensure` |
| Structural reads by filter: `read_passage` (Punkt, page, outline, the whole-document fallback) and the family overview scroll by filter, ordered by `reading_order`, with no embedding and no ranking; Chroma keeps the embedded probe. `family_read` (`fetch` or `retrieve`) on the `retrieve.knowledge_search` span | `BaseRetriever.fetch`, `qdrant/reads.py`, `read_passage._structural_fetch` |

### Hardened after review (2026-10-13)

An adversarial review of slice 1 found these, each fixed with a test that fails
without the fix. No environment had created a Qdrant collection yet, so the
index changes went in place.

| Defect | What changed | Where |
|---|---|---|
| The `text` index used the `multilingual` tokenizer, which drops digits: phrase counts for "5.1.1", "43", "§ 3" were 0, "Abs. 2" ignored its number, and `selective_terms` dropped every numeric exact term the Chroma `$contains` channel served | `word` tokenizer (`schema.TEXT_INDEX`), verified on 1.19.2: "5.1.1", "43", "OIB-Richtlinie 2", "Abs. 2" match exactly, and "Größe", "GRÖSSE", "grosse" stay one token. `§` references go through the `paragraph_refs` keyword field (`search.exact_term`), since every tokenizer drops the `§`. `ensure_payload_indexes` logs an ERROR when an existing text index was built otherwise, naming the rebuild path (new `_vN`, copy, alias switch) | `qdrant/schema.py`, `search.py`, `payload.paragraph_refs` |
| Under `qdrant`, a delete took Chroma first; a Qdrant failure then left deleted, retired or quarantined (ADR-0086) chunks answering every search, and its raise skipped the Chroma-side cleanup | `mirror.ordered_delete`: under `qdrant`, Qdrant first, and a failure deletes nothing anywhere (the caller's retry starts over); under `dual`, Chroma first and the mirror best effort; the metadata row, the lexical mirror and the version bump always run after it. A retried `delete_file` that finds no Chroma chunks deletes Qdrant's by every stored spelling (`tmp…_`, percent-encoded) the adapter's own rule accepts | `adapter.py` (`delete_file`, `_retire_previous_version`, `_retire_held_predecessor`, `_discard_partial_version`, `delete_collection`), `mirror.py` |
| `write_consistency_factor` equalled RF, so one peer down failed writes to most shards | Consistency 1, and transient write failures retried in the store (§9) | `schema.WRITE_CONSISTENCY_FACTOR`, `store.with_retry` |
| The backfill pruned a file ingested between its two reads, stripped `office_id`/`project_id`/`grid_document_id` from points ingestion wrote, never visited a scope Chroma had dropped, and `--verify` compared counts only | Prune reads Qdrant's ids before Chroma's; the copy is insert-only (Qdrant 1.17 `update_mode`) and merges only the chunk's own fields onto existing points, then merges the facts; scopes are enumerated from Qdrant too (facet on `scope`) and `--prune` deletes those Chroma lacks; `--verify` compares the id sets (whole up to 200k chunks, sampled both ways above) | `qdrant/backfill.py`, `scripts/backfill_qdrant.py` |
| A writer dying between `create_collection` and the alias wedged every later writer on the conflict, and the loser of a create race raised | A conflict finishes the collection: indexes added, alias made if missing; two writers finishing it at once agree | `schema._create_or_adopt` |
| `find_text` scrolled the whole scope (20k chunks: about 79 requests, 29 MB) | Narrowed on the server by the words every match of the pattern must hold as whole tokens; the regex still decides. A pattern without such a word (one word over three characters, which matches inside longer words) reads the whole scope as before | `retrieval.literal_tokens`, `find_text` |
| `coerce_field("superseded", "false")` was True; a one-file fact refresh loaded every document of the scope; a folder rename sent one request per file; a cleared Dokumentart stayed on the points | String booleans read for what they say; `get_documents(collection, names)` reads only the named rows; payload updates go in batches of 128, a folder move copies only the folder of the moved files; clearing a stored class puts back the chunk's own (`chunk_doc_class`, written at ingest), which is also what a hit's metadata now carries, as on Chroma | `payload.py`, `mirror.refresh_facts`, `store.set_file_payloads`, `DocumentMetadataStore.get_many` |
| Raw `filters` a model may pass (`punkt_path`, `page_end`, `table_index`, `section_part`, `drawing_type`, …) raised under `qdrant` | Every metadata key the chunkers write and a filter can plausibly name is indexed, with its stored type; large fields (`drawing_data`, `description`) stay unindexed and still raise, naming the field | `schema.KEYWORD_FIELDS`, `INTEGER_FIELDS` |
| `health_check` under `qdrant` ignored Chroma, which is still the write record and serves the registry reads | Healthy only when both answer | `adapter.py` `health_check` |

### Where slice 1 departs from the target, and why

* **Scopes are still logical collection names.** `scope` is the old
  collection name (`proj_…`, `<proj>_r…`, `s_…`), so the BFF contract, the
  signed envelope and restricted-folder placement (ADR-0087) are unchanged.
  `office_id`, `project_id` and `grid_document_id` are on every point written
  through ingestion, but the backfill only knows the ones a collection name
  carries (the Büroablage's office). Moving the envelope to ids, and
  restriction to a `restriction_id` field, is slice 2.
* **Chroma stays the write-side record.** Its ids decide version retirement
  and partial-attempt cleanup, so Qdrant mirrors it and point ids are the
  Chroma chunk ids (which also keeps citations and `already_read` digests
  valid). Deterministic `UUIDv5(document_version_id, ordinal)` ids arrive with
  the slice that removes Chroma.
* **Registry reads stay on Chroma.** File listings, text samples, visual
  details and page reads still read Chroma, which still holds everything.
  None of them is on a chat turn's path: the text sample feeds the
  post-ingest summary backstop, the visual details a document route, and
  `collection_pages.read_pages` the project-close and permit backfills. None
  embeds anything either.
* **Some filters still run after retrieval.**
  * `title_contains` stays a post-filter with the 3× over-fetch. It is a
    case-insensitive substring of the file name or display title, and
    Qdrant's full-text index matches tokens (`schutz` is in
    `Brandschutzkonzept` but is not one of its tokens), so a token pre-filter
    would drop documents the substring rule keeps.
  * `file_name=` also stays a post-filter with the over-fetch, because either
    name may contain the other.
  * The tag and project-fact filters of cross-project search still run in the
    BFF; `knowledge_search` has no tag parameter.
  * `match="exact"` keeps its file lists.
* **`folder_ancestors` holds paths, not folder ids.** The envelope still
  speaks paths (ADR-0049), so the field holds case-folded paths. Qdrant
  1.19's keyword `prefix` match was the alternative. It is case-sensitive and
  crosses the `/` boundary (`Brandschutz` matches `Brandschutzkonzepte`), so
  it would need a folded copy of the path and two conditions. Points written
  before the field existed carry no ancestors, and a folder search misses them
  until `scripts/backfill_qdrant.py --facts-only` has run.
* **A cleared Dokumentart is mirrored only on points that kept the chunk's
  own.** Points carry `chunk_doc_class`, the class ingestion stamped on the
  chunk, and clearing the stored class puts it back (or removes the field
  when there was none). A point written before that field existed keeps the
  old class until it is re-ingested or re-copied; a `doc_class=` search can
  miss it meanwhile, and the post-filter keeps a wrong class from being shown.
* **A write is acknowledged by one replica.** The other holds it once Qdrant
  has re-synced it; a peer lost for good inside that window loses the write
  in Qdrant, and Chroma plus `backfill_qdrant.py` restore it while Chroma is
  still written. After the slice that removes Chroma this needs another net
  (write consistency 2 with a retried queue, or snapshots).
* **A Qdrant delete that succeeds before a Chroma delete fails** leaves the
  chunk in Chroma and not in Qdrant: invisible to search, as the caller
  asked, and the caller's retry finishes it. A backfill run before that
  retry copies the chunk back from Chroma.
* **A located passage scores 1.00.** On Chroma its `Relevance Score:` is the
  cosine to the probe label, which measured nothing; a structural fetch has no
  query, so every chunk it returns matches, as `find_text`'s do.
* **One API key.** The read-only key is configured on the server and not yet
  used by the backend (ADR-0105, Confirmation).
* **The Postgres `chunk_text` mirror stays** until gate G1b shows Qdrant's
  BM25 and phrase matching cover it; the Chroma path still reads it.

### Next

1. Each environment: `qdrantEnabled`, `vectorBackend=dual`, deploy, run
   `scripts/backfill_qdrant.py --prune --verify` until every collection is in
   step, run the gates in §10, then `vectorBackend=qdrant`.
2. Slice 2: ids in the envelope, `restriction_id`, folder ids in
   `folder_ancestors`, project facts on points for cross-project filters and
   boosts, and the cross-project tag filter moved into the query.
3. Slice 3: ingestion writes Qdrant only, deterministic ids, registry reads
   from Postgres and Qdrant, Chroma, the `$contains` channel and the text
   mirror removed.
