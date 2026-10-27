---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering; the extracted-text and data-mapping research reports of 2026-10-27
informed: everyone working on ingestion, the knowledge layer, object storage, erasure and Piloti's tools
---

# Extracted page text is stored per version, and the index is derived from it

## Context and Problem Statement

Ingestion already extracts every PDF page's text, then throws it away.
`_extract_text_from_pdf` builds one record per page (`text`, `tables`,
`table_boxes`, `line_styles`) with pdfplumber, and pypdfium2 for dense pages
(`sources/knowledge_layer/src/llamaindex/adapter.py`). The paid steps also produce
page text: the vision model's transcription of scans ($0.00067 a page, measured
2026-09-29 in [`visual-ingestion.md`](../architecture/visual-ingestion.md)) and its
readings of drawings. All of it lives in one ingest job's memory and is gone once
the chunks are written. No ADR decided that. The only place the repo names a page
store is a roadmap row ([`agent-tool-surface.md`](../architecture/agent-tool-surface.md)
§5 row 4).

So the only extracted text is the Qdrant chunk payload, and every reader rebuilds
pages from it. Measured in the code on 2026-10-27:

- Section chunks start with a heading breadcrumb that is not in the document, and
  overlap by 96 tokens **across page breaks**. Only the start and end page are
  stored, so where page 4 begins inside a chunk is lost.
- De-overlap is a word-matching heuristic (`read_passage._without_overlap`) that
  refuses chunks written before `chunk_ordinal` existed.
- An uncaptioned table is both a `[TABLE from page N]` chunk and garbled text in its
  page, so a rebuilt page can show it twice.
- Only the published version is indexed, and a re-upload retires the previous
  version's chunks (`_retire_previous_version`), so an older Fassung has no text
  anywhere. Moving a document across a restricted-folder boundary purges its chunks
  before re-reading it
  ([ADR-0087](0087-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md)),
  so for minutes it has none.
- Every re-chunk is a re-parse. `reindexProject`, the restricted-folder re-ingest and
  a quarantine release all re-dispatch the original bytes, and the vision model's
  replies survive only in a 30-day Dragonfly cache (`llamaindex/processing.py`).

[ADR-0133](0133-piloti-reads-the-estate-through-standard-filesystem-tools.md) gives
Piloti `read_file` and `grep` over the office's documents. A page-addressed read and
an exact count both need the page as the document has it.

## Decision Drivers

* **The parse is the expensive, non-deterministic step; chunking and embedding are
  cheap.** Azure AI Search keeps "the output from document cracking" so that "only
  changed skills and documents require reprocessing", because "the costs of storage
  are less than image extraction and AI processing" (Manage Enrichment Caching,
  ms.date 2026-07-07).
* **Systems that cite pages keep the page text the index was cut from.** Azure
  Document Intelligence returns one `content` string with `<!-- PageBreak -->` markers
  and spans into it (ms.date 2026-05-01). LlamaParse returns per-page Markdown and says
  "Download results you need to keep as soon as a job completes" (accessed
  2026-10-27). Bedrock Knowledge Bases writes parser output to a customer S3 location
  that must be set at creation (accessed 2026-10-27). OpenAI vector stores serve "the
  parsed contents of a vector store file" (accessed 2026-10-27). Anthropic Citations
  guarantee "valid pointers" because `cited_text` is extracted from the document
  (accessed 2026-10-27).
* **An index may propose; text decides.** Zoekt searches trigram candidates "for the
  regular expression" in the stored contents, and Cursor loads every candidate and
  matches it "the old fashioned way" (2026-03-23). For us the exact thing behind the
  index has to be the page: a chunk carries a breadcrumb (a false hit) and an overlap
  (a double count).
* **Vercel keeps "raw inputs in one place, processed outputs in structured
  directories"**, PDFs beside their extracted text, so "the agent can reference
  previous analysis without reprocessing" (2026-01-09).
* **Erasure and privacy must not grow a new path.** Text is the most disclosing
  derivative a document has.

## Considered Options

* **(A) Rebuild pages from the chunks**, as the readers do today.
* **(B) Store the page text at ingestion**, per version, beside the original in
  SeaweedFS.
* **(C) Store a parsed representation** (Docling's `DoclingDocument` JSON, or a
  similar layout tree with boxes).
* **Parse on demand** at read time, cached.
* **One Qdrant point per page** (`kind=page`).
* **A Postgres table** of page texts under row-level security.

## Decision Outcome

