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
- A mark by Piloti is `open` only with a person behind it: `accepted_by` is set,
  by the person who took it over, or by the person who asked Piloti for it.
- A closed mark (`resolved`, `dismissed`) says who closed it and when.
- A box stays on its page.

`scripts/rls-test-db.sh` refuses each CHECK against a real PostgreSQL, then
applies the down migration and re-applies the up migration.

Migration `0136_piloti_wakes.sql` adds what wakes Piloti (below, „Events wake
Piloti“):

| Where | Holds | CHECK |
|---|---|---|
| `document_annotation_replies.addresses_agent` | the reply addresses Piloti: the composer's @Piloti chip, never read from the text | default false |
| `document_annotations.delegated_by`, `delegated_at` | Piloti is the delegate, working the mark for this person | both or neither (`…_delegation_complete`); only on an open mark (`…_delegated_while_open`) |
| `piloti_wakes` | one row per event that met a wake rule: its id is the job id and the turn id (uuid5 of the event); trigger, event, the person who acted, and what it came to (`queued`, `started`, `suppressed`, `refused`, `failed`) | a reason exactly when it started no turn; `settled_at` exactly when it left `queued`; RLS on the org and the mark's org |

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
| `/api/documents/[id]/thread` | POST: the caller's own thread about the document (below) |

The list answers `pilotiWakes`, whether the organization lets events wake
Piloti. A reply answers `{annotation, replyId, wake}` and a PATCH that
delegates `{annotation, wake}`, where `wake` is `none` (no rule met), `off`
(the switch is off), `queued` (the server wakes Piloti) or `suppressed` (a cap
held it).

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

**By tool.** The `canvas` function group (`src/aiq_agent/tools/canvas/`) calls
`/api/internal/document-annotations`: `canvas__marks` (`list`), `canvas__mark`
(`propose`, or `create` with `open=true`), `canvas__update` (`update`),
`canvas__delete` (`delete`), `canvas__reply` (`reply`), `canvas__room`
(`room`), and the gestures `canvas__point` and `canvas__highlight`;
`canvas__look` renders the page or a box on it through `view_knowledge_image`'s
own body. The turn sends `leave` when it ends, so Piloti's cursor goes with it.

