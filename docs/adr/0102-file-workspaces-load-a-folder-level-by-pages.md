---
status: proposed
date: 2026-10-12
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# File workspaces load a folder level by pages

## Context and Problem Statement

A customer's Büroablage holds more than 2 000 documents in its root folder,
and project shelves get close to that. The Files workspace (Dateien and the
Büroablage, one component since ADR-0078) drained the whole shelf into the
browser before it could draw one folder: `GET /api/documents` and
`GET /api/archiv/documents` were read page after page (500 rows each, up to 20
pages), every page was hydrated against the backend (status reconcile,
Fassung facts, assignees, version summaries), and the browser then filtered,
sorted, searched and counted it. PR #1009 made drawing that list cheaper. It
did not change that opening the Büroablage downloads and hydrates the whole
shelf. The product owner asked for real server paging with infinite scroll.

## Decision Drivers

* Opening a folder costs one page of that folder, whatever the shelf holds.
* The listing routes have four other readers that drain them (surfaced
  documents, the knowledge panel, document roles, the project inventory);
  their answer must not change.
* Every query over `documents` composes `documentVisibleTo` (ADR-0086), and
  every list is bounded.
* No feature is lost: the brief, the folder tiles, search, filters, sorting,
  drag and drop, the upload plan and deep links keep working.

## Considered Options

* Keep draining, and render only what is visible (PR #1009 alone).
* Page one folder level on the server; count the shelf with a separate
  aggregate; drain the shelf only for what the server cannot answer.
* Page on the server and move every filter, the brief and the Fassung rule to
  Postgres.

## Decision Outcome

Chosen option: "page one folder level on the server", because it removes the
drain from the default view now, with the data Postgres already holds, and
keeps the drain as an explicit fallback for the parts that need data Postgres
does not hold.

**The level read.** The two listing routes take optional level parameters:
`folderId` (a uuid, or `root`), `sort` (`added`, `name`, `size`), `dir`, `q`
(a case-insensitive substring of the file name or the rename), `state`
(read-state families) and `limit` (default 100, clamped to 1..500). Any of them
makes the request a level read: one folder level, or the whole shelf filtered
by `q` when `folderId` is absent, in that order with the id as an ascending
tiebreak, a page at a time. Its cursor carries the order it was read in and the
last row's sort key as Postgres wrote it, and is refused under another order.
Without level parameters the request is the shelf drain, byte for byte as
before. Migration 0132 indexes both shelves by `(…shelf, folder_id,
created_at DESC, id)`.

**The shelf summary.** `GET /api/documents/summary` and
`GET /api/archiv/documents/summary` count every document of the shelf the
reader may see, per folder and read-state family (the families of
`document-status.ts`, so the badge and the brief agree), with the newest date
and the failed documents (up to 1 000) for „Alle erneut lesen“. The browser
folds the rows up its folder tree, so walking the tree asks nothing. The folder
tiles, the header count, the brief's headline, „Hier sind Sie gefragt“ and „Wo
es hakt“ read it.

**One document by id.** `GET /api/documents/[id]` answers the row a listing
would carry, for a link (`?doc=`, `?compare=`) to a document no loaded page
holds. The Archiv's model stage resolves its file by name the same way.

**What still drains the shelf, and why.** The filters that read what the
backend put on a document (kind, tags), its assignees or its version state
(„Freigabe ausstehend“), and the status order, because Postgres does not hold
those facts in the documents table; and the brief's content facts (document
types, disciplines, topics, contents, photos, „ohne Dokumentart“, pages) and
its slices, which the reader asks for by opening them. The drain is the same
`useFileListing` as before, turned on only for these.

### Consequences

* Good, because the default view of a folder reads one page of it, and a page
  is a range read on an index.
* Good, because the drain's readers are untouched, and the paged read and the
  drain share one WHERE (`listingWhere`), so they cannot disagree about which
  rows a reader may see.
* Bad, because older Fassungen are hidden per loaded page, not per level:
  which document replaces which is a link in the backend's index (ADR-0099),
  not a column. An older Fassung whose newer one is on a later page shows until
  that page loads, and the summary counts older Fassungen.
* Bad, because the name search matches file names and renames only; the
  content (summary, tags, topics, older names) is the semantic search's (Enter).
* Bad, because the summary reads `documents.status` as stored. A row still
  `pending` in Postgres after its job finished counts as being read until the
  upload sweep or a page holding it reconciles it.
* Bad, because the brief's content facts and its slices cost the old drain
  when the reader asks for them.

### Confirmation

* `list-page.integration.spec.ts` walks every order of a level against
  Postgres' own ORDER BY and checks folder scoping and the hold.
* `document-visibility.spec.ts` fails for a new query over `documents` that
  does not compose `documentVisibleTo`.
* `route.spec.ts` of both listing routes pins that a request without level
  parameters reaches the service without a level.
* Nothing enforces that a new client filter is answered by the server rather
  than by the drain; `readsWholeShelf` (`features/documents/lib/level-view.ts`)
  is where it is decided, and review is the gate.

## More Information

Revisit when the backend's tags, topics and Fassung links are mirrored into
Postgres: the kind and tag filters, the content facts and the Fassung rule
could then move to the server and the drain could go. Revisit the name and size
indexes if one level ever outgrows an in-memory sort of its rows.
