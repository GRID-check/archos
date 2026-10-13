# Workspace tools: `src/aiq_agent/tools`

Tools that act on the user's workspace rather than retrieve from a corpus.
Evidence sources are packages under `sources/`; what lives here is the BIM
surface (`bim/`), the conversation's working directory (`documents/`), the
write-side workspace verbs (`files/`) and the review canvas (`canvas/`, the
`canvas` function group: look at a page or a box on it, the room, pointing and
highlighting, and Anmerkungen: Piloti's own findings are born proposals a
person takes over or dismisses, and what the person asks for (set a mark,
change one, delete one they set) Piloti does in their name, under their rights,
with a note in the mark's thread; it acts on a document the model names, the
one open on the canvas, or the conversation's subject, each checked by the BFF
from the envelope).

## The invariant

**The working directory never creates a `documents` row.** `write_file` and
`edit_file` write into a LangGraph store namespaced by conversation
(`documents/draft_store.py`). Nothing there is a project document: it is not
filed, not indexed, not citable, and it does not appear in the Files explorer.
A draft becomes a document only through the **document lifecycle API**, which a
person gates — the agent may propose, never publish. The Python tier holds no
second path to that API and must not grow one: the BFF is the single writer of
`grid_app` (ADR-0003).

The card the working directory emits (`document_draft`) reports a file. Once
`file_draft` has run it also names the project document, and its two controls —
„Im Projekt öffnen", „Zur Freigabe einreichen" — go through the routes the Files
pane already uses, in the reader's own session. A tool here that wrote a row
directly would bypass `requireProjectAccess`, the provenance marking and the
review state in one move.

Read [`docs/roadmap/piloti-writes-artifacts-and-approval.md`](../../../docs/roadmap/piloti-writes-artifacts-and-approval.md)
before changing what a file verb may do.

## Filing ECHOES the BFF's envelope; it never signs one

`file_draft` (`documents/register.py`) is the exception to the paragraph above
and the only tool here that changes the project: it files a draft and, with
`submit=true`, sends that version for review (it absorbed `submit_draft`). It
reaches `POST /api/internal/document-versions` — one route, ops `create`,
`update` and `submit`, closed on the BFF side by the transition table's `actor`
field, so approve, publish, reject and archive have no machine path at all.

**The identity is not this tier's to choose.** The BFF minted a signed
request-context envelope at the start of the turn, from a real session
(`lib/request-context.ts`, ADR-0054 §4). `GridRequestContext` keeps the raw
header and signature exactly as they arrived, and the tool forwards those two
strings unchanged beside `GRID_INTERNAL_API_TOKEN`. The BFF verifies them with
the same secret, reads the acting user out of the verified payload, and builds
that person's pinned session — so every permission check, every `created_by` and
every audit actor is the human who asked.

Re-signing a payload here would work, which is the danger: the internal token
and the signing secret are the same secret, so a Python tier that built its own
envelope would be CHOOSING the user id with a credential that only authenticates
the service. Hence the rule, in three words: **echo, never sign.** A run with no
envelope (CLI, eval, job worker) has no acting person, and the tool refuses
rather than falling back to the unsigned individual headers, which a caller could
have set.

The BFF decides identity and permission. This tier decides only *which bytes* and
*which reference*, and the reference is the conversation's
(`{conversationId}-{slug}`) so two turns writing one document produce two
versions rather than two documents.

## A write-side tool PROPOSES; the server applies it in the accepting person's session

The same invariant, stated as the rule the next operation has to follow. The
one tool under `files/`, `propose_file_change`, changes the user's workspace
four ways — its `operation` argument is `move`, `rename`, `create_folder` or
`assign` — and none of them changes anything. Each operation resolves its
arguments against what the turn can already see, stores the proposal as a
server object, emits ONE `file_operation_proposal` card carrying its id, and
returns text whose first words are that nothing has happened. It was four tools
until they merged; the card vocabulary kept its four operation kinds.

**A proposal is a server object (ADR-0105).** The tool sends
`POST /api/internal/proposals` (op `create`, kind `file_operation`, the card's
rows as `payload`), with the turn's envelope echoed like every call here, and
the card carries the returned `proposal_id` (`files/client.py`). The BFF
records the person Piloti acted for. Accepting the card asks the server to
apply the proposal in the DECIDING person's session, through the services the
Files pane uses, in order, recording a result per row; the decision is a server
row Piloti can read and Langfuse can score, not the browser's word. The body is
`internalProposalRequestSchema` in `frontends/ui/src/lib/proposals/types.ts`,
exported as `frontends/ui/tests/fixtures/proposals.schema.json`.

When the route is not there (an older BFF answers 404, a run has no envelope,
the BFF is unreachable) the card goes out without `proposal_id`, and accepting
it runs the operation from the browser, as the signed-in user, through the
routes the Files pane uses — `PATCH /api/documents/[id]`,
`PATCH /api/documents/[id]/folder`, `POST /api/projects/[id]/folders`,
`POST /api/assignments/document/[id]`. Either way no route is added for the
agent that a person could not reach themselves, so `requireProjectAccess`, the
audit trail and the feature gates are the ones that were already there — which
is ADR-0055 read from this side: one HTTP surface per primitive, and this tier
is a client of it like everybody else, never a second implementation.

Three consequences worth knowing before adding a fifth operation:

- **Nothing is resolved that the turn cannot see.** A document is matched
  against the turn's inventory rows (`knowledge/inventory.get_turn_documents`),
  and a folder against the paths those rows carry. A name that matches two files comes back as a question and never
  as a proposal naming one of them. A PERSON is the exception and is not
  resolved here at all: this tier has no member roster, so the card carries the
  name as the user said it and the reader's own session resolves it — inventing
  a match here would be exactly the guess the rest of the module prevents.
