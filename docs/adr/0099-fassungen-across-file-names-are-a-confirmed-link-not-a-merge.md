---
status: proposed
date: 2026-10-10
decision-makers: Grid engineering
consulted: product owner; feld72 (Jour fixe 2026-10-09)
informed: everyone working in this repo
---

# Fassungen across file names are a confirmed link, not a merge

## Context and Problem Statement

ADR-0054 gave a document a version history, but only under ONE name: dropping
`EG_Grundriss.pdf` onto a collection that holds `EG_Grundriss.pdf` makes a new
version of the same `documents` row. Offices do not work that way. feld72
names every state with its index and date and never overwrites one
(`EG_Grundriss_Index_B_2026-07-02.pdf`, then `…_Index_C_2026-08-14.pdf`), and
asked in the Jour fixe of 2026-10-09 for „eine Logik wie bei Planfred“: only
the newest state is the basis, the older ones only on request, and any
automation „nur als Vorschlag mit Rückfrage und manueller Bestätigung“. Today
every one of those files is an independent document. Search draws from all of
them, so an answer can quote Index B's dimensions while Index C is in the
same folder, and nothing tells the reader which state an answer used.

Competitors match by file name or by a sheet number read from the title block
(Planfred, Procore, Revizto, Autodesk Docs), then put the match on a confirm
screen. None of them links a differently named file by its content, and none
says in words what changed.

## Decision Drivers

* A wrong link must be cheap to undo, because the LLM part of the suggestion
  will sometimes be wrong.
* Citations, chat subjects, assignments, shares and folder placement bind a
  `documents.id`. Anything that deletes or re-keys a document breaks them.
* Held and restricted documents' names must never reach a model or a reader
  who may not see them (ADR-0086, ADR-0087).
* Ingesting a document is the expensive step (vision on drawings). A second
  ingest of the same bytes is waste.

## Considered Options

* **Merge into the version chain.** On confirmation, move the newer file's
  bytes into the older document as its next version (ADR-0054), re-ingest
  them under the older name, and delete the newer row.
* **Decide at upload time.** Before the bytes are stored, offer „Neue Fassung
  von X?“ and upload straight into X's chain (`versionOf`).
* **A confirmed link between two documents.** Both stay what they are. A
  person confirms „X ersetzt Y“. Y is marked superseded by X, search leaves Y
  out unless asked for it by name, and Piloti writes what changed. The
  suggestion comes from the name grammar (`revision_series.py` and its TS
  twin) and from a model that reads both documents' summaries.
* **Do nothing.** Show the name series in the folder brief and leave search
  alone.

## Decision Outcome

Chosen option: "A confirmed link between two documents", because it is the
only option that is fully reversible and touches no identity. A wrong link is
undone by unlinking. No citation, assignment or share moves. Neither file is
ingested twice, and the link is a fact on the knowledge layer's own row
(`document_metadata.superseded_by`), which the agent's inventory, its
`list_files` and its search already read. Merging fails the first two drivers.
Deciding at upload time cannot use the model's reading, because a summary
exists only after ingestion, and it never helps with the hundreds of files
already uploaded. Doing nothing leaves answers drawing on superseded states.

The model only SUGGESTS (`revision_suggestion`, with the reason and whether
the name or the content carried it). A link is made only by a person, in one
of three places:

* **At upload.** The upload dialog reads the dropped file's name with the
  revision grammar and offers „als neue Fassung von X ablegen“ when it
  continues a document already on the shelf. The decision travels with the
  ingest job (`fassung_of`), and the link is written the moment the new file
  has been read, with its change summary.
* **After reading.** The preview asks when the model's suggestion, or the name
  grammar, says a document replaces another
  (`PUT /api/documents/[id]/fassung`, gated like a tag correction).
* **For what is already there.** Each file carries the name-based suggestion
  too, computed when its listing is read, so documents uploaded before this
  existed are asked about on the file, not in the folder overview.

**Storage is a link; the workspace shows one document.** A chain of linked
documents is presented as the document it is. The listing shows only the
current Fassung, with the number of Fassungen it has; the older ones leave
the listing, and a filter brings them back. Opening the document shows one
timeline of every Fassung, newest first: its own same-name versions
(ADR-0054) and the older documents linked to it, each with its index and
date, who uploaded it and what changed. A person sees one document with a
history, and nothing about the link model reaches them.

ADR-0054's same-name chain stays as it is. A same-name re-upload also gets a
„was hat sich geändert“ summary against its previous version.

### Consequences

* Good, because answers rest on the current Fassung, and the older one is still
  one `file_name=…` away, as feld72 asked.
* Good, because the name grammar, the file's suggestion, the preview and the agent all read
  one model of a Fassung: a series by name, a link by a person.
* Good, because the change summary is new. No product we looked at says in
  words what changed between two states.
* Bad, because a linked older Fassung keeps its own name in a citation when
  Piloti reads it on request. That is the file's real name, and the timeline
  shows where it sits in the document's history.
* Bad, because the change summary compares summaries, not drawings. It can
  miss a changed dimension, and the UI says so („Prüfen Sie Maße und Werte im
  Dokument selbst“).
* Bad, because the link lives in the knowledge layer's store, not in the BFF's
  database. A document deleted on one side leaves a dangling name, which is
  shown as nothing (the BFF drops a reference it cannot resolve for the
  reader).

### Confirmation

* `frontends/ui/src/lib/documents/fassung.spec.ts` proves a held document's
  name never appears in the projected Fassung facts.
* The aiq_api route tests prove that only the PUT creates a link and that a
  dismissed suggestion is not made again.
* `tests/knowledge_layer_tests/test_browse.py` pins the marks, and the
  `knowledge_search` tests pin the exclusion and the explicit `file_name`
  bypass.
* `frontends/ui/src/i18n/forbidden-file-words.spec.ts` keeps the copy from
  calling a file a plan (CONTEXT.md, „Fassung“).
* `test_model_calls_are_traced.py` keeps both model steps observable in
  Langfuse.

## More Information

* ADR-0054: versions under one name, and the publish door.
* Research behind this decision: Planfred (file name as Planschlüssel, index
  history, no compare), Procore (OCR plus a review-and-confirm page), Bluebeam
  (visual overlay compare), PlanRadar (Freigabe before a new version becomes
  current).
* Next, if the name grammar and the content reading prove too weak: read index
  and date from the title block during vision ingestion, which feld72 asked for
  („Index und Datum aus dem Plankopf auslesen“).
