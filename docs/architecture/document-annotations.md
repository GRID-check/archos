# Anmerkungen: marks on a document, the Prüfansicht, and Piloti on it

An **Anmerkung** is a mark on one page of one Fassung: a point, or a drawn box (a
*Bereich*). It carries what it says, a running number, optionally a person
responsible and a date, and a thread of answers. The term is defined in
[`CONTEXT.md`](../../CONTEXT.md) under „Anmerkung“. This page covers the moving
parts.

## The data, and the rules the database holds

Migration `frontends/ui/drizzle/0135_document_annotations.sql` creates two
tables, both under `grid_secure_table` RLS.

| Table | Holds | RLS predicate |
|---|---|---|
| `document_annotations` | the mark: page, shape, normalized box, kind, body, basis, author kind, status, assignee, due date, Fassung, number | org, and the document's org |
| `document_annotation_replies` | the thread | org, and the annotation's org |

The coordinates are normalized to the page, 0 to 1 with the origin at the top
left. This is the same frame as `PageRegion` in the PDF viewer, so a mark stays
put at any zoom and on any screen.

The domain rules are CHECK constraints, not service code. A tired contributor
cannot route around them:

- Only Piloti proposes.
- A mark by Piloti is `open` only once a person has taken it over: `accepted_by` is set.
- A closed mark (`resolved`, `dismissed`) says who closed it and when.
- A box stays on its page.

`scripts/rls-test-db.sh` refuses each CHECK against a real PostgreSQL, then
applies the down migration and re-applies the up migration.

Numbers are allocated under an advisory lock per document, so two people
setting a mark at the same moment never share a number. Status moves are
compare-and-swap on the expected status (`updateDocumentAnnotation`): a
conflicting move returns 409, and the canvas re-reads.

Every read ANDs `documentVisibleTo(reader)`, and the repository functions are
registered in `lib/documents/document-visibility.spec.ts`. A held upload's
marks are as invisible as the upload.

## The service and its API

`frontends/ui/src/lib/annotations/`:

| File | Owns |
|---|---|
| `types.ts` | the zod contract: requests, the view, the agent's internal request |
| `repository.ts` | SQL |
| `service.ts` | who may do what, and the state machine (`transition()`) |
| `client.ts` | the typed client the UI uses |

Routes:

| Route | Methods |
|---|---|
| `/api/documents/[id]/annotations` | GET, POST |
| `/[annotationId]` | PATCH, DELETE |
| `/[annotationId]/replies` | POST |

The UI and Piloti are equal clients of one service (ADR-0055).

## The Prüfansicht

`features/documents/components/review/` holds the canvas. `document-review.tsx`
is the document opened full screen:

- marks drawn on the PDF pages (`review-page-layer.tsx`);
- the open thread beside its mark (`thread-card.tsx`);
- the list (`review-panel.tsx`), where Piloti's proposals lead the open marks as a group you can walk through.

Keys:

| Key | Does |
|---|---|
| V / C / R | select, point, box |
| J / K | step through marks |
| E | take a proposal over |
| Esc | backs out one layer at a time |

`use-document-review.ts` is the state both surfaces share: the inline layer in
the file preview, and the full-screen review.

## Live

Each document has a room. In it, people see each other's presence, named
cursors (spring-interpolated, about 80 ms apart) and viewports (followable).

A write sends an `annotations.changed` hint. A hint is a nudge to re-read, never
the state itself, so a dropped hint costs a few seconds, not a wrong list. The
tab that wrote ignores its own hint.

The transport is the shared realtime channel layer; see ADR 0104 for why it is
our own thin layer over Dragonfly rather than a library.

## Piloti on the canvas

Piloti reaches marks in two ways.

**By tool.** `document_annotations` (`src/aiq_agent/tools/annotations/`) calls
`/api/internal/document-annotations` with `list`, `propose` or `reply`.

- The document is always the conversation's *subject*, resolved on the server (`lib/annotations/agent.ts`). The request cannot name one.
- A conversation that is not about a document gets a typed 422.
- A held upload reaches no model.
- A subject in a restricted folder is admitted against the conversation first.

**By a box.** A person draws a box and asks Piloti about it, on the canvas.

1. The canvas opens a conversation whose subject is the document, before the socket opens. The proxy only verifies a conversation that exists at upgrade time.
2. It sends the question with `focus_region` (page and normalized box) on the wire v2 `user_message`.
3. The agent looks at a server-side crop of exactly that box, from `view_knowledge_image` with `region`. The crop is rendered from the screened Fassung, never from pixels the browser sends.
4. The answer streams into a card beside the box and can be kept as a mark.

Mentioning Piloti in a thread sends the same turn with `reply_in_thread`; Piloti
posts its answer into that thread through the internal `reply` op.

The trace carries `turn_surface` and `focus_region_viewed`
([`docs/observability/langfuse.md`](../observability/langfuse.md)).

## Known debts

- The canvas runs its own small turn client next to the chat's turn driver in `use-websocket-chat.ts`. That driver should become one shared module that both use.
- The Python side posts to internal routes through several near-identical helpers.
