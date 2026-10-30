---
status: accepted
date: 2026-10-29
decision-makers: product owner
consulted: the rename-planning and naming-audit consultants, the rebrand work packages
informed: everyone working in this repo, and every customer whose agent is connected to the workspace
---

# The product's name is copy and no identifier carries a brand: the product and its agent are ARCHOS

## Context and Problem Statement

The product has had four names: `AI-Q`, then `Grid`, then `Piloti`, now ARCHOS. <!-- brand-history -->
The agent inside it had the product's name too. Every rename so far was a code
change across thousands of lines, because the name sat in identifiers, paths,
routes, environment variables, stored values, MCP resource addresses, prompts
and copy alike. On 2026-10-29, before this change, the tree held about 14,000
hits of the retired names in text outside lockfiles, plus about 6,100 brand
words in identifiers across 1,100 paths. About 4,200 of the text hits are
history (ADRs, audits, release notes, migrations).

The owner decided three things that day. **One name everywhere** (D1): the
company, the product and its agent are ARCHOS, and no retired name is left
where a person or an agent reads it, except in history. **Brand-agnostic, not
"move to ARCHOS"** (D14): an identifier carries no brand at all, neither the old
one nor the new one; the brand is copy, read from one file, so the next rename
is one edit. **High impact only** (D22): rename what people and agents see now,
and do not sweep internal identifiers or migrate stored values for the rename's
sake.

Half of the machinery existed. `packages/brand/identity.json` held the brand's
strings and `scripts/check_brand_names.py` kept brands out of new identifiers
(ADR-0145 rule 5). What was missing: the UI and the agent each typed the name as
a literal, so did the service worker, the icons and the MCP server; nothing
counted the retired names in copy, prompts and docs; and no record said which
neutral name an identifier takes or which texts count as history.

## Decision Drivers

* **The next rename is one edit.** Changing `identity.json`'s `name` must reach
  every customer- and agent-visible surface with no further change, apart from
  history and static prose such as blog posts (D14).
* **An agent reads names too.** Tool ids, MCP resource addresses, error text
  and prompts are what an outside agent and our own agent act on.
* **History is not rewritten.** A dated record says what was true then, under
  the name it had then.
* **Cost follows impact** (D22). A stored value or an external contract costs
  three releases and a live-system change to rename; it is renamed when there
  is another reason to touch it, not for the rename alone.
* **Never invent a term** (D15). A neutral name is the standard's word or the
  plain word for the job. A name that needs explaining fails.

## Considered Options

* **A. Rename to the new brand everywhere.** Identifiers, paths and stored
  values move to `archos`.
* **B. The name is copy; sweep every identifier to a neutral name now**, stored
  values and external contracts included, by expand, switch and contract.
* **C. The name is copy; rename the visible surfaces now; freeze the existing
  identifiers in the ratchets and rename each when its file is touched.**
* **D. Change the copy only, and keep the old identifiers for good.**

## Decision Outcome

Chosen option: **C**, because it makes the next rename one edit for everything
a person or an agent sees, at the cost of this change and no migration.

* **A** rejects on its own premise: the brand changed four times, so an
  identifier that carries it moves again.
* **B** rejects on cost against impact: about 6,100 identifier hits, of which
  the stored and external ones (actor kinds, the document namespace, Qdrant
  aliases, WorkOS flags, Langfuse prompt and score names, MCP resource
  addresses) each need three releases and a change on a live system, while a
  customer sees none of them (owner decision D22, 2026-10-29). If that balance
  changes, for example when a contract is reworked anyway, the steps are below.
* **D** rejects because a frozen identifier then stays forever, even in a file
  someone is rewriting; renaming it on touch costs that change little.

The authoritative naming rules live in `docs/contributing/naming.md`.

### The rule

