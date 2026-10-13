# Qdrant migration gates, measured (2026-10-13)

The flag flip to `AIQ_VECTOR_BACKEND=qdrant` waits on the gates in
[`qdrant-retrieval-design.md` §10](qdrant-retrieval-design.md#10-spike-gates-before-anything-is-built).
This page records the first run of the instrument built for them,
`task be:eval:qdrant-parity`, what it found, the two defects it found and fixed
in the Qdrant path, and what is still not measured.

**Verdict for the flip:** G1b and G2 pass on this corpus. G6 does not pass at
its own 1-point bound, which keeps `dense` at 3072-d. One ranked-retrieval
regression stays open (`§` lookups, below) and has to be accepted or fixed
before the flip. G1 (the answer suite), G3, G4 and G5 are not measured here.

## What was measured, and how

Both paths read **one corpus with one set of vectors**:

- **Corpus.** The 39 OIB 2023 PDFs, downloaded from oib.or.at (both
  "Gesamtfassung" archives), cut by the production Punkt chunker into 2,534
  chunks. 1,330 of them pass production's base filter
  (`chunking != page`, `exclude_file_names`).
- **Vectors.** Every chunk embedded once with `openai/text-embedding-3-large`
  (3,072-d) through `make_embed_model` (OpenRouter, ZDR-pinned), as
  `MetadataMode.EMBED` text with ingestion's excluded keys. That was 2,534
  chunks plus 105 queries, about 0.93 M tokens (~$0.12). The vectors are cached
  under `frontends/benchmarks/oib_retrieval/.cache/qdrant_parity/`, so later
  runs embed nothing.
- **Chroma path.** The vectors went into embedded `chromadb` 1.5.9 through
  LlamaIndex's `ChromaVectorStore`. The chunk text was mirrored into
  `ChunkTextStore` on a throwaway PostgreSQL 16 cluster, which is the
  production German channel (`to_tsvector('german')`, `ts_rank_cd`). Reads go
  through `LlamaIndexRetriever._retrieve_sync` with
  `AIQ_VECTOR_BACKEND=chroma`: dense, the `$contains` passes, the Postgres
  mirror, then RRF in Python.
- **Qdrant path.** The same Chroma collection was copied by
  `qdrant/backfill.py` into the production collection shape (`schema.py`:
  dense plus server BM25 with `BM25_OPTIONS`, TurboQuant 4-bit, strict mode)
  on Qdrant 1.19.2. Reads go through the same `_retrieve_sync` with
  `AIQ_VECTOR_BACKEND=qdrant`, which makes one `hybrid_search` Query API call.
- **Labels.** The labels are the harness's own. The Punkt golden set has 46
  answerable questions, German and English, graded by `(file, page)`. The
  overview golden set has 30 questions in three cohorts, labelled by file. New
  in this change: 23 lexical hard cases
  (`fixtures/qdrant_lexical_hard_cases.json`), each a query plus a regex oracle
  over the chunk text. They cover `§` references, dotted Punkt numbers,
  ALLCAPS codes, compounds, and ß and umlaut spellings.
- **Depth.** Each path's retrieval was asked for 60 chunks
  (`rerank_candidates`, the pool the cross-encoder sees) with the production
  base filter.
- **Machine.** Intel Xeon @ 2.30 GHz, 4 CPUs, Python 3.14. Qdrant was a single
  local node in Docker over REST on localhost, Chroma embedded in-process, and
  Postgres local over TCP. Nothing crossed a network.

Raw results: `results.json` and `report.md` under `--out` (default
`frontends/benchmarks/oib_retrieval/results/qdrant_parity/`, gitignored).

## Results (final run, both fixes applied)

### G1b lexical: pass

German golden questions, units, base filter, lexical channel alone:

| channel | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| Postgres `german` FTS (production mirror) | 0.521 | 0.646 | 0.854 | 0.461 | 0.414 |
| SQLite fallback analyzer | 0.896 | 1.000 | 1.000 | 0.673 | 0.565 |
| **Qdrant BM25** (`language: german`, `ascii_folding`) | 0.979 | 0.979 | 0.979 | 0.842 | 0.802 |

The 21 gating hard cases (`compound_only` excluded), chunk oracle:

| channel | mean P@10 | mean R-precision | mean MRR |
|---|---|---|---|
| Postgres | 0.619 | 0.539 | 0.714 |
| Qdrant BM25 | 0.643 | 0.566 | 0.683 |

Per kind:

- **ALLCAPS codes.** Qdrant ≥ Postgres everywhere. `EI2 30-C` R-precision is
  0.96 against 0.52, and `A2-s1,d0` is 0.75 against 0.
- **Compounds and ß/umlaut.** Identical on both.
  - `Fussboden`, `Aussenwand`, `Strasse` and `Geschoss` find the ß spellings on
    both.
  - `Gebaeudeklasse` (the digraph spelling) finds nothing on either; it is the
    known gap of both German configs.
  - Neither channel splits closed compounds: `compound_only` recall is 0 on
    both, so a search for „Verfahren“ does not reach „Nachweisverfahren“. This
    is measured, and the gate does not count it.
- **Digit-only queries.** `§ 8`, `5.1.1` and `Punkt 4.2.1` get nothing from
  either lexical channel. Both now apply the same rule: with no selective
  alphabetic term left, the channel stays silent. Unpriced BM25 had served
  `5.1.1` (P@10 1.0); this is the price of the second fix below.

Exact mode passes. For all 33 phrases tried, Chroma `$regex` and Qdrant
`find_text` (scroll plus Python `re` over `browse.phrase_pattern`) return
**identical chunk sets**. Mismatches: 0.

Q3, whether the phrase index alone could serve exact mode: **no**. With the
fixed tokenizer it equals the regex on codes and numbers (`REI 90`,
`EI2 30-C`, `Punkt 4.2.1`, `Gebäudeklasse 5`, `mindestens 2,00 m`). It misses
everything the regex finds inside a word: `Geschoss` 88 of 255,
`barrierefrei` 26 of 165, `Gebaeudeklasse` 0 of 91. It over-matches `§ 8`
(234 against 9), because `§` is no token. So `find_text` keeps the regex over a
scroll, which is what slice 1 built. The Postgres mirror is not needed for
exact mode.

### Hybrid: the full per-collection retrieval (context for G1)

Punkt golden, units, depth 60:

| path | set | recall@10 | recall@16 | recall@60 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| Chroma | all (46) | 0.989 | 1.000 | 1.000 | 0.782 | 0.725 |
| Qdrant | all (46) | 0.978 | 0.989 | 1.000 | 0.848 | 0.810 |
| Chroma | de (24) | 1.000 | 1.000 | 1.000 | 0.801 | 0.751 |
| Qdrant | de (24) | 0.979 | 0.979 | 1.000 | 0.888 | 0.856 |
| Chroma | en (22) | 0.977 | 1.000 | 1.000 | 0.761 | 0.697 |
| Qdrant | en (22) | 0.977 | 1.000 | 1.000 | 0.804 | 0.760 |

Overview golden, files:

| path | cohort | recall@16 | recall in the 60-chunk pool | MRR |
|---|---|---|---|---|
| Chroma | overview | 0.950 | 0.983 | 0.632 |
| Qdrant | overview | 0.850 | 0.983 | 0.692 |
| Chroma | exact-id | 0.900 | 0.900 | 0.528 |
| Qdrant | exact-id | 0.800 | 0.800 | 0.487 |
| Chroma | paraphrase | 1.000 | 1.000 | 0.750 |
| Qdrant | paraphrase | 1.000 | 1.000 | 0.900 |

Hard cases through the full retrieval, mean R-precision: Chroma 0.543,
Qdrant 0.554.

How to read these tables:

- **The pool is what the reranker sees.** Both paths put every labelled unit
  of the Punkt golden set into the 60-chunk pool (recall@60 1.000), and the
  same overview files (0.983).
- **Qdrant ranks higher.** MRR and nDCG@10 are higher on every golden subset.
- **Overview recall@16.** The 0.85 against 0.95 is ordering inside the pool,
  not a miss. It comes from two questions: `ov-rl1` has three expected files
  and two of them sit past file rank 16; `ov-rl6` has one of three past it.
- **Exact-id has one real pool miss.** `ex-filename-rl5` (the bare file name
  `oib-rl_5_ausgabe_mai_2023.pdf`) is at file rank 12 on Chroma and outside
  Qdrant's 60-chunk pool. Neither lexical channel fires on that query, so it
  is the dense ranking alone. The likely cause, not yet measured, is TurboQuant
  4-bit with default oversampling: in the G6 table, `q3072` loses top-rank
  hits that float `f3072` keeps.
- **`§` lookups regress.** This is the one open item. „§ 8“ has P@10 0.50 /
  R-precision 0.44 on Chroma and 0 / 0 on Qdrant. Chroma's `$contains "§ 8"`
  restricts the dense ranking to the literal string. In Qdrant `§` is no token
  under any text-index tokenizer that handles the rest of the corpus well
  (`whitespace` keeps it, but breaks „OIB-Richtlinie“ and „90,“). So the
  phrase channel can only restrict to chunks with a standalone 8. In this
  corpus `§` appears only in front-matter boilerplate, which is why the golden
  sets do not move. Office documents (Bescheide citing „§ 3 Abs. 2“) are where
  it will matter.
- **Hybrid fusion lowers MRR on these questions.** Dense alone has an MRR of
  0.890 (G6 table), Qdrant hybrid 0.810 and Chroma hybrid 0.725. Equal-weight
  RRF demotes the dense channel's top hit for natural-language questions. The
  RRF weights the design reserves (`weights: [1, 1]`) are the knob, and tuning
  them is a separate decision from the flip.

### G2 latency: pass (this machine only)

The store call per collection, embedding excluded (the query vector is
pre-cached in the retriever's LRU), timed over 5 passes of 76 questions after
one warm-up pass. The Qdrant path's time includes its term-frequency counts
(cached per collection size) and the cosine lookup.

| path | n | p50 | p95 | p99 | mean |
|---|---|---|---|---|---|
| Chroma (embedded, plus Postgres mirror) | 380 | 58.3 ms | 88.9 ms | 120.2 ms | 59.6 ms |
| Qdrant (one node, REST, localhost) | 380 | 19.9 ms | 34.3 ms | 64.7 ms | 22.0 ms |

The p95 of 34 ms is well under the 230 ms bound. This is a single local node
with no network hop, no concurrent load and a 2.5k-point collection. The gate
as written is measured on Langfuse `retrieve.knowledge_search` in a deployed
environment; this number only says the store itself is not the risk.

### G6 dimension: fail at the 1-point bound

Dense channel only, Punkt golden (46 questions):

| variant | recall@1 | recall@3 | recall@5 | recall@16 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| exact cosine, 3072 | 0.739 | 0.935 | 0.935 | 1.000 | 0.907 | 0.890 |
| exact cosine, 1024 (truncated + renormalised) | 0.707 | 0.913 | 0.924 | 1.000 | 0.894 | 0.879 |
| Qdrant HNSW, 3072 float | 0.739 | 0.935 | 0.935 | 1.000 | 0.907 | 0.890 |
| Qdrant HNSW, 3072 TurboQuant 4-bit | 0.717 | 0.935 | 0.935 | 1.000 | 0.898 | 0.879 |
| Qdrant HNSW, 1024 float | 0.707 | 0.913 | 0.924 | 1.000 | 0.894 | 0.879 |
| Qdrant HNSW, 1024 TurboQuant 4-bit | 0.707 | 0.913 | 0.924 | 1.000 | 0.890 | 0.872 |

Recall@16 saturates at 1.000 for every variant, so it cannot see a drop. The
harness therefore judges G6 at recall@1, @5 and @16:

- **1024 against 3072, exact.** −3.3 points at recall@1 and −1.1 at recall@5.
- **The same, both under TurboQuant.** −1.1 at both.

**Read the size of that honestly.** With 46 questions, one question's top hit
is worth about 2 points of recall@1. The measured drop is one or two
questions, and this set cannot resolve a 1-point bound either way. The gate as
written does not pass, so `dense` stays 3072-d. Re-measuring needs a larger
labelled set. TurboQuant 4-bit on 3072 costs one top-1 question against float
(0.717 against 0.739). Its oversampling and rescoring are worth measuring
before calling quantization free.

Run to run, Qdrant's HNSW and TurboQuant numbers moved by one question at
recall@1 between index builds (0.707 to 0.728 for `q3072` across the runs this
change made). The exact-cosine rows do not move.

### G1, G3, G4, G5

| gate | state |
|---|---|
| G1 answer quality | **Not measured.** It needs `task be:eval:answer-suite` against a running stack with Qdrant backfilled, both backends, and model keys. The hybrid tables above are retrieval only; the reranker and the answer are downstream. |
| G3 isolation | Covered by the knowledge-layer property test (`test_isolation_property_random_scope_sets` in `sources/knowledge_layer/tests/test_qdrant_store.py`). This harness does not re-run it. |
| G4 operations | Ops drills: snapshot and restore to SeaweedFS, a pod killed mid-ingest, node replacement. Not measured. |
| G5 memory | Pod metrics during a production-size backfill. Not measured. |

## Defects found and fixed in the Qdrant path

1. **The text index dropped every number.** `schema.py` built the `text`
   payload index with the `multilingual` tokenizer, which discards digit
   tokens. The phrase „REI 90“ matched every REI class (66 chunks against 46).
   „5.1.1“ and „§ 8“ matched nothing. „Punkt 4.2.1“ matched every chunk
   containing „Punkt“ (423 against 8).
   - *Effect.* Both the exact-term channel of `hybrid_search` and its
     selectivity pricing worked on the wrong set.
   - *Fix.* The `word` tokenizer (`schema.TEXT_INDEX`), which the review of
     the slice reached independently. `§` is no token under any tokenizer, so
     `§` references go through the `paragraph_refs` keyword field
     (`search.exact_term`). A collection built with the old tokenizer is
     reported at ERROR by `ensure_payload_indexes` and repaired by copying it
     into a new `_vN` and switching the alias (`scripts/qdrant_rebuild.py`),
     not rebuilt in place under running writers.
   - *Pinned by.* `test_phrase_matching_keeps_the_numbers_in_a_term` and
     `test_a_text_index_built_with_another_tokenizer_is_reported_loudly`
     (`test_qdrant_store.py`), and `test_the_phrase_index_keeps_numbers_and_codes`
     (`test_qdrant_parity_harness.py`).
2. **BM25 was sent unpriced.** The Postgres mirror drops query terms that are
   absent from the collection or on more than 25% of it, and stays silent
   without an alphabetic survivor. Qdrant BM25 received the raw question.
   - *Effect.* For identifier-shaped queries („OIB-RL 2“, „§ 3 OIB-RL 6“, a
     file name) BM25 ranked whole Richtlinien on a digit or on „Ausgabe Mai
     2023“, and RRF promoted that over the dense hits: exact-id MRR was 0.281
     against Chroma's 0.528.
   - *Fix.* `_qdrant_lexical_inputs` prices the BM25 terms with the same
     `german_text.select_terms`, on counts from the text index, cached per
     collection size like the Chroma path's `$contains` pricing.
   - *Results.* exact-id MRR 0.281 → 0.487; overview 0.642 → 0.692; golden
     MRR 0.802 → 0.810.
   - *Cost.* Hard-case R-precision 0.564 → 0.554, still above Chroma's 0.543,
     because a bare „5.1.1“ no longer reaches BM25.
   - *Pinned by.* `test_bm25_terms_are_priced_like_the_german_mirror`
     (`test_qdrant_adapter.py`).

Before and after, Qdrant path only. The first column is the schema as slice 1
shipped it:

| measure | before | tokenizer fixed | both fixed | Chroma |
|---|---|---|---|---|
| golden MRR | 0.802 | 0.792 | 0.810 | 0.725 |
| golden nDCG@10 | 0.840 | 0.832 | 0.848 | 0.782 |
| exact-id MRR | 0.281 | 0.298 | 0.487 | 0.528 |
| overview MRR | 0.642 | 0.633 | 0.692 | 0.632 |
| hard cases R-precision (hybrid) | 0.564 | 0.570 | 0.554 | 0.543 |
| phrase index extra matches, „REI 90“ | 20 | 0 | 0 | — |
| p95 store call | 20.7 ms | 27.1 ms | 34.3 ms | 62.5–88.9 ms |

The p95 rose with the pricing's count calls (one per new term; recurring
terms are cached) and with run-to-run machine noise. Chroma's own p95 moved
between 62 and 89 ms across the same runs.

## Open, before the flip

1. **Ranked `§` lookups** (above). The candidate fix is a keyword channel:
   extract `§ N` / `§ N Abs. M` references into a `legal_refs` keyword payload
   field at upsert, and match exact terms that start with `§` against it
   instead of the phrase index. Needs a payload index on existing collections
   (strict mode refuses a filter without one) and a backfill pass, so it is
   not done here. Measure it with the `para-*` hard cases.
2. **G6 resolution.** A larger labelled set before 1024-d is reconsidered.
3. **TurboQuant oversampling and rescoring.** Measure `ex-filename-rl5` and
   recall@1 with `oversampling` above 1.0 before the flip, or accept the
   quantization cost.
4. **G1** on a deployed stack, with the per-expectation diff reviewed; **G4**
   and **G5** as ops drills.
5. Cross-project grouped search (`search_grouped`) still sends unpriced BM25
   over several scopes. It is not measured here: this corpus has one scope.

## Re-running

```bash
task be:eval:qdrant-parity                       # data/oib, Qdrant, OPENROUTER_API_KEY
task be:eval:qdrant-parity -- --embedder hashed  # keyless wiring check, numbers mean nothing
```

The harness touches only uniquely named `parity_*` collections and drops them
afterwards. A cold run takes about 15 minutes on this machine, most of it
Qdrant building HNSW and TurboQuant for 2.5k × 3,072 dimensions twice (the
corpus collection and the G6 collection). Its own tests are
`tests/benchmarks/test_qdrant_parity.py` (offline) and
`sources/knowledge_layer/tests/test_qdrant_parity_harness.py` (against
`AIQ_QDRANT_TEST_URL`, which CI provides).