- A tool may name a document (`document`: a file name from the turn's inventory, or an id); the name is resolved against the inventory and its id read from `GET /api/internal/document-file` with the envelope echoed. Without one it acts on the document open on the canvas (`focus_document_id`), then on the conversation's *subject*. The server checks a named document against the asker's access and the turn's signed scope (`lib/annotations/agent.ts`).
- With no document named and no subject, the tool gets a typed 422 and asks which document is meant.
- A reply, a proposal, a highlight and a labelled pointer are seen by everyone who opens the document, so a conversation that drew on a restricted folder or another project may write none of them (`tools/canvas/policy.py`).
- A held upload reaches no model.
- A subject in a restricted folder is admitted against the conversation first.

### What the person asks for, Piloti does as they could

The product decision: there is no difference between what Piloti does and what
a person does, with light reporting. When the person ASKS, Piloti may do on a
document's Anmerkungen everything that person may do, under that person's own
rights, because every op runs as the asker's pinned session through the same
service functions the person's own routes use (`lib/annotations/agent.ts`):

| Asked for | Op | Runs | Recorded as |
|---|---|---|---|
| Set a mark | `create` | `setAnnotationsForAsker`: born `open`, `author_kind = piloti` | `created_by` and `accepted_by`/`accepted_at` = the asker |
| Resolve, reopen, dismiss a proposal, take one over, assign, set or clear a date, reword, change the kind | `update` | `updateAnnotationForAsker`, which runs `updateAnnotation` with `actor = PILOTI`, then posts `note` as Piloti's reply | `closed_by` / `accepted_by` = the asker |
| Delete a mark | `delete` | `deleteAnnotation`, which allows only a mark the asker set themselves | nothing left |

Findings Piloti makes on its own initiative, including a whole-document review
the person did not itemise, stay proposals (`propose`). The tool descriptions
say when to use which: `open=true` only when the person asked for exactly that
mark; `update` only when they asked for that change to that mark; `delete`
only on explicit request.

The CHECKs of migration 0135 hold on every path, unchanged:

- `only_piloti_proposes`: a born-open mark is not `proposed`; a person's mark never is.
- `acceptance_complete`: `accepted_by` and `accepted_at` are set together, on birth or by `transition()`.
- `piloti_needs_a_person`: Piloti's open or resolved mark carries `accepted_by`, the asker, because the person stood behind it by asking.
- `closing_complete`: closing goes through `transition()`, which sets `closed_by`/`closed_at` to the asker and clears them on reopening.

`frontends/ui/src/app/api/internal/document-annotations/route.spec.ts` runs the
real service over a fake repository and checks every row it leaves against
these predicates; `repository.integration.spec.ts` sets a born-open mark in
real PostgreSQL and finds the CHECK still refusing one with nobody behind it.

**The note.** Every change Piloti makes to an existing mark posts ONE short
reply in that mark's thread, authored as Piloti, from the `note` the model must
give („Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.").
The service posts it in the same request as the change, so the two cannot
drift apart: a full thread refuses the change before it lands, a stale
`expectedStatus` is a 409 with no note, and a change that moved nothing posts
nothing. A mark the tool looked up by its number is changed only if its status
is still the one read (`expectedStatus`).

**Who is assigned.** The model never sees a user id, so `update` takes the
`assignee` as the person said it. The BFF resolves it against the
organization's directory among those who can open the document
(`resolveAssignee`): an exact name or address, then a first name or the start
of a name. None or several is a 422 naming the candidates, and the tool turns
it into a question.

**Who it says did it.** Piloti's presence and replies are labelled Piloti. The
person shown as `acceptedBy` or `closedBy` is the asker, which is correct: they
are accountable.

**By a box.** A person draws a box and asks Piloti about it, on the canvas.

1. The canvas opens a conversation whose subject is the document, before the socket opens. The proxy only verifies a conversation that exists at upgrade time.
2. It sends the question with `focus_region` (page and normalized box) on the wire v2 `user_message`.
3. The agent looks at a server-side crop of exactly that box, from `canvas__look` (or `view_knowledge_image`) with `region`. The crop is rendered from the screened Fassung, never from pixels the browser sends.
4. The answer streams into a card beside the box and can be kept as a mark.

Mentioning Piloti in a thread sends the same turn with `reply_in_thread`. The
prompt tells the model it was asked in that thread, and the model answers there
with `canvas__reply`: nothing is posted on its behalf. The turn runs without
restricted folders in scope, so its own research cannot keep the reply out.
Whether the browser or the server sends that turn is the next section's.

The canvas asks in the person's own thread about the document, `POST
/api/documents/{id}/thread` (`lib/annotations/document-thread.ts`): its id is
uuid5 of the document and the person, created with the document as its subject
on first use, the construction `lib/tasks/task-thread.ts` uses. The canvas, the
chat and a wake of Piloti by the person's reply agree on it without a lookup;
the per-tab id the canvas used to keep in session storage is gone.

### Events wake Piloti (ADR-0106)

People answer Piloti where the work is, often with nobody's chat open. These
events wake it, and only these, by a rule people can read (ADR-0036):

| Event | Wakes Piloti when | Trigger |
|---|---|---|
| A person's reply in a mark's thread | it addresses Piloti (the composer's chip, stored as `addresses_agent`) | `thread_mention` |
| A person's reply in a mark's thread | the mark is Piloti's own `question`, still proposed or open | `thread_reply` |
| A person makes Piloti the delegate on an open mark | always | `assigned` |
| A person takes over or dismisses Piloti's mark | never | |

`lib/annotations/wake.ts` decides; the service enqueues the wake **in the
write's own transaction** (`insertAnnotationReply` / `updateDocumentAnnotation`
take a hook that runs in it), so a reply that rolls back leaves no wake. The
wake's id is uuid5 of the event (`wake-ids.ts`), which is its `piloti_wakes`
row, its `bff_job_queue` job (`piloti_wake`) and the turn id: one event wakes
Piloti at most once.

**Who it runs as.** The person whose act is the event: the replier, or the
person who delegated. The job (`lib/annotations/wake-job.ts`) asks everything
again when it runs, because the queue can hold it: the person's pinned session
of today (`resolvePinnedRequesterSession`), the organization's switch, their
right to write the document, the mark, the caps. It writes the trigger into the
person's thread as a question row („Anna Berger in Anmerkung 4: „…““), resolves
the turn context for that session and thread (`lib/turns/turn-context.ts`,
which refuses a spent budget), and opens the chat socket as an internal caller
with the signed envelope and `X-AIQ-Mode: headless` (`lib/turns/headless-turn.ts`).
The `user_message` carries `trigger`, `if_idle`, the mark's region with its
`annotation_id`, and `reply_in_thread`. The contract:
[`websocket-protocol.md`](../api/websocket-protocol.md#a-turn-an-event-woke-trigger--if_idle).

**What the socket answers.** `RUN_STARTED`: the job records `started` and
detaches, the turn persists itself. `busy` (another turn of that thread runs):
the job waits without spending an attempt (`notBefore`, 15 s doubling to
5 min, twelve times) and asks again under the same id. `duplicate_turn`: done.
A refusal (admission, the budget): recorded as `refused`. A wrong envelope is
retried by the queue and recorded as `failed` on the last attempt.

**Guards.** Piloti's own replies never wake it. Only a person who may write
the document can reply, so only they can wake it. At most
`GRID_WAKE_MAX_PER_MARK_HOUR` wakes per mark an hour (6) and
`GRID_WAKE_MAX_PER_PERSON_DAY` per person a day (50), counted over the
`piloti_wakes` rows at enqueue and again at claim. The WorkOS flag
`piloti-wakes`, an entitlement off by default. A wake that started no turn has
no trace, so it is on its row and in the audit trail as
`piloti.wake.suppressed`.

**With the switch off** the reply answers `wake: 'off'` and the browser asks
Piloti itself, as before, under the turn id a server wake of the same reply
would use (`wakeTurnId(replyId)`), so the two could never both run. With it on
the browser runs nothing: the thread shows „Piloti antwortet …“ until Piloti's
reply arrives through the room, or after two minutes a quiet „Piloti antwortet
später“.

### Piloti as the delegate

Work is assigned to people and delegated to agents (ADR-0105, the pattern
Linear ships). „An Piloti delegieren“ in the thread's menu (offered while the
switch is on, on an open mark) sets `delegated_by` and `delegated_at` and wakes
Piloti; the mark keeps its assignee, and the thread shows „Piloti arbeitet
daran · für Miriam“. „Von Piloti zurücknehmen“ clears it without a wake. Piloti
hands the mark back by replying (its reply clears the delegation in the same
statement), and resolves it only when the person who delegated asked for that;
closing the mark ends the delegation. Piloti cannot delegate to itself.

The trace carries `turn_surface` and `focus_region_viewed`
([`docs/observability/langfuse.md`](../observability/langfuse.md)).

## In the chat

Whatever Piloti did on a document in a turn comes back as one
`canvas_activity` card ([cards.md](cards.md#current-card-types)): marks
proposed (`proposed`) or set on request (`created`), changes (`changed`, each
field before and after, and the note), deletions (`deleted`) and replies. It
is the way from the chat onto the canvas and back:

1. Each proposed mark carries „Übernehmen" and „Verwerfen". The answer goes
   through the same typed client the canvas uses, and is stored on the message
   per mark. Before a take-over the card reads the mark again: the API lets a
   discarded mark be opened again, so a 409 alone would not stop it reopening
   one a colleague just discarded.
2. „Im Dokument zeigen" puts the document in the peek beside the chat (the
   preview store) and writes `review=1&mark=<id>` onto the chat's own URL with
   `router.replace`. The pane opens the Prüfansicht at that mark and strips
   both params. Closing the review leaves the document in the peek and the
   conversation where it was. On the chat the link never carries `doc`,
   because there `doc` is the subject of an ask. A copied link
   (`doc=…&review=1&mark=…`) still works: the chat opens that document
   beside it, leaves the composer alone, and drops `doc` once the pane has
   taken the link. Off the chat the card goes to Dateien with all three
   params.

3. A change carries „Rückgängig". It PATCHes the inverse through the
   reader's own client with `expectedStatus` = the status Piloti left, after
   reading the mark again, so it never undoes a colleague's later move: a mark
   that moved on shows where it stands instead. Taking a proposal over and
   dismissing one have no way back through a person's PATCH, so they offer no
   undo. The undo is stored per row through `useCardDecision`. A deleted mark
   is gone with its thread; its row only says so.

## Known debts

- The chat-hosted canvas (the review open over the chat) still asks an @Piloti reply in the chat's conversation, under the chat's own message id, when wakes are off; only the standalone canvas uses the reply's turn id.
- The „Geweckt durch“ prompt block names the turn's verified principal, which an internal caller does not have, so a woken turn reads „Eine Person“ there; the person's name is in the trigger row and in `author_name`.

- The canvas runs its own small turn client next to the chat's turn driver in `use-websocket-chat.ts`. That driver should become one shared module that both use.
- The Python side posts to internal routes through several near-identical helpers.
- A change Piloti makes and its note are two writes in one request, not one transaction (`updateAnnotationForAsker`). Every refusal the service can foresee (rights, a stale status, a full thread) comes before the change; a database failure between the two writes would still leave the change without its note.
