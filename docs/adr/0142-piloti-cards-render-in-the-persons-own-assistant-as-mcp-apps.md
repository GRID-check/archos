---
status: accepted
date: 2026-10-27
decision-makers: product owner, Grid engineering
consulted: the generative-UI research of 2026-10-27 (OpenIntelligentUI, AG-UI, A2UI, MCP Apps)
informed: everyone working in this repo
---

# Piloti's cards render in the person's own assistant as MCP Apps, starting with the proposal card

## Context and Problem Statement

An architect who works in Claude, ChatGPT, VS Code or Cursor reaches Piloti
through its MCP door (`/api/mcp`, ADR-0122). Everything there arrives as text:
a proposal Piloti filed is a JSON blob the assistant paraphrases, and deciding
it means the assistant calling `proposal-apply` on the person's say-so in
prose, or the person opening Piloti. Inside Piloti the same proposal is a card
with the change, its targets, every input in full, and Apply and Discard.

MCP Apps (`io.modelcontextprotocol/ui`, SEP-1865, stable 2026-01-26; SDK
`@modelcontextprotocol/ext-apps` 2.x) is the official MCP extension for exactly
this: a server serves `ui://` HTML resources (`text/html;profile=mcp-app`), a
tool names one in `_meta.ui.resourceUri`, the host draws it in a sandboxed
iframe under a CSP the resource declares, hands it the tool result over a
`postMessage` JSON-RPC bridge, and the view calls tools back through the host,
including app-only tools (`_meta.ui.visibility: ["app"]`) the model never
sees. Claude (web and desktop), ChatGPT, VS Code, Goose and Postman render it
(the ext-apps README and OpenAI's Apps SDK reference, read 2026-10-27); Cursor
since 2.6, with regressions reported in 3.10 and 3.11.

ADR-0065 decided that A2UI draws every card, with a custom-only Piloti catalog,
and named MCP Apps as "the right answer to Piloti inside another assistant, a
separate decision". This is that decision.

**What the request assumed, and what holds.** The research slice put
`_meta.ui.resourceUri` on "writes that return `{ decision: 'propose' }`". On
the door, only Piloti's own client gets that answer: an outside agent's write
runs (after its client's or the elicitation's yes), and Piloti's client is not
an MCP Apps host. An outside agent meets Piloti's proposals by reading them
(`proposal-list`, the inbox) and one proposal with `proposal-get`. So the card
draws `proposal-get`'s result.

## Decision Drivers

* **Industry standard first.** The door is MCP; MCP Apps is MCP's own UI
  extension, with an SDK the hosts' authors maintain. A widget dialect of our
  own (or mcp-ui, its predecessor) would be a translation every host pays for.
* **The route stays the gate** (ADR-0122, ADR-0055). A button in a host frame
  is one more client of the proposal routes, never a second write path.
* **The person's yes for a write stays the person's.** The model must not be
  able to press the card's button.
* **No tenant data in a template.** A host caches and reviews a resource at
  connect time (the spec's "predeclared resource review"); one document serves
  every office.
* **One catalog** (ADR-0065). The card in the host is the card in the chat, not
  a second rendering of the same proposal.

## Considered Options

1. **MCP Apps with the SDK, the catalog's own receipt in a bundled view** (chosen).
2. **Hand-rolled bridge**: our own `postMessage` client in the view and our own
   `_meta` handling on the server. The spec shows that it can be done, but it
   is the protocol written twice, and the SDK carries the host-theming
   helpers, auto-resize, and every protocol revision. Rejected while
   `@modelcontextprotocol/ext-apps` 2.x is maintained by the spec's authors
   and peers on the MCP SDK 2.x the door already uses.
3. **A UI of its own for the view**, a small HTML card written for the iframe.
   Smaller (tens of KB), but a second copy of the receipt's rules (`canDecide`,
   the "read every shortened value first" wait, a 409 shown as a colleague's
   decision), which ADR-0105 put in one place for a reason. Rejected while the
   receipt bundles inside the size budget below.
4. **Use the existing `proposal-apply` / `proposal-dismiss` tools from the
   view** (default visibility `["model", "app"]`). Rejected: the model can call
   them, so a press could not be told from the model acting, and in `search`
   mode they are no tools at all.
5. **Do nothing.** The assistant keeps paraphrasing proposals and deciding them
   in prose.

## Decision Outcome

Chosen option 1.

### The pieces

* **The resource.** `ui://piloti/proposal-card`, one self-contained HTML
  document (`frontends/ui/mcp-app-views/proposal-card.html`), built at deploy
  by `scripts/build-mcp-app-views.ts` (Bun bundles the view, Tailwind compiles
  its stylesheet from `globals.css`, both inline), listed in `resources/list`
  and read through `registerAppResource` with the mime type
  `text/html;profile=mcp-app`. The same bytes for every office and every
  person: the build reads no environment and no tenant, and the read handler
  takes no argument but the URI.
* **The view.** `features/mcp-apps/proposal-card/`: the SDK's `App`
  (`useApp`, `react-with-deps`), the tool result's `structuredContent`
  (`{ proposal }`, the route's own answer, parsed with
  `proposalResponseSchema`) turned into the catalog card for its kind
  (`operation_proposal`, `file_operation_proposal`, `memory_proposal`,
  validated by the generated `gridCardSchema`), drawn by `A2uiCard` with the
  receipts the chat uses (`ProposalReceipts.tsx`). The receipts read and decide
  through a `ProposalTransport` (`features/grid-cards/hooks/proposal-transport.ts`):
  in Piloti the HTTP client and the realtime channel, in the view `tools/call`
  through the host (`App.callServerTool`) and no channel. A
  `project_profile` proposal is not drawn: its card compares the patch with the
  live profile, which the frame cannot read; the view says so and sends the
  person to Piloti.
* **The link.** `proposal-get` carries `_meta.ui.resourceUri` (and the SDK's
  deprecated flat `ui/resourceUri` key, through `registerAppTool`). In `tools`
  mode that is its own tool. In `search` mode it is listed beside the four
  meta-tools, because a host links a view to a tool and `call-operation` runs
  every operation: putting the view on `call-operation` would frame every
  result. The catalog says which operations a view draws
  (`catalog/app-views.ts`, `drawsResultOf`).
* **The buttons.** Two app-only tools, `proposal-card-apply` and
  `proposal-card-dismiss` (`APP_TOOLS`), listed with
  `_meta.ui.visibility: ["app"]` and the view's URI. Each names the catalog
  operation it runs (`proposal-apply`, `proposal-dismiss`) and runs it through
  `executeOperation`, the path every door call takes: the read gate, the route
  as the person (`callOperation`, the acting session), its `authz`, its rate
  limit and its schema. A refusal carries the route's status in
  `structuredContent` (`{ status, code }`), so the card shows a 409 as the
  earlier decision it is. The status and code travel as data from
  `executeOperation` (`OperationRefusal`), never parsed from the message. A
  call is recorded with `decisionSource: app` when the client declared MCP
  Apps, `app-unverified` when it declared nothing (PostHog
  `agent_operation_called`, Langfuse `agent-tool-call`); the decision itself is
  the proposal's (`decidedBy`, audit `piloti.proposal.decided`), as for a press
  in Piloti. The view's data (`structuredContent`) is never dropped for length:
  only the text the model reads is capped (`VIEW_DATA_OPERATIONS`).
* **A model's own decision.** `proposal-apply` and `proposal-dismiss` stay
  operations an outside agent may call, and carry `personDecides`: on the
  2026-07-28 era, to a client that declares form elicitation, the call is put
  to the person first (`confirmThenRun`), as a destructive write is. A proposal
  the model would apply may itself delete. Elsewhere (the 2025 era, or a client
  without elicitation) the call runs as before, after the client's own
  confirmation of a write.
* **Every settled state is told to the model** (`ui/update-model-context`):
  "Piloti proposal X is applied by Anna; it is no longer open; do not apply or
  dismiss it", whether the card settled by the person's press, a 409's re-read
  or a replayed result that turned out decided, once per proposal and status.
* **A replayed result is re-read.** A host may hand the view a stored result
  (a conversation reopened later). With no realtime channel in the frame
  (`transport.live: false`), an open card reads the proposal once more in the
  background (`useServerProposal`), so a proposal decided since shows decided.
* **Who is offered the views.** MCP Apps 2026-01-26 negotiates on the
  client's side: the client declares `io.modelcontextprotocol/ui` with its
  `mimeTypes` in its capabilities, and servers SHOULD check before registering
  UI-enabled tools. On the 2026-07-28 era the capabilities ride on every
  request, so the door registers the resource, the link and the buttons only
  when they name `text/html;profile=mcp-app` (`declaresMcpApps`), and then
  echoes the extension in its own `capabilities.extensions` for a client that
  reads `server/discover` (the 2026-01-26 spec does not ask the server to). A
  2025-era request carries no capabilities (the door is stateless, there is no
  `initialize` to read them from), so every outside client is offered the
  views there, as below.

### Amends ADR-0065

The catalog's cards also render in external hosts. A card type is still drawn
by `A2uiCard` over the Piloti catalog, whichever host it is in; an MCP App view
is one more host of that renderer, never a second set of card components. A
view leaves out what it never draws: the A2UI catalog's `Text` leaf resolves
to a plain-text stand-in in a view's bundle (the answer's Markdown renderer
brings mermaid, KaTeX and the chat stores, about 7 MB), and only the three
dictionary namespaces its cards read are bundled
(`features/mcp-apps/*-stand-in.ts*`).

