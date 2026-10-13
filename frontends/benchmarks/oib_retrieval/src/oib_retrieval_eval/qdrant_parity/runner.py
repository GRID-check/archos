"""``task be:eval:qdrant-parity``: run the Qdrant migration gates on the OIB corpus.

    PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src:sources/knowledge_layer/src \\
      .venv/bin/python -m oib_retrieval_eval.qdrant_parity.runner --out /tmp/qdrant-parity

Needs: the corpus in ``data/oib`` (operator-provided), a Qdrant 1.19 server
(``--qdrant-url``, default ``$AIQ_QDRANT_TEST_URL`` or ``http://localhost:6333``), and
for ``--embedder production`` (the default) an OpenRouter key. PostgreSQL server
binaries are used when present, for the real German mirror; without them the mirror
runs on SQLite and the report says so.

What it measures, how, and what it does not: ``docs/architecture/qdrant-gates-2026-10.md``
and the package docstring. Results are printed as markdown and written as
``results.json`` + ``report.md`` under ``--out``.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import platform
import sys
import tempfile
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

import numpy as np

from oib_retrieval_eval import corpus
from oib_retrieval_eval import metrics
from oib_retrieval_eval import qrels
from oib_retrieval_eval.qdrant_parity import channels
from oib_retrieval_eval.qdrant_parity import dimension
from oib_retrieval_eval.qdrant_parity import evaluation
from oib_retrieval_eval.qdrant_parity import stores
from oib_retrieval_eval.qdrant_parity.stores import IndexedChunk
from oib_retrieval_eval.qdrant_parity.vectors import Embedder
from oib_retrieval_eval.qdrant_parity.vectors import embed_text

logger = logging.getLogger(__name__)

_CHUNK_NAMESPACE = uuid.UUID("0f4e8a52-3c1d-4b8e-9f60-7a2d1c5e9b31")

#: Retrieval depth of the hybrid comparison: production's ``rerank_candidates``,
#: the pool ``knowledge_search`` asks each collection for.
HYBRID_DEPTH = 60
#: Depth the lexical channels are read to; well above every reported cutoff.
LEXICAL_DEPTH = 120
LEXICAL_K = (1, 5, 10, 16, 20)

#: Phrases the exact-mode check runs: the hard cases plus multi-word, separator
#: and transliteration cases ``browse.phrase_pattern`` exists for.
EXTRA_EXACT_PHRASES = (
    "Fluchtweg",
    "Geschoß",
    "Gebäudeklasse 5",
    "Rauchabzugseinrichtung",
    "barrierefrei",
    "OIB Richtlinie 2",
    "mindestens 2,00 m",
    "Brandwand",
    "Stiegenhaus",
    "nicht brennbar",
)


@dataclass
class Inputs:
    """Everything one run reads: the corpus, the labels, the vectors."""

    chunks: list[IndexedChunk]
    doc_vectors: np.ndarray
    judgements: list[qrels.Judgements]
    overview: list[Any]
    hard_cases: list[evaluation.HardCase]
    excluded: frozenset[str]
    query_vectors: dict[str, np.ndarray] = field(default_factory=dict)
    embedder: str = "production"
    model: str = ""
    base_url: str = ""
    embedded_now: int = 0


# ---------------------------------------------------------------- inputs


def indexed_chunks(raw: Sequence[corpus.Chunk]) -> list[IndexedChunk]:
    """The harness chunks with UUID ids (a Chroma id that is a UUID is the Qdrant point id)."""
    return [
        IndexedChunk(
            chunk_id=str(uuid.uuid5(_CHUNK_NAMESPACE, chunk.chunk_id)),
            text=chunk.text,
            file_name=chunk.file_name,
            page=chunk.page,
            metadata={key: value for key, value in chunk.metadata.items() if value is not None},
        )
        for chunk in raw
    ]


def all_queries(inputs: Inputs) -> list[str]:
    seen: dict[str, None] = {}
    for judged in inputs.judgements:
        seen[judged.entry.question] = None
    for entry in inputs.overview:
        seen[entry.question] = None
    for case in inputs.hard_cases:
        seen[case.query] = None
    return list(seen)


def embed_inputs(inputs: Inputs, embedder: Embedder) -> None:
    texts = [embed_text(chunk.text, chunk.metadata) for chunk in inputs.chunks]
    inputs.doc_vectors = embedder.embed("document", texts)
    queries = all_queries(inputs)
    vectors = embedder.embed("query", queries)
    inputs.query_vectors = {query: vectors[i] for i, query in enumerate(queries)}
    inputs.embedder = embedder.name
    inputs.model = embedder.model
    inputs.base_url = embedder.base_url
    inputs.embedded_now = embedder.embedded_now


# ---------------------------------------------------------------- helpers


class Corpus:
    """Lookups over the indexed chunks under production's base filter."""

    def __init__(self, chunks: Sequence[IndexedChunk], excluded: frozenset[str]):
        self.chunks = list(chunks)
        self.by_id = {chunk.chunk_id: chunk for chunk in chunks}
        self.excluded = excluded

    def allowed(self, chunk: IndexedChunk) -> bool:
        return chunk.file_name not in self.excluded and chunk.metadata.get("chunking") != channels.NON_EVIDENCE_CHUNKING

    def allowed_ids(self, ids: Sequence[str]) -> list[IndexedChunk]:
        return [self.by_id[i] for i in ids if i in self.by_id and self.allowed(self.by_id[i])]

    @staticmethod
    def units(chunks: Sequence[Any]) -> list[qrels.Unit]:
        seen: dict[qrels.Unit, None] = {}
        for chunk in chunks:
            page = getattr(chunk, "page", None)
            if page is None:
                page = getattr(chunk, "page_number", None)
            if page is None:
                continue
            seen.setdefault(qrels.Unit(chunk.file_name, int(page)), None)
        return list(seen)

    @staticmethod
    def files(chunks: Sequence[Any]) -> list[str]:
        return list(dict.fromkeys(chunk.file_name for chunk in chunks))