1. **No identifier carries a brand**: no retired name and not the current one,
   in a path, package, import, identifier, enum token, route, header,
   environment variable, table, event, metric, tool name, resource address,
   flag or stored key. It is named for what it does
   (`docs/contributing/code-conventions.md#no-brand-names`).
2. **The name is copy, read from `packages/brand/identity.json`.** Code reads
   `PRODUCT_NAME` (`apps/workspace/bff/brand.ts`, `agent.common.brand`), a
   dictionary string says `{productName}`, a prompt says `{{ product_name }}`.
   `node packages/brand/sync.mjs` copies `identity.json` beside each reader
   (the two apps and the agent's package) and writes the name into the few
   files that must spell it as a literal, because nothing can import there:
   the service worker's fallback notification title and the icons' SVG
   `<title>` (`packages/brand/name-copies.mjs`).
3. **Where the name may be written out**: `identity.json` and the brand
   package; first-impression documents (`VISION.md`, `README.md`, the user
   guides, the glossary); blog prose; release notes and ADRs, which are dated.
   Comments and engineering docs use the role noun: the agent, the workspace,
   the app.
4. **Existing identifiers are frozen, and renamed when touched.** Every
   identifier with a brand today is an entry in `ci/brand_names_baseline.json`;
   every retired name in text is an entry in `ci/brand_prose_baseline.json`.
   Neither may grow. A change that edits a file renames that file's branded
   identifiers it can rename safely, by the map below, and lowers the entries
   with `--update`. Nobody sweeps them for the rename alone. A name that is
   stored or that an outside client calls is renamed only with the steps
   under "If a stored or external name is ever renamed".

### What this change renames

Every surface that shows the name now reads it from `identity.json`: the UI's
`PRODUCT_NAME` and through it the dictionaries, the manifest, the tab title and
the PDF and Word exports; the agent's prompts; the service worker's fallback
notification title; the app icon's and the website favicon's `<title>`; the MCP
server's `title`, its connect-time instructions on both doors, and the OAuth
resource names a client shows while it signs in. The MCP server's `name`
becomes `workspace` and `workspace-platform`. A generated document or answer
export with no usable title is named `document-…` or `answer-…`.

### History is not rewritten

These keep the names they were written under, and the brand checks leave them
alone:

* ADRs 0001 to 0148, their filenames, and links to them. The cutoff is 0148
  (0148 was decided in parallel, under the old name, before this record took its
  number):
  a later record may quote an old name in backticks on a line marked
  `<!-- brand-history -->`, the way this one does.
* `docs/audit/`, every migration (Drizzle and Alembic), the RLS harness that
  replays them (`scripts/rls-test-db.sh`), the ratchet baselines, and the brand
  checks and their tests.
* Every release note that existed at the cutover (2026-10-29), and the note
  announcing the rename, listed in `ci/brand_history_manifest.txt`; their German
  entries in `releasenotes/translations/de.json`; the weekly summaries up to the
  cutover week.
* A document under `docs/` whose first line is `<!-- history: YYYY-MM-DD -->`
  with a date on or before the cutover.
* A legacy-compatibility module whose header says when it goes
  (`drop after release N`), for that one release.
* Git history.

ADR-0145 is amended only by a status line that points here; its body stays as
written.

### The neutral-name map, for renames on touch

The reference for a touch-time rename: the rename plan's map with the naming
audit's corrections (D15).

| Today | Neutral name |
|---|---|
| Agent package `agents/piloti/`, prompt `piloti.j2` | `agents/assistant/`, `prompts/system.j2`. "Chat" already means the conversation. The checkpointer restores graphs by module path, so the move needs an import alias for one release <!-- brand-history --> |
| Langfuse static prompt `piloti-system-static`, score names `piloti-*` | `assistant-system-static`; each score named for what it scores <!-- brand-history --> |
| Actor kind `piloti` (`author_kind`, `proposed_by_kind`, audit `by`) | `agent` <!-- brand-history --> |
| Inbox types `piloti.*` | `agent.*` <!-- brand-history --> |
| Mention id `agent:piloti` | `agent:assistant`, matching the package <!-- brand-history --> |
| WorkOS flag `piloti-wakes` (the agent answers in an annotation thread when addressed or delegated a mark) | `agent-thread-replies` <!-- brand-history --> |
| WorkOS flag `piloti-acts` (the agent changes marks itself when asked, instead of proposing) | `agent-direct-edits`; reason code `piloti-acts-off` becomes `agent-direct-edits-off` <!-- brand-history --> |
| WorkOS flag `piloti-notices` (a new revision is compared with the last and the changes left as proposed marks) | `revision-suggestions` <!-- brand-history --> |
| WorkOS flag `piloti-ask` (another agent asks the agent a question) | `agent-requests`; `piloti-asks.ts` becomes `agent-requests.ts` <!-- brand-history --> |
| MCP resources `piloti://guide`, `piloti://catalog`, `piloti://glossary`, `piloti://operation/…`, `piloti://project/{id}` | `workspace://…` <!-- brand-history --> |
| MCP Apps resource `ui://piloti/proposal-card`, app ids `piloti-proposal-card`, `piloti-dev-host` | `ui://workspace/proposal-card`, `proposal-card`, `dev-host` <!-- brand-history --> |
| Header `x-piloti-mcp-mode` | Dropped: RFC 6648 retires the `X-` prefix, and the mode is already the `?mode=` query parameter <!-- brand-history --> |
| Scope `piloti:sensitive` | `documents:sensitive` <!-- brand-history --> |
| OpenAPI extension `x-piloti-sensitivity` | `x-sensitivity` (an OpenAPI extension, not an HTTP header) <!-- brand-history --> |
| Exposure field `piloti:`; trace door value `piloti` | `firstParty:` beside `external:`; `first-party` <!-- brand-history --> |
| `pilotiChanges`, `pilotiWork`, `pilotiWakes`, `PILOTI_ACTS_OFF`; route `api/piloti-changes/[id]/undo` | `agentChanges`, `agentWork`, `threadReplies`, `AGENT_DIRECT_EDITS_OFF`; `api/agent-changes/[id]/undo` <!-- brand-history --> |
| Service worker messages `piloti:navigate`, `piloti:close-notifications`, tag `piloti-inbox` | `navigate`, `close-notifications`, `inbox` <!-- brand-history --> |
| Browser key `aiq-chat-store` | `chat-store` <!-- brand-history --> |
| i18n keys `review.piloti.*` and siblings | `review.agent.*` <!-- brand-history --> |
| Skills `piloti-voice`, `piloti-cards`; metadata keys `grid-agents`, `grid-catalog`, `grid-hidden`, `grid-cards` | `tone-of-voice`, `answer-cards`; `agents`, `catalog`, `hidden`, `cards` <!-- brand-history --> |
| Project setup `piloti` | `agent` (`self` stays) <!-- brand-history --> |
| RLS settings `grid.organization_id`, `grid.user_id` | `app.organization_id`, `app.user_id` <!-- brand-history --> |
| Qdrant aliases `piloti_corpus`, `piloti_office`; export format `piloti-vectors/1` | `corpus`, `organization` (an office is an organization here); `vectors/1` <!-- brand-history --> |
| Document namespace `piloti/` | `generated/`: what the agent wrote, not who it is <!-- brand-history --> |
| Diagram attribute `data-grid-diagram-source` | `data-diagram-source` on write; the reader keeps accepting the old one, as stored documents carry it <!-- brand-history --> |

Not in this map: the persisted names of ADR-0145 row 10d (`aiq_jobs`,
`aiq_checkpoints`, role `aiq`, volume `aiq-data`, the vector metadata keys), the <!-- brand-history -->
tier names of ADR-0145 row 10c, and the infrastructure names of ADR-0147, which
keep their own plans.

### What stays allowed

* The repository's own name and URLs (`archos-at/archos`), host names and
  e-mail addresses. The domain moves by D2, when an operator switches it.
* The infra-pending names: the old deploy tiers until ADR-0145 row 10c, the
  Pulumi names until ADR-0147's contract step, and the old domain until the
  owner's cutover.
* Each legacy-name module for its one release.
* **Legal continuity** (owner decision D23, 2026-10-29): the in-app legal notices
  (`apps/workspace/bff/legal/content/de.ts`, `en.ts`) and the website's privacy
  page (`apps/website/src/i18n/pages/privacy.ts`) name the former name beside the
  current one, as „ARCHOS (vormals `Piloti`)“ or "ARCHOS (formerly `Piloti`)", <!-- brand-history -->
  so a person who signed up under it sees the notice covers them. The prose check
  allows the former name in those three files and in that parenthesis only.

### If a stored or external name is ever renamed

Not scheduled (D22). When a touch reaches a name that is stored or that an
outside client calls, it moves in three releases, the pattern of migrations
0189 to 0191, `legacy-header-names.ts` and ADR-0147: **expand** (readers accept
both names, all old names in one legacy module per surface), **switch** (the
senders that deploy separately move, and a release note announces the
deprecation), **contract** (after the owner confirms the release has run, a
separate change deletes the legacy module and lowers both baselines). The
document namespace is the join key between a row and its vectors and the purge
path deletes by it, so its backfill runs only with the owner's sign-off.

### Consequences

* Good, because a rename is one edit to `identity.json` and one run of
  `sync.mjs`, and a test proves it (the rename drill).
* Good, because the agent and the UI cannot disagree on the name: both read
  the same file.
* Good, because the retired names can only shrink: both ratchets refuse a new
  occurrence anywhere, and their baselines only go down.
* Good, because no stored value, live system or connected client changes in
  this decision.
* Bad, because a connected agent still reads retired names in MCP resource
  addresses, tool ids and a few error codes until each is touched.
* Bad, because the prose baseline starts at about 14,000 hits in about 1,900
  files, and every copy change must lower it with `--update`.
* Bad, because "rename when you touch it" makes a small change slightly
  larger, and a reviewer has to check that a rename did not reach a stored or
  external name without its three steps.

### Confirmation

* `tests/test_product_name_parity.py`: every `identity.json` copy equals the
  source; `agent.common.brand.PRODUCT_NAME` and the UI's `PRODUCT_NAME` (run
  through bun) equal its `name`; `brand.ts` reads `identity.name`, never a
  literal; the service worker's and the icons' titles carry the name; the MCP
  server's titles and instructions use `PRODUCT_NAME`. The **rename drill**
  copies the brand package and every derived surface to a scratch tree, changes
  `name`, runs `sync.mjs` once and checks every surface carries the new name.
* `node packages/brand/sync.mjs --check` (in the website's `npm run check`) and
  `build-brand-assets.mjs --check` fail a stale copy.
* `scripts/check_brand_prose.py` (the `brand-prose` hook in `task lint:repo`
  and CI's **Repo checks** job) against `ci/brand_prose_baseline.json`: the
  retired names as words, and the current name typed out in code and the
  dictionaries. A file may not gain a hit, a new file may not have one, and
  `--rebaseline` refuses to raise the total. Its target is `{}`.
* `scripts/check_brand_names.py` keeps brands out of identifiers, as before.
* **End state, not enabled yet**: a CI assertion that every key left in
  `ci/brand_names_baseline.json` is on an explicit infra-pending list. It would
  fail today, so it is switched on when the touch-time renames have brought
  the baseline down to the infra-pending names above.

## More Information

* Owner decisions D1, D2, D13, D14, D15 and D22, 2026-10-29.
* The rule this extends: ADR-0145 rule 5. The infrastructure half: ADR-0147.
* The checks: `docs/contributing/code-conventions.md#no-brand-names`.
