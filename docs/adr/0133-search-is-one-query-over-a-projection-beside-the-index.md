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
* **Filter in Qdrant.** Put the dossier on every chunk's payload. Every fact
  repeated on every passage, a re-upsert of all chunks when a fact changes, and
  still no document-level count or sort.
* **Filter after the page.** Read the listing, merge the metadata, filter in
  memory. Exactly the per-shelf cap the listing has (500 a page), and wrong
  counts.
* **A projection in the BFF database.** One row per document
  (`document_search_facets`) holding the filterable facts, keyed by document id,
  joined to `documents` in the query that applies authorization; refreshed per
  shelf from the listing the BFF already reads.

## Decision Outcome

Chosen option: "A projection in the BFF database", because it is the only one
where the filter, the sort, the facet counts and the authorization are the same
SQL statement.

1. **`document_search_facets`** (migration 0185) holds, per document: type,
   tags, topics, title, summary, parties, place, facts (text and numeric),
   references as `kind:key` tokens, Plankopf facts, capture, page count, pages
   not read, whether a newer Fassung replaces it, a full-text vector, and the
   fingerprint of what it was built from. Tenant table under
   `grid_secure_table`. It is never authored: the projector replaces each row
   whole.
2. **`document_search_shelves`** holds per shelf when it was synced, from which
   fingerprint, and when a refresh was last queued.
3. **The projector** (`lib/search/facets-projector.ts`) runs as the BFF job
   `search_facets_sync`, one shelf per job, as the system: it decides nothing
   about who reads what. It reads the shelf's rows and the collection listings,
   maps them with the listing's own parsers (`parseDossier`,
   `parseRevisionFacts`, `parsePhotoCapture`), upserts changed rows and deletes
   rows of documents that left the shelf.
4. **Staleness is noticed by a search**, as `office_conventions` notices it: a
   shelf whose fingerprint (count and newest `updated_at` of its documents)
   differs from its sync, or whose sync is older than an hour, gets one refresh
   queued, at most one per shelf per ten minutes.
5. **One core** (`lib/search`): the query model, the reach (computed once per
   search from the listing's own gates), and one provider per kind (document,
   annotation, folder, project, conversation). Scope is a parameter. The route
   `POST /api/search` and the operation `search` are thin over it.
6. **Content** is the backend's grouped hybrid search over the reach's
   collections, joined back to rows by collection and file name
   (`joinHitsToFiles`' rule); the structured filters then apply in SQL to the
   joined ids.
7. **Cross-document findings** (contradiction, missing plan or document) are not
   projected: they depend on which documents the reader may see. In a project
   they come from `getProjectDocumentFindings` for the reader; the projection
   carries only the document's own `incomplete_read`.

### Consequences

* Good, because every filter, sort and count is over exactly what the listing
  would show this reader, in one statement.
* Good, because the UI, Piloti and outside agents run one search.
* Bad, because the projection lags ingestion by up to one job: a document read
  a moment ago is found by name and content at once, by its facts after the
  refresh. The answer names the shelves still being built.
* Bad, because a second copy of the dossier's filterable part exists. It is
  replaced whole and fingerprinted, so it cannot drift silently.
* Neutral: content recall under a very selective filter depends on the content
  search's candidate budget; pushing the filtered file names into Qdrant is the
  next slice.

### Confirmation

* `lib/search/*.spec.ts`: the query model, the projector's mapping, the SQL
  builder's predicates and the providers' reach.
* `rls-coverage.spec.ts` lists both tables; `task db:test:rls`.
* `document-visibility.spec.ts` covers the new queries over `documents`.