def _graded(judgements: Sequence[qrels.Judgements]) -> list[dict]:
    return [dict(judged.graded) for judged in judgements]


# ---------------------------------------------------------------- measurements


def measure_lexical(
    inputs: Inputs, corpus_view: Corpus, lexical_stores: dict[str, Any], retriever: Any
) -> dict[str, Any]:
    """G1b ranking half: the German mirror(s) against Qdrant BM25, golden and hard cases."""
    filters = channels.base_filters(sorted(inputs.excluded))
    german = [j for j in inputs.judgements if j.entry.language == "de"]
    rankers: dict[str, Any] = {
        name: (
            lambda q, s=store: corpus_view.allowed_ids(channels.postgres_lexical(s, q, LEXICAL_DEPTH))[:LEXICAL_DEPTH]
        )
        for name, store in lexical_stores.items()
    }
    rankers["qdrant_bm25"] = lambda q: corpus_view.allowed_ids(
        channels.qdrant_bm25(retriever, q, LEXICAL_DEPTH, filters)
    )
    golden: dict[str, Any] = {}
    hard: dict[str, Any] = {}
    allowed_chunks = [chunk for chunk in corpus_view.chunks if corpus_view.allowed(chunk)]
    relevant_counts = {
        case.id: sum(1 for chunk in allowed_chunks if case.relevant(chunk.text)) for case in inputs.hard_cases
    }
    for name, rank in rankers.items():
        de_rankings = [Corpus.units(rank(j.entry.question)) for j in german]
        golden[name] = evaluation.score_graded(de_rankings, _graded(german), LEXICAL_K)
        golden[name + ":empty"] = sum(1 for r in de_rankings if not r) / max(len(de_rankings), 1)
        scores = [
            evaluation.score_hard_case(case, [c.text for c in rank(case.query)], relevant_counts[case.id])
            for case in inputs.hard_cases
        ]
        hard[name] = scores
    return {"golden": golden, "hard": hard, "relevant_counts": relevant_counts}


