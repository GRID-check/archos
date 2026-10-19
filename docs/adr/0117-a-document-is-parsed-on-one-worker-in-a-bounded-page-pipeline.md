---
status: proposed
date: 2026-10-18
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A document is parsed on one worker, in a bounded page pipeline

## Context and Problem Statement

One document has been one queue row, one claim, one worker, one serial pass since
ADR-0076: `_ingest_job` walks every file, and inside a file the stages run one
after another — text extraction, table extraction, the upload screen, page
routing, the thumbnail, the vision batch, the summary and tags, embeddings, the
upsert. Prod measures a median job wall time of 138 s, a mean of 154 s and a
maximum of 427 s; a 133-page, 17.7 MB PDF spends about 103 s in the pdfplumber
text pass and another 125 s in the pdfplumber table pass before the first model
call leaves the pod. The ingest pods run at about one busy core of four.

The tier scales out, but each unit of scale is a whole document and each unit
occupies a single core at a time. Two OOM kills in the visual-analysis phase show
the other edge of the same design: whatever the pipeline holds, it holds for the
whole document, because `render_visual_pages_no_vlm` (processing.py:323) renders
every visual page and `_embedded_images_for_analysis` (adapter.py:1078) decodes
every embedded raster into memory before the first vision call is made
(`enrich_vlm_batch`, processing.py:417). Rendering and vision never overlap, and
nothing bounds how much image data is in flight for a long document.

The product has to serve thousands of offices on this path, so ingestion has to
get faster and keep scaling out, without ever buying speed with a killed pod.

## Decision Drivers

* One document stays one queue row, one claim and one worker. Fair claiming
  (ADR-0076), the lost-claim guard and the deleted-document guard all assume a
  claim names exactly one worker for the whole document.
* Ingestion must be incapable of OOM: peak memory is a function of a fixed
  working set, never of document length or page count.
* Wall time per document should approach the longer of its local CPU work and
  its provider-bound work, not their sum.
* The provider ceiling is fixed: `AIQ_VLM_FLEET_CONCURRENCY` (adapter.py:376)
  and the deploy assertion
  `maxReplicas × perPodConcurrency × AIQ_VLM_BATCH_WORKERS <= 2 × fleetConcurrency`
  (deploy/pulumi/src/config.ts:3288) must keep holding.
* The change lands in slices that are individually shippable and individually
  measurable, because the failing signal (a slow job, a killed pod) is otherwise
  unattributable.

## Considered Options

1. Do nothing; raise replicas and workers.
2. A bounded per-document page pipeline inside the worker: overlap local CPU
   (extract, screen, render) with the provider-bound vision calls, over a
   bounded window of pages, so peak memory is the window and not the document.
3. Process-per-document: fork or spawn a child per document and let the OS
   schedule it, with the parent holding the claim.
4. Shrink the PDFium critical section only (`pdfium_lock.py:40`), so the four
   worker threads stop serialising on rendering.

## Decision Outcome

Chosen option 2, because it is the only one that changes the shape of the work
one document does — turning a serial chain of stages into an overlapped pipeline
— while leaving the claim model, the guards and the provider ceiling exactly as
they are.

* **The unit of parallelism inside a job is a window of pages, not the
  document.** A fixed-size window (start at
  `AIQ_INGEST_PAGE_WINDOW`, default 8) is extracted, screened, rendered and
  vision-analysed; a page leaves the window as soon as its outputs (text
  documents, table documents, caption, raster bytes) are materialised into the
  per-file `all_documents` list, which is the same list the serial code builds
  today. Nothing downstream of the window holds page pixels.
* **Local CPU and the provider run at the same time.** A small extractor pool
  (one thread; pdfplumber is GIL-bound and a second text pass buys nothing) fills
  the window while the existing `VLM_BATCH_WORKERS` vision pool
  (processing.py:483) drains it. On the measured 133-page PDF this turns
  `103 s + 125 s + (vision)` into roughly `max(228 s, vision)` plus one window
  of head, which is the whole point.
* **The existing seams stay the seams.** `_extract_text_from_pdf`
  (adapter.py:1308) and `_extract_tables_from_pdf` (adapter.py:1118) already read
  one page at a time internally; `render_visual_pages_no_vlm` (processing.py:323)
  already takes `only_pages`; `enrich_vlm_batch` (processing.py:417) already takes
  two lists. The pipeline changes who calls them and in what order, not what they
  do.
* **PDFium stays one lock.** Rendering remains serialised per process
  (`pdfium_lock.py:40`), because pypdfium2 is not thread-safe. The pipeline
  overlaps rendering with *vision*, which does not hold the lock, and with
  pdfplumber, which does not use PDFium at all. Option 3 was rejected because it
  buys at most the GIL's worth of extra text throughput while duplicating the
  process-wide singletons the job depends on — the Qdrant client
  (qdrant/store.py) and the cost tracker's flush executor
  (cost_tracking.py:79) — and making the cost ContextVar
  (`grid_cost_tracker_var`, cost_tracking.py:611), the heartbeat owner
  (`ingest_status_store.py:91`) and the VLM slot holder
  (`lease_slots.hold`, lease_slots.py:221) cross a process boundary. Option 4 was
  rejected as insufficient on its own: it does not overlap the two pdfplumber
  passes that dominate the measurement, and it does not bound memory.

### Consequences