### Security

* **Sandbox and CSP.** The resource declares an empty CSP
  (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains` all
  `[]`) and no permission, so a host applies the spec's restrictive default:
  `default-src 'none'`, inline script and style only, `connect-src 'none'`,
  `frame-src 'none'`, `object-src 'none'`. The document loads nothing and
  connects nowhere; everything it says arrives in the tool result, and every
  action leaves through the host's `tools/call` to this server. The host's
  double-iframe sandbox (its origin, not ours) is the host's; we serve no page
  on our origin for it.
* **No tenant data in the template.** Asserted on the built file and on the
  served resource (the same bytes for two organizations).
* **What the model sees.** The card's buttons are not catalog operations: no
  `search-operations` hit, no `describe-operation`, `call-operation` answers
  "unknown". A conforming host keeps them from the model ("tools/list
  behavior: Host MUST NOT include tools in the agent's tool list when their
  visibility does not include model") and refuses them from another server's
  view.
* **What the server cannot know.** A `tools/call` from a view and one from a
  model look the same on the wire. The server does not treat a press as more
  than what it is: it runs `proposal-apply` as the person. The app-only tool
  grants nothing new; what it adds is that a host that follows the spec
  carries the person's click and not the model's guess. `decisionSource: app`
  is therefore the host's word, given by a client that declared it renders MCP
  Apps, and nothing more: unlike `elicitation`, whose yes is bound to an
  HMAC-signed `requestState` the server minted for that one call, nothing here
  proves a person pressed.
* **A host that does not render MCP Apps.** On the 2026-07-28 era it is offered
  none of it: no resource, no link, no button (`appHostOf`, tested). On the
  2025 era it lists the two app-only tools to its model as ordinary tools,
  their descriptions saying they are the card's buttons. A model's call of one
  runs `proposal-apply` or `proposal-dismiss` as the person, without the
  elicitation a model's direct call gets on the 2026-07-28 era, and is recorded
  `app-unverified`, never `app`. That is the 2025 era's limit, accepted here
  because the hosts that render MCP Apps today speak it, and recorded so a
  later slice can drop the views from 2025-era clients once those hosts move.
* **Piloti's own door and the platform door** get neither the resource, the
  link nor the buttons (`offersAppViews`, `isAppToolFor`): Piloti draws its
  cards itself and never decides a proposal (ADR-0105), and the platform door
  has no card.

### The host theming map

`features/mcp-apps/proposal-card/host-theme.ts`. The host's variables
(`hostContext.styles.variables`, MCP Apps "Theming") are set on the document
with the SDK's `applyHostStyleVariables`; then each Piloti token in
`HOST_TOKEN_MAP` whose host variable was given becomes `var(<host variable>)`:

| Piloti token | Host variable |
|---|---|
| `--background`, `--card`, `--popover`, `--background-color-surface-base` | `--color-background-primary` |
| `--muted`, `--secondary`, `--background-color-surface-raised`, `--background-color-surface-sunken` | `--color-background-secondary` |
| `--accent` | `--color-background-tertiary` |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` | `--color-text-primary` |
| `--muted-foreground`, `--text-color-secondary` | `--color-text-secondary` |
| `--text-color-subtle` | `--color-text-tertiary` |
| `--primary` (the one ink action) / `--primary-foreground` | `--color-background-inverse` / `--color-text-inverse` |
| `--destructive` | `--color-text-danger` |
| `--border`, `--border-color-base` / `--input` | `--color-border-primary` / `--color-border-secondary` |
| `--ring` | `--color-ring-primary` |
| `--radius` | `--border-radius-lg` |
| `--font-sans`, `--font-weight-*`, `--shadow-*` | the same names: the host's value applies directly |

A token the host does not give keeps Piloti's value; a host that gives
nothing gets Piloti's card. `hostContext.theme` sets Piloti's `.dark` class
and the SDK's `data-theme` / `color-scheme`, so a host's `light-dark()` values
and Piloti's dark tokens agree. The host's `--font-sans` names its family,
which applies where that family is installed; the host's `@font-face` rules
(`styles.css.fonts`) are not applied, since the empty `resourceDomains` CSP
would block a font served from the host's origin. The language is
`hostContext.locale` (`de-AT` → German).

### What is withheld

* **Every other card.** Only the proposal card is a view in this slice. The
  read cards (`document_grid`, `revision_compare`, a schematic) are the next
  slice, each its own resource.
* **The project-profile proposal**, as above: decided in Piloti.
* **Live updates.** No realtime channel reaches a host frame; a colleague's
  decision shows on the card's next read (a 409 re-reads), not live.
* **Links out** (`ui/open-link`), **messages into the chat** (`ui/message`),
  **display modes** beyond inline, and **app-provided tools** (the draft
  spec's view-registered tools): not used.
* **Piloti's own chat** keeps drawing its cards natively; an MCP App iframe
  inside Piloti would be an iframe outside the design system (ADR-0065's
  reason).

### Consequences

* Good, because a person deciding Piloti's proposal from their own assistant
  sees the card Piloti shows, with the same rules, and presses the button
  themselves.
* Good, because it is one route, one gate and one renderer: the view adds a
  transport, not a write path or a card.
* Good, because the theming follows the host where it says something and
  Piloti everywhere else, measured in the `/dev/mcp-apps` preview against the
  SDK's own `AppBridge`.
* Bad, because the document is about 1.7 MB with A2UI 0.14 (React, the SDK with its own zod,
  A2UI, the receipts, three namespaces in two languages), read once per
  connection; `view-build.spec.ts` holds it under 2 MiB.
* Bad, because on the 2025 era a host that does not render MCP Apps shows its
  model two more tools, and `search` mode lists seven tools instead of four to
  an MCP Apps client (five to its model).
* Bad, because the host decides what the frame looks like around the card and
  whether it renders at all; Cursor's reported regressions are outside our
  reach.
* Neutral, because `@modelcontextprotocol/ext-apps` is pinned at 2.0.3 (2.0.4
  and 2.1.0 were published hours before this change; the repo's cooldown is
  days). `@modelcontextprotocol/client` 2.3.1 is its required peer, at the
  door's own SDK version.

### Confirmation

* `frontends/ui/src/lib/agent-api/mcp-apps.spec.ts`: the resource is listed
  and read with `text/html;profile=mcp-app` and the empty CSP, the same for
  two organizations; `proposal-get` links to it in both modes and its result
  parses as the card's input; the buttons are app-only (the SDK host helper
  `isToolVisibilityAppOnly`), absent from search and refused by
  `call-operation`, and run `proposal-apply` / `proposal-dismiss` through
  `callOperation` as the person, with the route's status on a refusal (the
  route's, the read gate's and a thrown `ApiError`'s); Piloti and the platform
  door get none of it, and `isAppToolFor` refuses Piloti's audience; a
  2026-07-28 client that declared no MCP Apps gets none of it, a 2025-era press
  is `app-unverified`; a model's `proposal-apply` / `proposal-dismiss` asks the
  person first; a 50k-character proposal keeps its `structuredContent`.
* `frontends/ui/src/lib/agent-api/operation-proposals.integration.spec.ts`
  (`task db:test:rls`): against Postgres, a member without the right who
  presses the card's button (apply or dismiss) is refused with the route's 403
  and the proposal stays open; the admin's press decides it; a second press is
  the 409. A member who cannot read a target may not dismiss it in Piloti
  either.
* `frontends/ui/src/features/mcp-apps/proposal-card/proposal-card.e2e.spec.tsx`:
  the SDK's `App` and `AppBridge` and an MCP `Client` against the real door:
  the host's call of `proposal-get`, the card in the host's theme and language,
  a press that runs `proposal-apply` as the person, the model told; a replayed
  result decided since is re-read and shown decided.
* `vocabulary.spec.tsx`: every card the view draws, in both languages, with the
  view's three namespaces only. `view-build.spec.ts`: the built document loads
  nothing, carries no secret or origin, and stays under budget.
* `exposure.config.spec.ts`: an app-only tool is offered to a view and to no
  model, names an operation on the office door, and is in `exposure.json`.

## More Information

* Spec: `specification/2026-01-26/apps.mdx` and `specification/draft/apps.mdx`
  in `modelcontextprotocol/ext-apps` (read 2026-10-27); SDK docs
  `docs/migrate-to-2.md`, `docs/testing-mcp-apps.md`.
* **Found while proving the gate, and fixed in the same change.**
  `POST /api/proposals/[id]/dismiss` asked only the kind's right in the
  proposal's project (`requireDecider`), while `canDecide` also asks that the
  reader may read every target (`readsEveryTarget`). A member who could decide
  in the project but not read an operation proposal's target saw no buttons,
  yet a direct call dismissed it. Dismiss now asks
  `requireTargetsOfOperationReadable` as apply does
  (`lib/proposals/service.ts`), proven against Postgres.
* Revisit when: the draft's server-side metadata location becomes stable and a
  host reads only one of the two places; a host starts sending the UI
  capability on 2025-era requests; or the bundle passes 2 MiB (then option 3,
  a view-only card, is the better trade).
* Long form: [`docs/architecture/agent-surface.md`](../architecture/agent-surface.md#mcp-apps-cards-in-the-persons-own-assistant).