def measure_exact(inputs: Inputs, retriever: Any) -> list[dict[str, Any]]:
    """Exact mode: Chroma ``$regex`` vs Qdrant ``find_text`` vs the phrase index alone, per phrase."""
    filters = channels.base_filters(sorted(inputs.excluded))
    phrases = list(dict.fromkeys([case.query for case in inputs.hard_cases] + list(EXTRA_EXACT_PHRASES)))
    rows: list[dict[str, Any]] = []
    for phrase in phrases:
        with stores.backend("chroma"):
            chroma = channels.exact_matches(retriever, phrase, filters)
        with stores.backend("qdrant"):
            qdrant = channels.exact_matches(retriever, phrase, filters)
        index_only = channels.phrase_index_matches(phrase, filters)
        rows.append(
            {
                "phrase": phrase,
                "chroma_regex": len(chroma),
                "qdrant_find_text": len(qdrant),
                "identical": chroma == qdrant,
                "only_chroma": len(chroma - qdrant),
                "only_qdrant": len(qdrant - chroma),
                "phrase_index": len(index_only),
                "phrase_index_misses": len(chroma - index_only),
                "phrase_index_extra": len(index_only - chroma),
            }
        )
    return rows


def measure_hybrid(inputs: Inputs, retriever: Any, rounds: int) -> dict[str, Any]:
    """Hybrid recall on both paths, and the store-call latency of each over ``rounds`` passes."""
    filters = channels.base_filters(sorted(inputs.excluded))
    answerable = [j for j in inputs.judgements if j.graded]
    questions = [j.entry.question for j in answerable] + [e.question for e in inputs.overview]
    rankings: dict[str, dict[str, list[Any]]] = {"chroma": {}, "qdrant": {}}
    latency: dict[str, list[float]] = {"chroma": [], "qdrant": []}
    for round_index in range(rounds + 1):  # round 0 warms caches and is not timed
        for question in questions:
            for name in ("chroma", "qdrant") if round_index % 2 == 0 else ("qdrant", "chroma"):
                with stores.backend(name):
                    hits, elapsed = channels.hybrid(retriever, question, HYBRID_DEPTH, filters)
                if round_index == 0:
                    rankings[name][question] = hits
                else:
                    latency[name].append(elapsed)
    result: dict[str, Any] = {"latency_ms": {name: evaluation.latency_summary(v) for name, v in latency.items()}}
    for name in ("chroma", "qdrant"):
        unit_rankings = [Corpus.units(rankings[name][j.entry.question]) for j in answerable]
        result[name] = {
            "golden_all": evaluation.score_graded(unit_rankings, _graded(answerable), evaluation.HYBRID_K),
            "golden_de": evaluation.score_graded(
                [r for r, j in zip(unit_rankings, answerable, strict=True) if j.entry.language == "de"],
                _graded([j for j in answerable if j.entry.language == "de"]),
                evaluation.HYBRID_K,
            ),
            "golden_en": evaluation.score_graded(
                [r for r, j in zip(unit_rankings, answerable, strict=True) if j.entry.language == "en"],
                _graded([j for j in answerable if j.entry.language == "en"]),
                evaluation.HYBRID_K,
            ),
            "overview": _overview_scores(inputs.overview, rankings[name]),
        }
    overlaps = []
    for question in questions:
        left = {c.chunk_id for c in rankings["chroma"][question][:16]}
        right = {c.chunk_id for c in rankings["qdrant"][question][:16]}
        overlaps.append(len(left & right) / max(len(left | right), 1))
    result["top16_jaccard_mean"] = round(metrics.mean(overlaps), 4)
    # Per overview question: where each path puts the first expected file, and its top
    # files. The per-expectation diff a reviewer reads before trusting a cohort mean.
    result["overview_per_query"] = {
        entry.id: {
            name: {
                "first_expected_rank": next(
                    (
                        rank
                        for rank, f in enumerate(Corpus.files(rankings[name][entry.question]), 1)
                        if f in entry.expected
                    ),
                    None,
                ),
                "recall@16": metrics.recall_at_k(Corpus.files(rankings[name][entry.question]), set(entry.expected), 16),
                "top_files": Corpus.files(rankings[name][entry.question])[:3],
            }
            for name in ("chroma", "qdrant")
        }
        for entry in inputs.overview
    }
    return result


