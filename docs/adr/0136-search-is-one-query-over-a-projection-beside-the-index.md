---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering; Planfred's published feature pages
informed: everyone touching documents, annotations, folders or conversations
---

# Search is one query over a projection beside the index: the dossier's facts are filtered where authorization lives

## Context and Problem Statement

The product owner asked for "a global lookup which looks into all files in every
shelf ... very advanced filter and search that allows you to really find every
document you can imagine ... DRY, and it should also work inside one project",
and then for it to "work across literally everything", collaboration included.

Ingestion now writes, per document, a dossier (type, parties, dates, place,
facts with page and quote), `doc_references` and `coverage`, beside the Plankopf
facts, capture, tags, topics and Fassung links
([`document-dossier.md`](../architecture/document-dossier.md)). They live in the
agent database (`document_metadata`, TEXT JSON, keyed by collection and file
name). The BFF reads them per collection from `/v1/collections/{c}/documents`
and merges them onto listing rows after the page is cut.

Authorization lives in the BFF's Postgres: the shelf, closed projects
(ADR-0090), hidden and restricted folders (ADR-0087, ADR-0088), uploads held in
screening (ADR-0086). Content lives in Qdrant (ADR-0115, ADR-0116).

Searching today is three partial paths: the listing's name filter (`q`, one
shelf), the document-centric semantic search (`POST /api/documents/search`, one
shelf), and the agent's cross-project lookup (ADR-0094, chat audience). None
filters on what a document is.

## Decision Drivers

* **Exact authorization, counts included.** A facet count over documents the
  reader may not open names their existence.
* **One implementation for every scope and every client** (ADR-0055, ADR-0122,
  the product owner's "DRY").
* **Bounded and fast across many offices.** No per-document call to the backend,
  no unbounded list.
* **Derived data stays derived.** The dossier is ingestion's output; nothing a
  person writes lives in a copy.

## Considered Options

* **Filter in the agent database.** It holds the dossier. But it knows nothing of
  folders' access, held uploads or closed projects: the BFF would send it every
  readable document id (thousands per office), and its counts would be over rows
  the BFF then drops.
* **Filter in Qdrant.** Since commit 1693fcd0d every chunk carries its
  document's `document_type`, `references`, `dossier_facts`, `parties` and
  `pages_not_read` as indexed payload, mirrored by filter with `set_payload`.
  Good for narrowing a content query. It cannot own the result set:
  - its facet API counts points, approximately and ten values by default, so a
    300-chunk document counts 300
    ([Qdrant, facet counts](https://qdrant.tech/documentation/manage-data/payload/), read 2026-10-27);
  - grouped results cannot be paged: a fused `query_points_groups` interleaves
    groups by round on the pinned 1.19.2 (`qdrant/search.py`, measured), so the
    backend groups a 200-passage candidate budget in code, with no total and no
    cursor;
  - `order_by` needs a numeric or datetime index and switches paging off
    ([Qdrant, points](https://qdrant.tech/documentation/manage-data/points/), read 2026-10-27),
    so no register sorted by plan number;
  - `dossier_facts` is a keyword, so no numeric range on a fact;
  - failed, held, quarantined, archived and binned documents have no chunks
    (ADR-0086, ADR-0104, ADR-0092), and uploader, upload date, status, file type,
    Plannummer and Index are not on the payload.
* **Filter after the page.** Read the listing, merge the metadata, filter in
  memory. Exactly the per-shelf cap the listing has (500 a page), and wrong
  counts.
* **A projection in the BFF database.** One row per document
  (`document_search_facets`) holding the filterable facts, keyed by document id,
  joined to `documents` in the query that applies authorization; refreshed per
  shelf from the listing the BFF already reads.

## Decision Outcome

Chosen option: "A projection in the BFF database", with Qdrant ranking content
inside it: Postgres decides which documents are in a result, Qdrant only ranks
their passages. Authorization, filters, sort, paging, facet counts and the
collaboration kinds have to be answered in the BFF anyway; a second engine on
that path would add a store without removing one.

1. **`document_search_facets`** (migration 0185) holds, per document: type,
   tags, topics, title, summary, parties, place, facts (text and numeric),
   references as `kind:key` tokens (the payload's own tokens), Plankopf facts,
   capture, page count, pages not read, whether a newer Fassung replaces it, a
   full-text vector, and the fingerprint of what it was built from. Tenant table
   under `grid_secure_table`. It is never authored: each row is replaced whole.
2. **A row is written when its document settles.** The status reconciliation
   already parses the reading (`extractMetadata` in `reconcile-status.ts`) when a
   row comes to rest; the projection row is upserted there. A person's edit of
   what a row derives (tags, topics, a Fassung link) rewrites it in the service
   that wrote the edit (`lib/search/refresh-rows.ts`), never failing the edit.
   A per-shelf job
   (`search_facets_sync`) is the backstop: a search that finds a shelf's
   fingerprint (count and newest change of its documents) moved since its last
   sync queues one refresh, at most one per shelf per ten minutes, the pattern
   `office_conventions` uses. Sync state per shelf is `document_search_shelves`.
3. **The projector fails closed.** The collection listing answers 200 without
   the reading when the agent's metadata store errors; a row whose listing entry
   carries no reading is left as it is, never blanked.
4. **One core** (`lib/search`): the query model, the reach (computed once per
   search from the listing's own gates), and one provider per kind (document,
   annotation, folder, project, conversation). Scope is a parameter. The route
   `POST /api/search` and the operation `search` are thin over it.
5. **Content** is the backend's grouped hybrid search over the reach's
   collections, pre-filtered for recall: `grid_document_id` in the SQL
   candidates when they are few (up to 1,000), else the payload's
   `document_type`, `references` and `dossier_facts` conditions. Hits are
   joined back to rows by `grid_document_id`. A Qdrant number is never shown:
   counts are counts of the joined SQL set, "at least N" when the candidate
   budget was reached.
6. **Cross-document findings** (contradiction, missing plan or document) are not
   projected: they depend on which documents the reader may see. In a project
   they come from `getProjectDocumentFindings` for the reader; the projection
   carries only the document's own `incomplete_read`.

### Consequences

* Good, because every filter, sort and count is over exactly what the listing
  would show this reader, in one statement.
* Good, because the UI, Piloti and outside agents run one search.
* Bad, because a projection can lag: written when a document settles, it misses
  a fact changed later on the agent side (a person's tags, a Fassung link) until
  the shelf's backstop refresh. The answer names the shelves still being built.
* Bad, because a second copy of the dossier's filterable part exists. It is
  replaced whole and fingerprinted, so it cannot drift silently.
* Bad, because two filter compilers exist (SQL for membership, the payload
  pre-filter for recall). The pre-filter only ever narrows what SQL already
  decides, so a disagreement costs recall, never visibility.

### Confirmation

* `lib/search/*.spec.ts`: the query model, the projector's mapping, the SQL
  builder's predicates and the providers' reach.
* `rls-coverage.spec.ts` lists both tables; `task db:test:rls`.
* `document-visibility.spec.ts` covers the new queries over `documents`.