- **A stored proposal does not grow; one call is one proposal.** The internal
  route has `create` and nothing else, so a second move cannot join the first
  one's proposal, and a card that grew on the client would show two moves and
  apply one. A server-backed card is therefore closed, and „Räum die
  Einreichunterlagen zusammen" is four cards. Only the browser-executed
  fallback card still extends: repeated calls with the same `operation` append
  to it up to `MAX_FILE_OPERATIONS`. Batching server proposals again means
  creating them once the turn's cards are final, at the turn's finish, not
  per call (`files/cards.py` says why).
- **An operation with no route behind it does not ship.** `set_doc_class`
  was the fifth verb and is gone: the Dokumentart is settable only on the
  platform corpus, a project document has no such route, and the card therefore
  drew the proposal and no control — a decision the reader could read and could
  not take. A proposal nobody can accept is not a smaller feature than one they
  can, it is a different and worse thing, so the operation waits for the
  project-scoped route rather than shipping ahead of it. Inventing a route on this side would put the
  write back behind the door the whole module exists to keep shut.

## Content from another project is recorded by the BFF before it arrives

`project_lookup` (`cross_project/`, ADR-0094) reads OTHER projects, from any
chat, as the conversation's whole audience. It is the one tool here whose
answers come from outside the turn's signed scope, so the usual admission (a
tool reports what it read, the tools node asks the BFF) is not what keeps it
safe: the BFF decides the reach, and records every project and restricted
folder an answer draws on, under the conversation's lock, BEFORE it returns the
answer. The tool then notes exactly those collections on the turn
(`note_cross_project_hand_out`), which is what `admit_tool_results` lets
through, and says whether they narrow the chat's readers (`restricting`: a
running project or a restricted folder; a closed project's open folder does
not), which is what shuts the turn's doors. A second tool that reads another
project must go through the same routes; one that admitted foreign content on
its own say-so would let the agent decide access.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a verb to the working directory | Add its action key to `common/turn_status.py` (with both dictionary strings). Nothing to add to a budget any more: the research budget counts ROUNDS, so a round of file verbs costs one like a round of searches and there is no interaction allowance to keep in step | The reader's live line goes silent mid-turn |
| Change what is stored per draft | Remember DeepAgents rebuilds the stored value from `content`/`encoding` on every edit: a key not re-stamped after the operation is gone | Nothing local. The version counter silently resets to 1 |
| Take text from the model and compare it to stored text | NFC-normalise both, at the backend seam | An `edit_file` that fails with a string identical to the one in the file. [`gotchas.md`](../../../docs/contributing/gotchas.md) |
| Add a tool under here | `@register_function` plus its own `nat.plugins` entry point, like every other tool ([`src/aiq_agent/AGENTS.md`](../AGENTS.md)) | NAT never discovers it |
| Add an operation that WRITES | Make it propose: its branch in `propose_file_change` (`files/register.py`) and its line in `_DESCRIPTION`, emitting a `file_operation_proposal` card and a result saying nothing changed. Then its kind in `FileOperationKind` (`cards/models.py`) and in `FILE_OPERATIONS` (`frontends/ui/src/lib/proposals/types.ts`), the server's applier for it, and the browser fallback's executor in `grid-cards/lib/file-operations.ts`. The action key and the `TOOL_CONTEXT_REQUIREMENTS` row belong to the tool and are already there; a new write-side TOOL needs both | Nothing local — which is the point. A tool that wrote directly would pass every test and bypass `requireProjectAccess`, the audit trail and the reader's consent in one call |
| Write a rule about how one of these tools is used | Put it in that tool's DESCRIPTION. The prompt blocks that used to hold these rules (`<entwuerfe>`, `<aufraeumen>`, `<delegieren>`) are gone: every one of them restated a bound tool's contract in prose charged on every call of every turn (ADR-0060 (d) and its amendment). The prompt keeps only what no description can carry: an antecedent that lives in the transcript | Review, and 1,500 tokens per turn. The rule also half-applies: a description reaches the model with the call, a prompt paragraph competes with everything else on the page |
| Add a canvas tool that WRITES something everyone who opens the document sees | Call `policy.shared_write_refusal()` before the request, as `mark`, `update`, `delete`, `reply`, `highlight` and a labelled `point` do | Nothing local: a thread or a highlight is read by the document's whole audience, and a conversation that drew on a restricted folder would leak it there. `tests/aiq_agent/tools/canvas/test_targets_and_policy.py` covers the six that exist |
| Call the BFF from a tool that acts as a PERSON | Echo `GridRequestContext.envelope_header` / `envelope_signature` unchanged. Never build or sign an envelope here, and never read the acting user off the unsigned `x-grid-user-id` header | Nothing local, and everything downstream: the internal token is the signing secret, so a self-signed envelope is a tool choosing whose permissions it runs under |
| Delete a conversation's working directory | Go through `DELETE /v1/drafts/{conversation_id}` (`frontends/aiq_api/routes/drafts.py`), which sweeps the store namespace. Nothing else may reach into `("conversation", id, "drafts")` | Nothing local. The drafts outlive the conversation as bytes under a key that names nothing |
| Change the shape of a proposal request or response | Nothing by hand: the contract is `frontends/ui/tests/fixtures/proposals.schema.json`, exported from `lib/proposals/types.ts`. There is no Pydantic twin | `tests/aiq_agent/tools/files/test_proposals.py`, which validates the body the tool really builds against that file |
| Change the shape of a lifecycle request or response | Nothing by hand — the contract is `frontends/ui/tests/fixtures/document-lifecycle.schema.json`, generated from the BFF's zod (ADR-0055). There is no Pydantic twin | `tests/aiq_agent/tools/documents/test_wire_contract.py`, which validates the payloads the tool really builds against that file |