def measure_hybrid_hard(inputs: Inputs, retriever: Any, relevant: dict[str, int]) -> dict:
    """The hard cases through each path's FULL retrieval: what an architect typing „§ 3“ gets back.

    G1b compares the lexical channels alone; this asks the question the gate exists
    for, with every channel each path fuses (dense, ``$contains`` / phrase, German
    lexical / BM25).
    """
    filters = channels.base_filters(sorted(inputs.excluded))
    out: dict[str, list[evaluation.HardCaseScore]] = {}
    for name in ("chroma", "qdrant"):
        with stores.backend(name):
            out[name] = [
                evaluation.score_hard_case(
                    case,
                    [chunk.content for chunk in channels.hybrid(retriever, case.query, HYBRID_DEPTH, filters)[0]],
                    relevant[case.id],
                )
                for case in inputs.hard_cases
            ]
    return out


def _overview_scores(entries: Sequence[Any], rankings: dict[str, list[Any]]) -> dict[str, dict[str, float]]:
    by_cohort: dict[str, list[tuple[list[str], set[str]]]] = {}
    for entry in entries:
        by_cohort.setdefault(entry.cohort, []).append((Corpus.files(rankings[entry.question]), set(entry.expected)))
    return {
        cohort: {
            "queries": len(pairs),
            "recall@16": round(metrics.mean([metrics.recall_at_k(r, rel, 16) for r, rel in pairs]), 4),
            # Every file the 60-chunk pool reaches: what the reranker can still choose from.
            "recall_pool": round(metrics.mean([len(rel & set(r)) / len(rel) for r, rel in pairs]), 4),
            "mrr": round(metrics.mean([metrics.mrr(r, rel) for r, rel in pairs]), 4),
        }
        for cohort, pairs in sorted(by_cohort.items())
    }


def measure_dimension(inputs: Inputs, corpus_view: Corpus, client: Any | None) -> dict[str, Any]:
    """G6: recall at 3072 vs 1024 (exact and through Qdrant's index, float and TurboQuant)."""
    answerable = [j for j in inputs.judgements if j.graded]
    queries = np.stack([inputs.query_vectors[j.entry.question] for j in answerable])
    docs = inputs.doc_vectors / np.linalg.norm(inputs.doc_vectors, axis=1, keepdims=True)
    queries = queries / np.linalg.norm(queries, axis=1, keepdims=True)
    depth = 400  # deep enough that dropping excluded files leaves the 60 scored

    def unit_of(row: int) -> qrels.Unit:
        chunk = corpus_view.chunks[row]
        return qrels.Unit(chunk.file_name, chunk.page)

    def allowed(row: int) -> bool:
        return corpus_view.allowed(corpus_view.chunks[row])

    def scores(rows_per_query: list[list[int]]) -> evaluation.RankScores:
        units = [dimension.to_units(rows, unit_of, allowed, HYBRID_DEPTH) for rows in rows_per_query]
        return evaluation.score_graded(units, _graded(answerable), evaluation.HYBRID_K)

    full = docs.shape[1]
    reduced = dimension.REDUCED if full > dimension.REDUCED else full // 2
    result: dict[str, Any] = {
        "dimension": int(full),
        "reduced": int(reduced),
        "exact_full": scores(dimension.exact_rankings(docs, queries, depth)),
        "exact_reduced": scores(
            dimension.exact_rankings(
                dimension.truncate_renormalise(docs, reduced), dimension.truncate_renormalise(queries, reduced), depth
            )
        ),
    }
    if client is not None and full == dimension.FULL:
        ann, info = dimension.qdrant_rankings(client, docs, queries, depth)
        result["qdrant_index"] = info
        for variant, rows in ann.items():
            result[f"qdrant_{variant}"] = scores(rows)
    return result


