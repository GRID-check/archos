"""What a PDF will cost to ingest, from facts cheaper to read than the ingest.

The confirmation step before a costly upload needs a number *before* it pays for
one. This module turns four facts that a pre-read can measure in seconds into an
estimate of the ingest bill, with the spread and the degradation stated rather
than hidden.

What the money goes to during a PDF ingest (``sources/knowledge_layer``):

* **Vision calls** — one per embedded raster at least ``MIN_IMAGE_WIDTH_PX`` wide
  and tall (``_extract_images_from_pdf``, deduped by content hash, capped at
  ``MAX_IMAGES_PER_DOCUMENT``) plus one per rendered drawing page
  (``MAX_RENDERED_PAGES``). This is the bill: 81% of ingest cost in the sample
  below.
* **Transcription calls** — one per scanned or garbled page (``MIN_SCAN_RASTER_COVERAGE``,
  capped at ``MAX_OCR_PAGES``): 12.7%.
* **Embedding** — the vectors the chunks become: 5.5%.
* **A per-document constant** — the classification/decision call every file pays
  whatever its size: 0.7%.

Calibration
-----------
Fitted against the real ledger, not a guess. ``llm_usage_events`` rows with
``activity = 'ingest'`` were joined to documents through
``documents.metadata->>'ingestJobId' = llm_usage_events.job_id`` (the document id
is not the job id) and to the PDF bytes in the object store; for each of
**259** ingesting PDFs the ledger's role split was compared with facts measured
by re-reading the same PDF with pypdfium2 and pdfplumber. Sample: 9.38 USD of
ingest spend over 259 documents, 900 vision calls, 69 transcription calls.

Call counts (the mechanism, which is what the cheap facts observe):

* vision ``max(0, min(64, distinct raster sizes >= 100px) - 1)`` — the ``- 1`` is
  the letterhead/logo allowance: a document whose only embedded raster is one
  distinct size has no vision call far more often than not. Add
  ``min(20, drawing pages)`` only when the document has *no* embedded raster;
  where it has both, the rendered pages are overwhelmingly the same pages whose
  raster the extractor already counted, and adding both double-counts (sum 1162
  predicted against 900 actual, versus 976 with the term restricted). Exact on
  75.3% of documents, within one call on 83.4%, aggregate 976/900 (1.08x).
* transcription ``min(500, scanned + garbled pages)`` — exact on 98.5% of
  documents, aggregate 106/69 (1.54x; repeated scanned pages hit the content
  cache and a few scans are not transcribed at all).

Cost of one call (the weak part — read it as indicative):

* ``VISION_USD_PER_CALL = 0.008439`` is the mean over every observed call, but
  the per-call price is model-dependent and heavy-tailed: median 0.004349,
  p90 0.029583 (6.8x the median), because the admin chooses the vision model.
  Per-call *tokens* are far steadier (total p10/50/90 = 2312/4234/7027), so
  ``vision_prompt_tokens``/``vision_completion_tokens`` are the robust outputs
  and the dollars are the estimate, never a quote.
* ``EMBEDDING_TOKENS_PER_PAGE = 977`` and ``EMBEDDING_USD_PER_1K_TOKENS = 0.00013``
  give ``EMBEDDING_USD_PER_PAGE``; ``DOCUMENT_USD_PER_DOCUMENT = 0.000228`` is the
  median per-file remainder (the decision call).

Accuracy of the total over the sample: aggregate predicted/actual **1.127**
(slightly high, the safe direction for a confirmation), median absolute error
**0.000126 USD**, p90 **0.057 USD**, 73.0% of documents within 0.01 USD and
89.2% within 0.05 USD. The per-document ratio is p10/50/90 = 0.248/0.931/5.250:
the central estimate is good, the tail is not, and a document can cost five
times it. ``upper_usd`` is ``expected_usd`` times ``UPPER_BOUND_MULTIPLIER``
(4), which covered 90.0% of the sample's documents.

What this is not
----------------
The estimate is a floor for a *PDF*. It does not model a vision call that is
retried, a document auto-reingested when the chunker changes, or non-PDF
ingests. It cannot see through a raster's dimensions to its bytes, so it cannot
tell a plan from a photograph. It reads no file: the caller measures the facts.

Pure: no I/O, no framework, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass
from numbers import Integral

#: Smallest embedded raster, in px on both edges, that earns a vision call.
#: Mirrors ``MIN_IMAGE_WIDTH_PX`` / ``MIN_IMAGE_HEIGHT_PX`` in the adapter.
MIN_RASTER_PX = 100

#: Most embedded rasters analysed per document. Mirrors ``MAX_IMAGES_PER_DOCUMENT``.
MAX_IMAGES_PER_DOCUMENT = 64

#: Distinct raster sizes forgiven as the repeating letterhead/logo before the
#: first call. Measured: documents with exactly one distinct raster had no call
#: far more often than not.
LOGO_IMAGE_ALLOWANCE = 1

#: Most rendered drawing pages analysed per document. Mirrors ``MAX_RENDERED_PAGES``.
MAX_RENDERED_PAGES = 20

#: Most scanned/garbled pages transcribed per document. Mirrors ``MAX_OCR_PAGES``.
MAX_OCR_PAGES = 500

#: Mean USD of one vision call over all 900 calls in the calibration sample.
#: Heavy-tailed: median 0.004349, p90 0.029583. Model-dependent; do not read as a price.
VISION_USD_PER_CALL = 0.008439

#: Mean USD of one transcription call over the 69 calls in the sample.
TRANSCRIPTION_USD_PER_CALL = 0.017218

#: Median embedding tokens a page becomes.
EMBEDDING_TOKENS_PER_PAGE = 977

#: Embedding price per 1000 tokens (0.13 USD per million).
EMBEDDING_USD_PER_1K_TOKENS = 0.00013

#: ``EMBEDDING_TOKENS_PER_PAGE`` priced: USD per page of vectors.
EMBEDDING_USD_PER_PAGE = EMBEDDING_TOKENS_PER_PAGE * EMBEDDING_USD_PER_1K_TOKENS / 1000

#: Median per-document remainder (the classification/decision call every file pays).
DOCUMENT_USD_PER_DOCUMENT = 0.000228

#: Median prompt tokens of one vision call (p10/50/90 = 1910/2993/5365).
VISION_PROMPT_TOKENS_PER_CALL = 2993

#: Median completion tokens of one vision call (p10/50/90 = 438/1012/2128).
VISION_COMPLETION_TOKENS_PER_CALL = 1012

#: ``upper_usd`` = ``expected_usd`` times this. 4 covered 90.0% of the sample's
#: documents; the per-call price tail (p90 = 6.8x the median) is what forces it.
UPPER_BOUND_MULTIPLIER = 4.0

#: Documents the constants above were fitted on.
CALIBRATION_SAMPLE_SIZE = 259

#: Fields named in ``IngestCostEstimate.missing_inputs``, in report order.
_FACT_FIELDS = ("page_count", "embedded_raster_sizes_px", "scanned_pages", "drawing_pages")


@dataclass(frozen=True, slots=True)
class PdfPreReadFacts:
    """What a pre-read can measure about a PDF without ingesting it.

    Every field is ``None`` when the pre-read could not measure it, and the
    estimate degrades rather than guesses. ``embedded_raster_sizes_px`` is the
    ``(width_px, height_px)`` of *every* embedded raster, small ones included;
    this module applies the ``MIN_RASTER_PX`` filter. Repeated rasters of one
    size are one entry's worth, matching the extractor's content-hash dedup only
    as far as dimensions can proxy for content.
    """

    page_count: int | None
    embedded_raster_sizes_px: tuple[tuple[int, int], ...] | None
    scanned_pages: int | None
    drawing_pages: int | None


@dataclass(frozen=True, slots=True)
class IngestCostEstimate:
    """What ingesting a PDF is expected to cost, and what it does not know.

    ``expected_usd`` and ``upper_usd`` are ``None`` when the dominant term —
    the vision calls — cannot be estimated at all (``embedded_raster_sizes_px``
    is ``None``); a number that ignores 81% of the bill is worse than no number.
    When ``is_coarse`` is ``True`` some input was missing and a zero was
    substituted: read ``missing_inputs`` and treat the dollars as a floor.
    """

    expected_usd: float | None
    upper_usd: float | None
    vision_calls: int
    transcription_calls: int
    embedding_tokens: int
    vision_prompt_tokens: int
    vision_completion_tokens: int
    is_coarse: bool
    missing_inputs: tuple[str, ...]


def _count(value: int | None) -> int:
    """A non-negative int from a measured count; ``None`` and negatives are 0.

    Accepts any ``numbers.Integral`` (a numpy or pandas count is still a count),
    so a caller that measures through a dataframe is not silently read as 0.
    """
    return max(0, int(value)) if isinstance(value, Integral) else 0


def _distinct_raster_sizes(sizes: tuple[tuple[int, int], ...]) -> int:
    """How many distinct px dimensions among the rasters big enough to analyse."""
    return len({(width, height) for width, height in sizes if width >= MIN_RASTER_PX and height >= MIN_RASTER_PX})


def estimate_ingest_cost(facts: PdfPreReadFacts) -> IngestCostEstimate:
    """Estimate the ingest bill for one PDF from its cheap pre-read facts.

    Pure and side-effect free: the same ``facts`` always give the same estimate,
    and nothing here reads a file or a model. See the module docstring for how
    each constant was fitted and how wide the spread is.
    """
    missing = tuple(name for name in _FACT_FIELDS if getattr(facts, name) is None)

    if facts.embedded_raster_sizes_px is None:
        # Vision is 81% of the bill; without it there is no estimate to give.
        return IngestCostEstimate(
            expected_usd=None,
            upper_usd=None,
            vision_calls=0,
            transcription_calls=_transcription_calls(facts),
            embedding_tokens=_embedding_tokens(facts),
            vision_prompt_tokens=0,
            vision_completion_tokens=0,
            is_coarse=True,
            missing_inputs=missing,
        )

    distinct = _distinct_raster_sizes(facts.embedded_raster_sizes_px)
    vision_calls = max(0, min(MAX_IMAGES_PER_DOCUMENT, distinct) - LOGO_IMAGE_ALLOWANCE)
    if distinct == 0:
        vision_calls += min(MAX_RENDERED_PAGES, _count(facts.drawing_pages))
    transcription_calls = _transcription_calls(facts)
    embedding_tokens = _embedding_tokens(facts)

    expected_usd = (
        vision_calls * VISION_USD_PER_CALL
        + transcription_calls * TRANSCRIPTION_USD_PER_CALL
        + _count(facts.page_count) * EMBEDDING_USD_PER_PAGE
        + DOCUMENT_USD_PER_DOCUMENT
    )
    return IngestCostEstimate(
        expected_usd=expected_usd,
        upper_usd=expected_usd * UPPER_BOUND_MULTIPLIER,
        vision_calls=vision_calls,
        transcription_calls=transcription_calls,
        embedding_tokens=embedding_tokens,
        vision_prompt_tokens=vision_calls * VISION_PROMPT_TOKENS_PER_CALL,
        vision_completion_tokens=vision_calls * VISION_COMPLETION_TOKENS_PER_CALL,
        is_coarse=bool(missing),
        missing_inputs=missing,
    )


def _transcription_calls(facts: PdfPreReadFacts) -> int:
    """Scanned and garbled pages, capped; 0 when the pre-read did not count them."""
    return min(MAX_OCR_PAGES, _count(facts.scanned_pages))


def _embedding_tokens(facts: PdfPreReadFacts) -> int:
    """The vectors the pages become; 0 when the page count is unknown."""
    return _count(facts.page_count) * EMBEDDING_TOKENS_PER_PAGE
