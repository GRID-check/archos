# Workspace tools: `src/aiq_agent/tools`

Tools that act on the user's workspace rather than retrieve from a corpus.
Evidence sources are packages under `sources/`; what lives here is the BIM
surface (`bim/`), the conversation's working directory (`documents/`), the
write-side workspace verbs (`files/`), `look` (`look/`, its own tool bound in
every context, ADR-0128: a page, a region of it or an embedded image as an
image the model sees; it resolves the document the way the canvas tools do and
makes the box glow on the canvas for a workspace document; every look leaves a
`look` Herleitung step at once and, once the answer is final, an item on the
document's `look` card if the answer relies on it, `look/cards.py`) and the review
canvas (`canvas/`, the `canvas` function group: the room, pointing and
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
`app` (ADR-0003).

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
envelope (CLI, eval, a background run that carries none) has no acting person,
and the tool refuses rather than falling back to the unsigned individual
headers, which a caller could have set.

A background run acts as the person who commissioned it (ADR-0108), and the job
worker is then one more echoing party, not a signing one. The job API keeps the
envelope the BFF sent with the submit, only when it verifies for the run's
requester, inside the encrypted job payload; the worker injects those two
strings at claim under the names a chat turn uses, and asks the BFF
(`POST /api/internal/runs/{runId}/envelope`) for a fresh one when the carried one
is over an hour old. Every refusal or failure leaves the run without an
envelope. The whole path is `frontends/aiq_api/src/aiq_api/jobs/run_envelope.py`;
nothing on it builds or signs an envelope.

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

**A proposal is a server object (ADR-0105), of one of three kinds.** The client
is `proposals_client.py` (`POST /api/internal/proposals`, op `create`, the turn's
envelope echoed like every call here); the BFF records the person Piloti acted
for, and accepting the card asks the server to apply the proposal in the
DECIDING person's session, through the services the person's own surfaces use,
recording a result per item. The decision is a server row Piloti can read and
Langfuse can score, not the browser's word. The body is
`internalProposalRequestSchema` in `frontends/ui/src/lib/proposals/types.ts`,
exported as `frontends/ui/tests/fixtures/proposals.schema.json`. Each kind has
exactly one creator, and the card carries the returned `proposal_id`:

| `kind` | Created by | Card | Payload |
|---|---|---|---|
| `file_operation` | `propose_file_change` (`files/cards.py`) | `file_operation_proposal` | `operation`, `operations`, `note` |
| `memory` | `remember` (`memory/register.py`), only when an organization-scoped write is refused and the turn is not restricted | `memory_proposal` | `scope`, `kind`, `content`, `confidence`, `supersedes` |
| `project_profile` | `register_envelope_card` (`cards/envelope.py`), called by `_register_envelope_cards` in `agents/piloti/answer_pipeline.py`, for the model's own `project_profile_patch` card in a turn that is not confined | `project_profile_patch` | `title`, `rationale`, `patch` (the model's `preview` is neither rendered nor recorded) |

The profile card is the odd one: the MODEL composes it in the answer envelope
and no tool runs, so the only place a turn can create its proposal is where the
envelope's cards become final. `validate_model_card` strips a `proposal_id` the
model wrote, and `proposal_id` is left out of the shapes the model is taught
(`SERVER_FILLED_CARD_FIELDS`): an id on a card is always one the BFF returned.

Every request names the card: `answerMessageId` and `originCardIndex`, the
card's position in the turn's `CardRegistry`. With the answer's id the index
makes the create idempotent at the database, so a card asked for twice returns
its first proposal. `add_card` therefore puts the card in the registry first and
asks for the proposal second, so the index is the position the card really has
even while a sibling tool adds its own.

When the route is not there (an older BFF answers 404, a run has no envelope,
the BFF is unreachable, the server refuses) no file operation runs from the
browser any more. The card stays in the registry without `proposal_id` (card
positions are identity: `cardKey` is `type-index` and `originCardIndex` is the
idempotency key of the proposals after it, so it is never taken back out), the UI
draws it read-only with „Konnte nicht als Vorschlag angelegt werden“, and
`propose_file_operation` returns `False`, so the tool tells the model it could
not propose (`_NOT_PROPOSED` in `files/register.py`). A memory note and a
profile patch without an id still go through their own person routes from the
browser. No route is added for the agent that a person could not reach themselves, so `requireProjectAccess`, the
audit trail and the feature gates are the ones that were already there — which
is ADR-0055 read from this side: one HTTP surface per primitive, and this tier
is a client of it like everybody else, never a second implementation.

**The fourth kind has no creator in this tier.** An `operation` proposal is
stored by the MCP server when `workspace__call` runs a write
(`lib/agent-api/operation-proposals.ts`), so `workspace/cards.py` only SHOWS it:
it reads `structuredContent` `{ decision: 'propose', proposalId, summary, operation }`
off the result and adds an `operation_proposal` card carrying that `proposal_id`
(one card per id: a repeated call gets the same proposal back). Reads and
refusals carry no `decision` and emit no card. The model reads the server's short
text only. Do not create the proposal from Python: a second path to the same row
is the drift ADR-0055 forbids.

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
  apply one. Every card is therefore one call's, and „Räum die
  Einreichunterlagen zusammen" is four cards. Batching server proposals again means
  creating them once the turn's cards are final, at the turn's finish, not
  per call (`files/cards.py` says why); `register_envelope_card` is that place
  for cards the model composes.
- **An operation with no route behind it does not ship.** `set_doc_class`
  was the fifth verb and is gone: the Dokumentart is settable only on the
  platform corpus, a project document has no such route, and the card therefore
  drew the proposal and no control — a decision the reader could read and could
  not take. A proposal nobody can accept is not a smaller feature than one they
  can, it is a different and worse thing, so the operation waits for the
  project-scoped route rather than shipping ahead of it. Inventing a route on this side would put the
  write back behind the door the whole module exists to keep shut.

## A new workspace capability is a route and an operation, not a tool

Piloti reaches the workspace through the BFF's MCP server (`/api/mcp`) like any
agent (ADR-0122). Everything a person can do there is an operation in
`frontends/ui/src/lib/agent-api/catalog/`, run as the person (except the ones
`withheld` from every agent: product configuration, proxied services, screen state), and a write from
this tier becomes a proposal the person accepts. So a capability that has a UI
route gets an operation, not a new Python tool. Python tools are for task-shaped
reasoning that has no route: retrieval, IFC, canvas. The Python-only reads are
served to other agents through the same server
([`agent-surface.md`](../../../docs/architecture/agent-surface.md)).

## The workspace tools are Piloti as a client of its own MCP server

`workspace` (`workspace/`, the `piloti_workspace` function group, ADR-0122) is
four tools, `workspace__search`, `workspace__describe`, `workspace__call` and
`workspace__report_missing`: the meta-tools an external agent gets from
`POST /api/mcp` in `discovery` mode. Each call is one stateless JSON-RPC
`tools/call` that echoes the turn's envelope beside `GRID_INTERNAL_API_TOKEN`
(echo, never sign, as above). A write comes back as a proposal the person
accepts; this tier applies nothing.

**Do not swap it for NAT's `mcp_client` group.** That client connects once, in a
lifecycle task created at build time, and sends every request from tasks spawned
inside it, which inherit the CONNECT-time contextvars. An auth provider reading
the envelope from a contextvar would send no identity, or another turn's, on a
later turn's call. Here the envelope is read inside the tool, in the turn's own
context, and nothing is connected or cached between calls; the two tests in
`tests/aiq_agent/tools/workspace/` (`..._of_its_own_turn`, `..._never_swap_identities`)
pin it. Nothing is added per operation on this side: a new operation is a catalog
entry on the BFF and appears through `workspace__search`.

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

The workspace tools are the second: `workspace__call` reads other projects
through the BFF's MCP door, and the BFF holds those reads to the same reach
(`audienceReachAmong`) and records them through the same
`recordCrossProjectHandOut` before the read runs (ADR-0094's amendment,
[`agent-surface.md`](../../../docs/architecture/agent-surface.md#reads-in-a-conversation)).
A shared chat reads only a document's content or a project's facts there.
The workspace result carries no `restricting` flag yet, so a door read of a
running project shuts the turn's doors only where the server judges them (a
memory write, a run, a share is refused against the record), not ahead of time
as `project_lookup` does.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a verb to the working directory | Add its action key to `common/status_keys.py` (with both dictionary strings) and map the tool to it in `common/tool_calls.py`. Nothing to add to a budget any more: the research budget counts ROUNDS, so a round of file verbs costs one like a round of searches and there is no interaction allowance to keep in step | The reader's live line goes silent mid-turn |
| Change what is stored per draft | Remember DeepAgents rebuilds the stored value from `content`/`encoding` on every edit: a key not re-stamped after the operation is gone | Nothing local. The version counter silently resets to 1 |
| Take text from the model and compare it to stored text | NFC-normalise both, at the backend seam | An `edit_file` that fails with a string identical to the one in the file. [`gotchas.md`](../../../docs/contributing/gotchas.md) |
| Add a tool under here | `@register_function` plus its own `nat.plugins` entry point, like every other tool ([`src/aiq_agent/AGENTS.md`](../AGENTS.md)) | NAT never discovers it |
| Add a file operation that WRITES | Make it propose: its branch in `propose_file_change` (`files/register.py`) and its line in `_DESCRIPTION`, emitting a `file_operation_proposal` card and a result saying nothing changed. Then its kind in `FileOperationKind` (`cards/models.py`) and in `FILE_OPERATIONS` (`frontends/ui/src/lib/proposals/types.ts`), and the server's applier for it (`lib/proposals/executors.ts`). The action key and the `TOOL_CONTEXT_REQUIREMENTS` row belong to the tool and are already there; a new write-side TOOL needs both | Nothing local — which is the point. A tool that wrote directly would pass every test and bypass `requireProjectAccess`, the audit trail and the reader's consent in one call |
| Add a write that is not a file operation (a fourth proposal kind) | Add the kind to `PROPOSED_CHANGE_KINDS`, its payload to `internalProposalRequestSchema` and its applier on the BFF side first; then create it from ONE place with `proposals_client.add_card` (a tool that pushes its own card, or `register_envelope_card` for a card the model composes), carrying `proposal_id` on the card and falling back to the old card on every failure. Give the card `proposal_id` in `cards/models.py` (and add the field to `SERVER_FILLED_CARD_FIELDS` if the model can compose the card) | `tests/aiq_agent/tools/files/test_proposals.py`, which fails when the contract has a kind this client cannot ask for. Nothing else: a write that skipped the proposal would apply in the agent's name, not the person's |
| Write a rule about how one of these tools is used | Put it in that tool's DESCRIPTION. The prompt blocks that used to hold these rules (`<drafts>`, `<aufraeumen>`, `<delegieren>`) are gone: every one of them restated a bound tool's contract in prose charged on every call of every turn (ADR-0060 (d) and its amendment). The prompt keeps only what no description can carry: an antecedent that lives in the transcript | Review, and 1,500 tokens per turn. The rule also half-applies: a description reaches the model with the call, a prompt paragraph competes with everything else on the page |
| Add a canvas tool that WRITES something everyone who opens the document sees | Call `policy.shared_write_refusal()` before the request, as `mark`, `update`, `delete`, `reply`, `highlight` and a labelled `point` do | Nothing local: a thread or a highlight is read by the document's whole audience, and a conversation that drew on a restricted folder would leak it there. `tests/aiq_agent/tools/canvas/test_targets_and_policy.py` covers the six that exist |
| Call the BFF from a tool that acts as a PERSON | Go through `common/bff_http.py` and pass `SignedEnvelope(header, signature).headers()`: echo `GridRequestContext.envelope_header` / `envelope_signature` unchanged. Never build or sign an envelope here, and never read the acting user off the unsigned `x-grid-user-id` header | Nothing local, and everything downstream: the internal token is the signing secret, so a self-signed envelope is a tool choosing whose permissions it runs under |
| Delete a conversation's working directory | Go through `DELETE /v1/drafts/{conversation_id}` (`frontends/aiq_api/routes/drafts.py`), which sweeps the store namespace. Nothing else may reach into `("conversation", id, "drafts")` | Nothing local. The drafts outlive the conversation as bytes under a key that names nothing |
| Change the shape of a proposal request or response | Nothing by hand: the contract is `frontends/ui/tests/fixtures/proposals.schema.json`, exported from `lib/proposals/types.ts`. There is no Pydantic twin | `tests/aiq_agent/tools/files/test_proposals.py`, which validates the bodies the client really builds, for all three kinds, against that file; `tests/aiq_agent/memory/test_register.py` and `tests/aiq_agent/cards/test_register_envelope_card.py` for the two other creators |
| Change the shape of a lifecycle request or response | Nothing by hand — the contract is `frontends/ui/tests/fixtures/document-lifecycle.schema.json`, generated from the BFF's zod (ADR-0055). There is no Pydantic twin | `tests/aiq_agent/tools/documents/test_wire_contract.py`, which validates the payloads the tool really builds against that file |