# ---------------------------------------------------------------- the run


def environment(qdrant_url: str, lexical_backend: str) -> dict[str, str]:
    import chromadb

    info = {
        "python": platform.python_version(),
        "machine": platform.machine(),
        "cpus": str(os.cpu_count()),
        "chromadb": chromadb.__version__,
        "qdrant_url": qdrant_url,
        "lexical_backend": lexical_backend,
    }
    try:
        import httpx

        info["qdrant"] = httpx.get(qdrant_url, timeout=5).json().get("version", "?")
    except Exception:  # noqa: BLE001 - informational only
        info["qdrant"] = "?"
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("model name"):
                info["cpu"] = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    return info


def run(
    inputs: Inputs,
    *,
    qdrant_url: str,
    rounds: int,
    work_dir: Path,
    with_dimension: bool = True,
    use_postgres: bool = True,
) -> dict[str, Any]:
    """Index both stores from ``inputs``, measure every gate, return the results dict.

    ``use_postgres`` False keeps the German mirror on SQLite even where server
    binaries exist (the tests: a cluster costs seconds they do not need).
    """
    corpus_view = Corpus(inputs.chunks, inputs.excluded)
    fingerprint = stores.identity(inputs.model, inputs.base_url)
    report: dict[str, Any] = {
        "corpus": {
            "chunks": len(inputs.chunks),
            "allowed_chunks": sum(1 for c in inputs.chunks if corpus_view.allowed(c)),
            "files": len({c.file_name for c in inputs.chunks}),
            "dimension": int(inputs.doc_vectors.shape[1]),
        },
        "embedder": {"name": inputs.embedder, "model": inputs.model, "embedded_this_run": inputs.embedded_now},
        "queries": {
            "golden": len(inputs.judgements),
            "golden_answerable": sum(1 for j in inputs.judgements if j.graded),
            "overview": len(inputs.overview),
            "hard_cases": len(inputs.hard_cases),
        },
    }
    postgres = stores.throwaway_postgres() if use_postgres else contextlib.nullcontext(None)
    with postgres as pg_url, stores.isolated_qdrant(qdrant_url):
        lexical_urls = {"sqlite": f"sqlite:///{work_dir / 'chunk_text.db'}"}
        if pg_url:
            lexical_urls = {"postgres": pg_url, **lexical_urls}
        lexical_stores = {name: stores.lexical_store(url) for name, url in lexical_urls.items()}
        for store in lexical_stores.values():
            stores.fill_lexical(store, inputs.chunks)
        # The retriever reads the process-wide store: the production one when it ran.
        primary = "postgres" if pg_url else "sqlite"
        stores.lexical_store(lexical_urls[primary])
        report["environment"] = environment(qdrant_url, primary)

        client = stores.chroma_client(work_dir / "chroma")
        collection = stores.fill_chroma(client, inputs.chunks, inputs.doc_vectors, fingerprint)
        chroma_count, qdrant_count = stores.fill_qdrant(collection, fingerprint)
        report["corpus"]["chroma_count"], report["corpus"]["qdrant_count"] = chroma_count, qdrant_count
        report["qdrant_index"] = stores.wait_until_indexed()

        queries = list(inputs.query_vectors)
        matrix = np.stack([inputs.query_vectors[q] for q in queries])
        reader = stores.retriever(client, inputs.model, inputs.base_url, queries, matrix)

        report["lexical"] = measure_lexical(inputs, corpus_view, lexical_stores, reader)
        report["exact"] = measure_exact(inputs, reader)
        report["hybrid"] = measure_hybrid(inputs, reader, rounds)
        report["hybrid_hard"] = measure_hybrid_hard(inputs, reader, report["lexical"]["relevant_counts"])
        if with_dimension:
            from knowledge_layer.qdrant.store import get_store

            report["dimension"] = measure_dimension(inputs, corpus_view, get_store().client)
    report["verdicts"] = [asdict(v) for v in verdicts(report)]
    return _plain(report)