Chosen option: "(B) Store the page text at ingestion", because the pipeline already
computes it, storing it costs less than the index already holds, the erasure path for
derivatives exists, and it turns a chunker change, a restricted move or an embedding
swap into re-chunking and re-embedding with no model calls.

What it decides:

1. **Where.** One derivative per document version, under the version's own storage
   directory, in the family of `_thumb.jpg`, `_render.pdf`, `_img/` and `_bim/`:

   ```
   …/v<n>/_text/pages.md      the pages in order, each opened by <!-- page N -->
   …/v<n>/_text/index.json    per page: byte offset and length, line count,
                              source (text_layer | ocr | vlm_reading), model id when
                              a model made it; per file: reader_version,
                              content_hash of the original, page_count, failed_pages
   ```

   Storage keys are per version since [ADR-0054](0054-document-versions-and-the-publish-door.md)
   and are never rewritten on a rename or move, so a restricted move leaves the text
   where it is.
2. **What a page holds.** What the page is, not what a chunk needs: no breadcrumbs, no
   overlap, tables once and inline at their position, running headers and footers
   stripped (and recorded as stripped). A drawing page holds the vision model's reading,
   marked `vlm_reading`, with `drawing_data` beside it.
3. **When.** At the screening gate
   ([ADR-0086](0086-uploads-are-screened-locally-and-matches-wait-in-quarantine.md)),
   with the chunks: after the screen passes. A held file gets no `_text/`, because a
   match must not become a readable copy. A release re-dispatches as today and writes
   it then.
4. **How it is written.** Through a BFF presigned PUT, as the rasters are: the Python
   tier keeps its read-only credential.
5. **Qdrant is derived.** It serves ranking and is `grep`'s pre-filter: `MatchText`
   proposes candidate pages, the regex decides on the stored page. Ideally the chunkers
   read the stored pages, so every chunk is a substring of a page (plus its declared
   breadcrumb) and both carry the reader and chunker versions.
6. **How it is read.** Never from a model-supplied path. A reader resolves document →
   version → storage key through the turn's scoped lookup (ADR-0133).
7. **Fallback.** Until a document is backfilled, readers rebuild from chunks (A) and say
   so in the read header.
8. **Page-less formats.** txt, md and csv keep being read from their original bytes,
   which have real lines. xlsx, html, email and epub may later get a `_text/` with
   sections instead of pages; MarkItDown is the candidate there, and only there.

### Consequences

* Good, because `read_file(pages="4")` returns page 4 as the document has it, and a
  grep count counts the document, not its chunks.
* Good, because every version has text, including Fassungen whose chunks were retired,
  so reading an older Fassung and a text diff between versions need no index entry per
  version, and the ADR-0054 question of indexing old versions stays closed.
* Good, because a chunker change, a restricted move or an embedding-model swap no longer
  pays the vision model again after the cache's 30 days.
* Good, because it is small. A dense German page is about 3 KB of UTF-8 (about 1 KB
  gzipped); 100,000 pages are about 300 MB. Qdrant already holds roughly 2.3× the text
  (`text` and `text_stem`, plus overlap and breadcrumbs). Estimates, not measurements:
  the repo holds no production counts.
* Bad, because it is a second copy of the text, and two copies can drift: one reader
  version writes the pages, another chunker version cuts the chunks, and a `read_file`
  page and a search hit could word the same page differently. That is the strongest
  argument against, and it is the reason Mintlify keeps one copy (2026-03-24). The
  answer is to make the stored pages the chunker's input rather than a parallel output,
  stamp both versions, and test that every chunk is a substring of its pages. Built as a
  side output instead, the objection stands.
* Bad, because erasure gains a derived name: `_text` joins
  `RESERVED_DERIVED_SEGMENTS` (`frontends/ui/src/lib/s3.ts`) and `deleteDerivedObjects`
  (`frontends/ui/src/lib/documents/object-cleanup.ts`), with a test. The project purge
  sweeps the whole prefix and re-checks legal holds per step
  ([ADR-0011](0011-deletion-pipeline.md)), so it already covers it. A session discard is a
  prefix delete of the session's uploads and covers it too.
* Bad, because the read-only SeaweedFS credential can read every key, so the scoped lookup
  is the boundary and needs its own test, not a convention.
* Neutral: zero data retention
  ([ADR-0074](0074-zero-data-retention-is-the-default-enforced-at-one-seam.md)) concerns
  model providers keeping prompts. Our extraction in our tenant bucket does not touch it,
  and Qdrant already holds the same readings.