* Good, because peak memory becomes `page_window × per_page_working_set` plus the
  accumulated plain-text documents, and stops growing with page count or image
  count. The two OOM kills sit in the phases this bounds.
* Good, because the two heaviest measured stages (103 s text, 125 s tables) and
  the vision phase stop being additive. The expected win is bounded by the vision
  time and by the one window of head, and is only realised on documents with both
  a long text pass and visual pages.
* Good, because fair claiming, the lost-claim guard, the deleted-document guard,
  the claim heartbeat and the provider ceiling are untouched: the claim still
  names one worker for one document.
* Bad, because the pipeline is materially more complex than the current straight
  line, and the failure modes move: an exception raised by the extractor thread
  must fail the file the way `_vlm_slot` failures do today, not deadlock the
  window.
* Bad, because the per-file `all_documents` list still grows with page count
  (chunk documents and captions are small, but a 400-page drawing set is still
  400 caption documents in one list). This bounds pixels, not metadata.
* Neutral: the summary and tag calls already start after visual extraction on
  purpose (adapter.py:4584) so a text-sparse drawing set feeds its captions, not
  a watermark, to the summary. The pipeline preserves that ordering by draining
  the vision phase before starting them, as today.
* Neutral: the sibling bounded-ingest change (`[ingest-mem]` log lines,
  `rasters:start kept= over_cap=`, `rasters:done kept=`) already caps rasters
  after decode; this decision bounds the window before decode and does not
  replace it. Where the two overlap, the cap wins and the window shrinks the
  amount that reaches it.

### Confirmation

* The bounded window and the overlap: a test that feeds a synthetic many-page PDF
  through `_ingest_job` and asserts peak retained raster bytes (the measurement
  the sibling change's `[ingest-mem]` lines expose) stays under
  `page_window × max_raster`, and that the vision pool sees its first page while
  the extractor pool is still working on a later one.
* The claim model: `tests/knowledge_layer_tests/test_ingest_queue.py` and the
  lost-claim tests keep passing unchanged — the pipeline must not alter how many
  claims a job holds.
* The provider ceiling: `deploy/pulumi/src/app/ingest-worker.spec.ts` reads the
  Python sources, so if the pipeline introduces a second vision concurrency
  constant that is not the asserted one, that spec fails.
* The cost ledger and the trace: a test that the pipeline's vision calls still
  land on the job's tracker. Today that depends on `submit_in_context`
  (cost_tracking.py:816) and `contextvars.copy_context().run`
  (processing.py:490); the pipeline must submit extractor work the same way or
  the `[ingest-mem]`-era cost tests fail.
* Nothing yet enforces the *expected speed*; the answer suite and the ingest
  wall-time metric are the only signals, and the gap is named under More
  Information.

## Pros and Cons of the Options

### Option 2: bounded per-document page pipeline

* Good, because it is the only option that both overlaps the measured CPU stages
  with the provider and makes memory a function of a constant.
* Good, because it reuses the page-at-a-time seams that already exist, and
  leaves the claim and provider contracts alone.
* Bad, because it is the most code of the four and moves the error-handling
  burden into the window's coordination.

### Option 1: do nothing

* Good, because it costs nothing and is already correct.
* Bad, because it fixes neither the additive CPU cost nor the memory growth, and
  the measured job times stay where they are.

### Option 3: process-per-document

* Good, because it sidesteps the GIL for pdfplumber and isolates a crash to one
  child.
* Bad, because it duplicates or shares the Qdrant client and the usage-flush
  executor, loses the cost ContextVar at the boundary, and forces the heartbeat
  owner and the VLM slot holder to span two processes — all the risk the
  checkpoint lists, for a win the pipeline gets inside the process.

### Option 4: shrink the PDFium critical section only

* Good, because it is small and local.
* Bad, because it does not overlap the two pdfplumber passes, which are the
  measured bottleneck, and does not bound memory.

## More Information

* **Measured after this record was written (2026-10-19): the text pass was not
  page-bounded.** "`_extract_text_from_pdf` already reads one page at a time"
  held for the control flow, not for memory: pdfplumber caches each page's
  parsed objects until `Page.close()`, and no page was closed, so the pass held
  the whole document (77 MiB per CAD sheet of 20 000 paths, 3.3 GiB for 40).
  Two plan collections OOM-killed a 12 GiB worker there, before any raster was
  touched. Closing each page, and reading a page over `AIQ_PDF_PAGE_MAX_OBJECTS`
  with PDFium instead of pdfplumber, made the pass flat (366 MiB for the same
  40 sheets). Any window this record builds must keep that property: a page
  leaves pdfplumber closed, or the window bounds nothing.

* Revisit when ingest wall time p95 stops improving under the window, or when the
  fleet's vision calls already saturate `AIQ_VLM_FLEET_CONCURRENCY` — at that
  point the pipeline's win is CPU-only and the next lever is the provider, not
  the pipeline.
* The open follow-ups, to be measured rather than assumed: how much of the 103 s
  text pass and 125 s table pass is actually per-page independent (a page's table
  extraction depends on `taken`, the text pass's table boxes, so the two passes
  may not fully overlap without a combined single pass); whether one extractor
  thread is enough or the GIL yields enough during pdfplumber to justify two;
  and whether the summary/tags phase, not the extract phase, is the real tail on
  documents with few visual pages.
* Related: ADR-0076 (fair claim, heartbeat, provider ceiling),
  ADR-0079 (the shared claim implementation),
  ADR-0081 (the priority classes the limiter already carries).