def verdicts(report: dict[str, Any]) -> list[evaluation.Verdict]:
    lexical = report["lexical"]
    reference = "postgres" if "postgres" in lexical["golden"] else "sqlite"
    exact_mismatches = sum(1 for row in report["exact"] if not row["identical"])
    out = [
        evaluation.g1b_lexical_verdict(
            lexical["golden"]["qdrant_bm25"],
            lexical["golden"][reference],
            evaluation.mean_hard(lexical["hard"]["qdrant_bm25"], gating_only=True),
            evaluation.mean_hard(lexical["hard"][reference], gating_only=True),
            exact_mismatches,
        ),
        evaluation.g2_latency_verdict(report["hybrid"]["latency_ms"]["qdrant"]),
    ]
    dim = report.get("dimension")
    if dim and dim["dimension"] == dimension.FULL:
        out.append(evaluation.g6_dimension_verdict(dim["exact_full"], dim["exact_reduced"], label="exact cosine"))
        if "qdrant_q3072" in dim:
            out.append(
                evaluation.g6_dimension_verdict(
                    dim["qdrant_q3072"], dim["qdrant_q1024"], label="HNSW + TurboQuant 4-bit"
                )
            )
    else:
        out.append(evaluation.Verdict("G6 dimension", "not measured", "needs the production 3072-d vectors"))
    out.append(
        evaluation.Verdict("G1 answer quality", "not measured", "needs a running stack: task be:eval:answer-suite")
    )
    out.append(evaluation.Verdict("G3 isolation", "not measured here", "the knowledge-layer isolation property test"))
    out.append(evaluation.Verdict("G4 operations / G5 memory", "not measured here", "ops drills on the cluster"))
    return out


def _plain(value: Any) -> Any:
    """The results as JSON-ready plain data."""
    if isinstance(value, evaluation.RankScores):
        return value.as_dict()
    if isinstance(value, evaluation.HardCaseScore):
        return asdict(value)
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, float):
        return round(value, 4)
    return value


# ---------------------------------------------------------------- the report


def _fmt(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, float) else str(value)


def _hard_tables(lines: list[str], hard: dict[str, list[dict]], relevant_counts: dict[str, int]) -> None:
    """Per-case P@10 / R-precision per channel, then the means over the gating cases."""
    names = list(hard)
    lines.append("| case | kind | relevant | " + " | ".join(f"{n} P@10 / R-prec" for n in names) + " |")
    lines.append("|---|---|---|" + "---|" * len(names))
    by_channel = {name: {row["case_id"]: row for row in rows} for name, rows in hard.items()}
    for case_id, relevant in relevant_counts.items():
        kind = by_channel[names[0]][case_id]["kind"]
        cells = [
            f"{by_channel[n][case_id]['precision']:.2f} / {by_channel[n][case_id]['r_precision']:.2f}" for n in names
        ]
        lines.append(f"| {case_id} | {kind} | {relevant} | " + " | ".join(cells) + " |")
    lines.append("\n| channel | gating cases | mean P@10 | mean R-prec | mean MRR |")
    lines.append("|---|---|---|---|---|")
    for name in names:
        summary = evaluation.mean_hard([evaluation.HardCaseScore(**row) for row in hard[name]], gating_only=True)
        lines.append(
            f"| {name} | {summary['cases']} | {summary['precision']:.3f} | {summary['r_precision']:.3f} | "
            f"{summary['mrr']:.3f} |"
        )