* Neutral: an older version's text exists only from the day this lands, or from its
  backfill. Its text layer is free to re-read; its vision pages are paid for or left out.

### Confirmation

None of these exists yet; each lands with the slice that needs it, and until then review
is the only gate.

* A test that every chunk's body is a substring of a stored page, run over the realistic
  fixture (ADR-0133 slice 0).
* `object-cleanup` tests that erasing a document removes its `_text/`, and that a held
  file has none.
* A test that a `read_file` for a document outside the turn's scope returns "no such
  file", whatever path or key the model supplies.
* A test that `index.json`'s offsets slice `pages.md` into exactly `page_count` pages.

## Pros and Cons of the Options

### (A) Rebuild from the chunks

* Good, because there is no second copy and nothing to backfill. Mintlify ships exactly
  this for its docs assistant (2026-03-24).
* Bad, because the rebuild is lossy here. Premise: section chunks overlap across page
  breaks and carry breadcrumbs, legacy chunks lack `chunk_ordinal`, and older Fassungen
  have no chunks. Mintlify's source is Markdown, where cutting is lossless; its post does
  not discuss overlap or stored text at all.

### (B) Store page text (chosen)

* Good, because it is the text we already compute, in the shape the citation key needs.
* Bad, because of the drift risk and the erasure line above.

### (C) A parsed representation (Docling JSON or similar)

* Good, because Docling's `DoclingDocument` is lossless, with page and box provenance per
  item, and Markdown is only its lossy export (docling-core 2.104.0, 2026-10-22).
* Bad, because adopting the format means adopting a parser, and Docling's engine brings
  torch, layout models and a C++ parser into the image. Premise: our parser is pdfplumber
  plus pypdfium2 and yields pages and line styles, not a layout tree. This is the later
  parser question, measured by diffing a candidate's pages against the stored ones before
  switching.

### Parse on demand

* Good, because nothing new is persisted.
* Bad, because the vision pages cost money and are non-deterministic, so the agent could
  read different text from what was indexed, and cache eviction makes reads unstable.
  Fine for txt, md and csv, which are already served from their bytes.

### One Qdrant point per page

* Good, because there is no new store.
* Bad, because Qdrant is the derivative we want to rebuild freely. Premise: a restricted
  move purges a document's points, and an embedding swap rebuilds the collection, so the
  text would go with them. Every ranked query would also have to filter out `kind=page`.

### A Postgres table

* Good, because a foreign-key cascade deletes it, row-level security guards it, and
  `pg_trgm` can index a regex, which would make it an exact grep engine.
* Bad, because it is a new tenant table (migration, policy, `db:test:rls`, an internal
  write route under ADR-0055) and grows the pooled, backed-up database
  ([ADR-0083](0083-postgres-connections-go-through-a-transaction-pooler.md)). Kept as the
  grep engine to reach for if Qdrant's pre-filter proves too coarse, not as the store of
  record.

## More Information

**Backfill without vision spend.** (1) Re-run the text layer only: pdfplumber and
pypdfium2 are CPU-only and deterministic for the same bytes and the same
`INGEST_READER_VERSION`. (2) For pages a model made, take the text from the existing
chunks (a drawing segment is one chunk, with `drawing_data` in the payload), else from the
Dragonfly cache. (3) Write `_text/` and leave Qdrant alone.

**The parser.** MarkItDown 0.1.9 (PyPI, 2026-10-21, MIT) was evaluated. Its PDF converter
is pdfplumber and pdfminer.six, the same base as ours, with no page markers (pages joined
by a blank line or a form feed), no OCR without a plugin or Azure, and DOCX with no pages
at all. It is worse than our path for PDFs and plausible only for page-less formats.
`markitdown-mcp` reads with the process's privileges and does not belong on the agent
door. PyMuPDF4LLM yields per-page chunks but is AGPL-3.0 or commercial, which blocks it
for a hosted service without a licence. LlamaParse would be a new processor of tenant
files, with the data-processing, region and zero-retention questions to solve again.

**The ingestion work stream** received the short form of decisions 1 to 6 on 2026-10-27.
This record is the decision of record.

**Revisit when:** a measurement on real office documents (the slice-0 fixture through the
real section chunker) shows rebuilt pages match the text layer within a tolerable error
*and* the product decides older Fassungen and restricted moves never need text; or a
parser swap is on the table (then C is decided on its own merits); or grep's pre-filter
misses matches the stored pages hold (then the Postgres option becomes the grep engine).