def render_markdown(report: dict[str, Any]) -> str:
    """The results as the markdown tables the gate report quotes."""
    lines: list[str] = []
    env = report.get("environment", {})
    lines.append("## Environment\n")
    lines.append(
        f"Corpus: {report['corpus']['chunks']} chunks ({report['corpus']['allowed_chunks']} after the base filter), "
        f"{report['corpus']['files']} files, {report['corpus']['dimension']}-d vectors from "
        f"`{report['embedder']['model']}` ({report['embedder']['embedded_this_run']} texts embedded this run). "
        f"Chroma {report['corpus'].get('chroma_count')} / Qdrant {report['corpus'].get('qdrant_count')} points."
    )
    lines.append(
        f"Machine: {env.get('cpu', '?')}, {env.get('cpus')} CPUs, Python {env.get('python')}; "
        f"Qdrant {env.get('qdrant')} at {env.get('qdrant_url')}; chromadb {env.get('chromadb')} embedded; "
        f"German mirror on {env.get('lexical_backend')}. Qdrant index: {report.get('qdrant_index')}.\n"
    )
    lexical = report["lexical"]
    lines.append("## G1b lexical: German golden questions (units, base filter)\n")
    lines.append("| channel | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR | no result |")
    lines.append("|---|---|---|---|---|---|---|")
    for name, scores in lexical["golden"].items():
        if name.endswith(":empty"):
            continue
        lines.append(
            f"| {name} | {_fmt(scores['recall']['5'])} | {_fmt(scores['recall']['10'])} | "
            f"{_fmt(scores['recall']['16'])} | {_fmt(scores['ndcg']['10'])} | {_fmt(scores['mrr'])} | "
            f"{_fmt(lexical['golden'][name + ':empty'])} |"
        )
    lines.append("\n## G1b lexical: hard cases (chunk oracle), lexical channels alone\n")
    _hard_tables(lines, lexical["hard"], lexical["relevant_counts"])
    if "hybrid_hard" in report:
        lines.append(f"\n## Hard cases through each path's full retrieval (depth {HYBRID_DEPTH})\n")
        _hard_tables(lines, report["hybrid_hard"], lexical["relevant_counts"])
    lines.append("\n## Exact mode: Chroma `$regex` vs Qdrant `find_text` vs the phrase index alone\n")
    lines.append("| phrase | $regex | find_text | identical | phrase index | index misses | index extra |")
    lines.append("|---|---|---|---|---|---|---|")
    for row in report["exact"]:
        lines.append(
            f"| `{row['phrase']}` | {row['chroma_regex']} | {row['qdrant_find_text']} | "
            f"{'yes' if row['identical'] else 'NO'} | {row['phrase_index']} | {row['phrase_index_misses']} | "
            f"{row['phrase_index_extra']} |"
        )
    hybrid = report["hybrid"]
    lines.append(f"\n## Hybrid: per-collection retrieval at depth {HYBRID_DEPTH} (Punkt golden, units)\n")
    lines.append("| path | set | recall@10 | recall@16 | recall@60 | nDCG@10 | MRR |")
    lines.append("|---|---|---|---|---|---|---|")
    for name in ("chroma", "qdrant"):
        for subset in ("golden_all", "golden_de", "golden_en"):
            s = hybrid[name][subset]
            lines.append(
                f"| {name} | {subset.removeprefix('golden_')} ({s['queries']}) | {_fmt(s['recall']['10'])} | "
                f"{_fmt(s['recall']['16'])} | {_fmt(s['recall']['60'])} | {_fmt(s['ndcg']['10'])} | {_fmt(s['mrr'])} |"
            )
    lines.append("\n| path | cohort | recall@16 (files) | recall, whole pool (files) | MRR |")
    lines.append("|---|---|---|---|---|")
    for name in ("chroma", "qdrant"):
        for cohort, s in hybrid[name]["overview"].items():
            lines.append(
                f"| {name} | {cohort} ({s['queries']}) | {_fmt(s['recall@16'])} | {_fmt(s['recall_pool'])} | "
                f"{_fmt(s['mrr'])} |"
            )
    lines.append(f"\nMean top-16 Jaccard overlap between the two paths: {hybrid['top16_jaccard_mean']:.3f}\n")
    lines.append("## G2 latency: store call per collection, embedding excluded (ms)\n")
    lines.append("| path | n | p50 | p95 | p99 | mean |")
    lines.append("|---|---|---|---|---|---|")
    for name, s in hybrid["latency_ms"].items():
        lines.append(f"| {name} | {s['n']} | {s['p50']} | {s['p95']} | {s['p99']} | {s['mean']} |")
    dim = report.get("dimension")
    if dim:
        lines.append(f"\n## G6 dimension: dense channel, Punkt golden ({dim['dimension']} vs {dim['reduced']})\n")
        lines.append("| variant | recall@1 | recall@3 | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for key, value in dim.items():
            if isinstance(value, dict) and "recall" in value:
                cells = [_fmt(value["recall"][k]) for k in ("1", "3", "5", "10", "16")]
                cells += [_fmt(value["ndcg"]["10"]), _fmt(value["mrr"])]
                lines.append(f"| {key} | " + " | ".join(cells) + " |")
        if "qdrant_index" in dim:
            lines.append(f"\nG6 collection index state: {dim['qdrant_index']}")
    lines.append("\n## Verdicts\n")
    lines.append("| gate | status | detail |")
    lines.append("|---|---|---|")
    for verdict in report["verdicts"]:
        lines.append(f"| {verdict['gate']} | {verdict['status']} | {verdict['detail']} |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- CLI


def load_inputs(embedder_name: str, cache_dir: Path) -> Inputs:
    from oib_retrieval_eval import overview

    fixtures = corpus.package_root() / "fixtures"
    golden = qrels.load_golden(fixtures / "oib_retrieval_golden.json")
    punkt_index = qrels.load_punkt_index(fixtures / "punkt_index.json")
    excluded = corpus.production_retrieval_settings().exclude_file_names
    inputs = Inputs(
        chunks=indexed_chunks(corpus.build_arm(corpus.ARM_PUNKT)),
        doc_vectors=np.zeros((0, 0), dtype=np.float32),
        judgements=list(qrels.build_judgements(golden, punkt_index)),
        overview=overview.load_golden(overview.default_golden_path()),
        hard_cases=evaluation.load_hard_cases(fixtures / "qdrant_lexical_hard_cases.json"),
        excluded=frozenset(excluded),
    )
    embed_inputs(inputs, Embedder(embedder_name, cache_dir / embedder_name))
    return inputs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--embedder", choices=("production", "hashed"), default="production")
    parser.add_argument("--qdrant-url", default=os.environ.get("AIQ_QDRANT_TEST_URL") or "http://localhost:6333")
    parser.add_argument("--rounds", type=int, default=5, help="timed passes over every question (G2)")
    parser.add_argument("--out", type=Path, default=corpus.package_root() / "results" / "qdrant_parity")
    parser.add_argument("--no-dimension", action="store_true", help="skip G6")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    try:
        inputs = load_inputs(args.embedder, corpus.package_root() / ".cache" / "qdrant_parity")
    except corpus.CorpusMissingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not inputs.chunks:
        print("error: no corpus chunks; put the OIB PDFs in data/oib (see data/oib/README.md)", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="qdrant-parity-") as work:
        report = run(
            inputs,
            qdrant_url=args.qdrant_url,
            rounds=args.rounds,
            work_dir=Path(work),
            with_dimension=not args.no_dimension,
        )
    markdown = render_markdown(report)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (args.out / "report.md").write_text(markdown, encoding="utf-8")
    print(markdown)
    print(f"written: {args.out / 'results.json'}, {args.out / 'report.md'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
