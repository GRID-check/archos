# Naming

How to name anything in this repository: a file, an identifier, a route, an
environment variable, a table, an event, a flag, a tool an agent calls. This
page is the one source. Scoped guides and other docs link here and keep at
most one line about naming.

## The explain test

The owner's rule (D15, 2026-10-29): "never make up terms for stuff that already
exists; if a term needs to be explained it fails. DX and agent experience
dictate."

Take the first name on this list that fits:

1. **The standard's word.** The spec, the RFC or the vendor's own name for the
   thing: MCP tool and resource, OAuth audience (RFC 8707), actor and subject
   (RFC 8693), A2A `Task`, OpenAPI operation, W3C Web Annotation, a WorkOS
   organization, a PostHog `$pageview`, a Qdrant collection.
2. **The domain's word**, for architecture and building law: German in copy and
   domain data, its English code name from the
   [glossary](../glossary.md#german-domain-term-english-code-name).
3. **A plain name for the job**, in ordinary English: `retry_delay_seconds`,
   `revision-diff.ts`, `MAX_ACTIVE_JOBS_PER_ORG`.

There is no fourth rung. A word coined here, however well a glossary row
defines it, is a translation every agent and every new colleague pays for. The
test: show the name to someone with no context, a new colleague or an outside
agent. If they need a sentence to know what it is, it fails. A glossary row
that has to say what a term is *not* is the usual sign.

A pull request that adds a name says which rung it stands on: the standard it
cites, or "plain English". Choosing otherwise needs an ADR
([`AGENTS.md`](../../AGENTS.md), "Industry standard first").

Which rules govern which text:

| Text | Language | Word rules, and what holds them |
|---|---|---|
| Identifiers, files, folders, routes, env vars, tables, events, flags | English, no brand | This page |
| What an agent reads: operation names, descriptions, schemas, refusals, MCP instructions, cards over the wire | English, one word per concept | The [agent-surface table](../glossary.md#agent-surface-and-standard-terms); `bff/agent-api/english-only.spec.ts` |
| UI copy | German and English, through i18n | Domain terms in [`CONTEXT.md`](../../CONTEXT.md); German copy rules in [`packages/brand/README.md`](../../packages/brand/README.md), which keep "Agent" and "LLM" out of German public copy, not out of the English agent surface |
| Public release notes | Plain words for architects | `PUBLIC_JARGON` in `scripts/release_notes.py`; [`release-notes.md`](release-notes.md) |
| Comments, docstrings, engineering docs | English; a German domain word appears with its code name | The `unslop` skill, and [House words](#house-words) below |

## No brand in a name

Decided in [ADR-0148](../adr/0148-the-product-name-is-copy-and-identifiers-carry-no-brand.md).

- **No code or infrastructure name carries a brand**, retired or current: no
  `aiq`, `grid`, `piloti` or `archos` in an identifier, file or folder, <!-- brand-history -->
  environment variable, route, header, table, metric, event, resource, flag,
  stored key or tool name. Name it for what it does: a reply job, not a
  branded one; `MAX_ACTIVE_JOBS_PER_ORG`, not the same name with a prefix.
- **The name is copy, read from `packages/brand/identity.json`.** Code reads
  `PRODUCT_NAME` (`apps/workspace/bff/brand.ts`, `agent.common.brand`), a
  dictionary string says `{productName}`, a prompt says `{{ product_name }}`.
  `node packages/brand/sync.mjs` copies the file beside each reader and writes
  the name into the few files that must spell it as a literal
  (`packages/brand/name-copies.mjs`). A rename is one edit and one sync;
  `tests/test_product_name_parity.py` runs that drill.
- **Comments and engineering docs use the role noun**: the agent, the
  workspace, the app. The name is written out only in the places ADR-0148
  lists (the brand package, first-impression documents, blog prose, release
  notes, ADRs).
- **Two ratchets hold it**, both in `task lint:repo` and CI's **Repo checks**
  job. Each records every file's hits when it arrived; a file may not gain one,
  a cleanup fails the check until `--update` lowers the entry, and a move
  re-keys entries with `--rebaseline`, whose diff must show only the move.
  - Identifiers: `scripts/check_brand_names.py` against
    `ci/brand_names_baseline.json`. A directory is its own key, so a new file in
    an old directory passes and a new branded folder fails. Not a hit: a brand
    as a bare word in prose, `grid` the CSS word (`FileGrid`, `grid-cols-2`),
    URLs, host names, the repository's own name. Not checked: ADRs, audits,
    release notes, migrations, the i18n dictionaries, site content, Markdown
    (`EXCLUDED` in the script).
  - Text: `scripts/check_brand_prose.py` against `ci/brand_prose_baseline.json`,
    over every tracked text file. It counts a retired name as a word, and the
    current name typed out where `{productName}` or `PRODUCT_NAME` belongs.
    History keeps its names and is not counted (ADRs up to 0147, audits,
    migrations, the release notes in `ci/brand_history_manifest.txt`, a `docs/`
    file whose first line is `<!-- history: YYYY-MM-DD -->`). A later record
    may quote an old name in backticks on a line marked `<!-- brand-history -->`.
    The legal notices may name the former name in one parenthesis (D23).
    `--summary` prints the hits by directory. The target is an empty baseline.
- **Rename when you touch it.** The names in both baselines are frozen, not
  swept (D22). A change that edits a file renames the branded names in it that
  it can rename safely, using
  [ADR-0148's neutral-name map](../adr/0148-the-product-name-is-copy-and-identifiers-carry-no-brand.md#the-neutral-name-map-for-renames-on-touch),
  and lowers the entries with `--update`. A stored name, or one an outside
  client calls, is not renamed in passing: it follows
  [Renaming a name someone else reads](#renaming-a-name-someone-else-reads).
- The end state of the identifier ratchet is a baseline holding only the
  infra-pending names ADR-0148 lists. A name whose rename is already scheduled
  by script is left out of the count by name, with the ADR row that renames it
  (`PENDING_INFRA_NAMES` in the check), so a split or move inside it does not
  read as new hits; the scripted rename deletes the entry.

## English only

Every name in code is English, domain words included: `profile-review.ts`,
never `steckbrief.ts`; `buildingClass`, never `gebaeudeklasse`. German lives in
the i18n dictionaries and in domain data (document names, addresses, legal
citations). The German-to-English table, and the few stored keys that still
read German with the reason each one stays, are in the
[glossary](../glossary.md#german-domain-term-english-code-name); do not copy
them here. A German name you meet is a rename in your change; a persisted
German key moves with its migration and the agent's side in the same change.

`tests/test_english_names.py` (Python) and
`apps/workspace/tests/english-names.spec.ts` (TypeScript) are per-file ratchets
on identifiers with the German stems in `ci/german_stems.json`.

## Casing and form

| Family | Form | Example | Held by |
|---|---|---|---|
| Python modules, packages, files | `snake_case`; tests `test_<subject>.py`; shared test helpers in a `<distribution>_testing` package | `revision_diff.py`, `test_check_brand_prose.py` | Review; `tests/test_test_imports.py` for test helpers |
| Python identifiers | PEP 8: `snake_case` functions and variables, `PascalCase` classes, `UPPER_SNAKE` constants | `render_grounding_block`, `GroundingHit`, `SOURCE_KINDS` | Review (ruff runs no naming rules here) |
| TypeScript and JavaScript files | `kebab-case`; a spec beside it as `<name>.spec.ts`; generated files `*.generated.ts` | `revision-links.ts`, `time-ago.tsx` | Review. `apps/workspace/ui` still holds PascalCase `.tsx` files; a new file is kebab-case |
| TypeScript identifiers | `camelCase` values and functions, `PascalCase` types, classes and components, `UPPER_SNAKE` module constants; hooks `useX` | `cadenceOf`, `RunBlock`, `OFFICE_TIME_ZONE`, `useVisualViewport` | Review |
| Astro components and views | `PascalCase.astro` (Astro's own convention); route files follow the URL | `HomeView.astro`, `DuoCards.astro` | Review |
| CSS classes and custom properties | `kebab-case`; brand components `ui-*`; tokens `--name`, scales `--<scale>-<step>` | `ui-button`, `--ink`, `--space-4`, `--radius-control` | Review; `sync.mjs --check` for the brand copies |
| Routes and URL paths | `kebab-case` English segments, plural collections, `[id]` parameters | `/api/projects/[id]/project-record`, `/app/office-shelf` | Review. The website's German paths are copy, one row each in `src/i18n/paths.ts` |
| Environment variables | `UPPER_SNAKE`, no brand. Not a bare word another tool reads (`ROLE`, `VERBOSE`), not inside another tool's prefix (`LANGFUSE_`, `SERVICE_`). A vendor's own variable keeps its spelling | `PROCESS_ROLE`, `TRACE_RETENTION_DAYS`, `WORKOS_CLIENT_ID` | `brand-names`; review. A row in [`environment-variables.md`](../deployment/environment-variables.md) (`env-docs` hook for the queue workers) |
| HTTP headers | Lowercase `kebab-case`. A new header has no `X-` prefix (RFC 6648); the existing `x-*` service headers keep it until a touch moves them | `x-internal-token` (existing) | Review |
| OpenAPI extensions | `x-<name>`: the spec's own mechanism, not an HTTP header | `x-sensitivity` | Review |
| MCP operations (tools) | `kebab-case` `<entity>-<verb>`, under 52 characters, unique | `document-revision-compare`, `task-run-cancel` | `agent-reachability.spec.ts`, `backend-operations.spec.ts` |
| MCP resource URIs | `<scheme>://<path>`; MCP Apps views `ui://<server>/<view>` | target `workspace://catalog`, `ui://workspace/proposal-card` (today's resources still carry the retired scheme, see ADR-0148) | Review |
| JSON on the wire | `camelCase` keys over HTTP and the chat socket; Python keeps `snake_case` inside and aliases at the model. A list's key is the plural entity, a single item's the singular (ADR-0131) | `{ "taskRuns": [...] }`, `{ "taskRun": {...} }` | Zod and Pydantic schemas; `tests/fixtures/openapi.json` |
| Database tables and columns | `snake_case`, tables plural; Drizzle's TypeScript properties `camelCase` | `task_runs.requester_user_id` | Review; `rls-coverage.spec.ts` by table name |
| Constraints, indexes, policies | Postgres's default shape: `<table>_<columns>_<pkey\|key\|fkey\|idx\|check>` | `projects_status_check` | Review |
| Postgres settings (GUCs) | `app.<name>` | target `app.organization_id` (today's `grid.*` names are frozen, ADR-0148) | `task db:test:rls` |
| Product analytics events | The SDK's built-in event first (`$pageview`, `$pageleave`, `$autocapture` with `data-ph-capture-attribute-*`, web vitals; D18). A custom event only where the SDK cannot see the action: `snake_case` `<object>_<verb in past tense>`, properties `snake_case` and never personal | `agent_operation_called`, `user_signed_in` | The closed unions `PostHogEvent` and `ServerEvent` (a typo fails the build); a row in [`posthog-events.md`](../observability/posthog-events.md) |
| Langfuse scores and prompts | `kebab-case`, named for what they score or hold | `answer-grounded`, `citation-health` | `SCORE_DEFINITIONS`; `test_langfuse_scores.py` |
| Feature flags | WorkOS slug in `kebab-case`, named for what it gates; the code constant is the slug in `UPPER_SNAKE` | `folder-cards` / `FOLDER_CARDS`, `image-upload` | Review; registered in [`workos-provisioning.md`](../deployment/workos-provisioning.md) |
| Permissions and audit actions | WorkOS's `org:<area>:<action>` with a `snake_case` area; audit actions dotted with `snake_case` segments | `org:office_shelf:manage`, `office_shelf.document.deleted` | `bff/authz/catalog.ts`; review |
| i18n keys | Dotted; the first segment is the namespace, later segments `camelCase` | `sharing.resourceTypes.document` | `key-coverage.spec.ts` (every key in every dictionary) |
| Test ids | `kebab-case` | `data-testid="access-chip"` | Review |
| Qdrant collections and aliases | `snake_case`, named for what they hold | `corpus` | Review |
| Repo lint rules | `kebab-case` rule under one plugin namespace | `require-tenant-cache-key` | `lint-config.spec.mjs` |
| Branches | Cut from `develop`; a prefix and a short `kebab-case` description (`claude/<slug>` for agent work) | `claude/archos-rebrand-docs` | Review |
| Commits and PR titles | Conventional Commits; the scope, when there is one, is the area in lowercase | `fix(ui): …`, `docs(contributing): …` | The **Conventional PR title** job (type only) |
| ADRs | `NNNN-short-kebab-title.md` | `0148-the-product-name-is-copy-….md` | `scripts/check_adrs.py` |
| Release-note slugs | `kebab-case`, through `task release:note -- <slug>` | `re-index-projects` | reno |

## One word per concept

One concept has one word, in code, in docs and in what an agent reads. The
glossary defines each word; this table settles the ones the repo used two ways.

| Concept | Use | Not | Note |
|---|---|---|---|
| One state of a document in its timeline (Fassung) | `revision` | `version` | |
| A revision's approval record (Freigabestatus) | `version`, in the existing names only (`document_versions`, `document-version-*`) | `version` for anything else | "Version" for an approval record inverts the usual meaning; the rename to `approval` is [under review](#terms-under-review) |
| A note on one page of a revision, with its thread (Anmerkung) | `annotation` (W3C Web Annotation) | `mark` | The agent's canvas tools still say `marks`/`mark`, under review |
| The customer's account in WorkOS (Büro) | `organization` in identifiers (`organization_id`) | `office` | "Büro"/"office" stays in copy. Existing `office*` names that are established domain glosses stay: `officeShelf` (Büroablage) |
| A thread with the agent and people in it | `conversation` (A2A `contextId`) | `chat`, `thread` | "Chat" names only the UI surface and the chat socket, never a package or an agent |
| The source family that drives rendering | `SourceKind` | "provenance signal" | |
| Request-scoped organization context | tenant context (`withTenant`, `MissingTenantContextError`) | "tenant slot" | |
| A unit of work | task (definition), task run (one attempt), job (a claim-queue row) | job for a task, task for a queue row | [Glossary](../glossary.md#agent-surface-and-standard-terms) |
| The product's own agent | the agent; `agent` as an actor kind | the product name | An outside agent is an "external agent" (`external_agent`) |
| Soft-deleted documents (Papierkorb) | trash, the word Google Drive and macOS use | `bin` | Today's names are `document-bin` and `/dev/bin`, under review |

## Renaming a name someone else reads

A name is a contract when it is stored (a column value, a browser storage key,
a vector collection, a checkpoint's module path, an export format) or when a
deployed tier or an outside client reads it (an MCP tool or resource, a header
between the BFF and the backend, a WorkOS flag, an analytics event). Such a
name is never renamed in place.

| Step | What happens | Where it lives |
|---|---|---|
| Expand | Every reader accepts the old and the new name. All old names of a surface sit in one legacy module, whose header says `drop after release N` | `RENAMED_OPERATIONS` (operations), `bff/http/legacy-header-names.ts` and `agent_host.legacy_headers` (headers), `adopt_legacy_names` and `legacy-env-names.cjs` (env vars), migrations 0189 to 0191 (stored values) |
| Switch | The writers and senders that deploy separately move to the new name, a release later; a release note announces the deprecation | |
| Contract | After the owner confirms the release has run, a separate change deletes the legacy module and lowers both baselines | |

What each kind of name costs:

- **Browser storage keys.** A renamed `localStorage` key silently resets that
  state for every user. Read the old key once, write the new one, then drop the
  old one.
- **Python packages under `agents/`.** The checkpointer restores graphs by
  module path, and plugin discovery reads installed entry points, so a moved
  package needs an import alias for one release (gotcha: `ModuleNotFoundError:
  No module named 'agent.agents.<old name>'`).
- **Externally visible names** (an MCP tool, a public route, an analytics
  event) keep the old name as an alias for one release, never a hard break.
- **A rename across the tree** starts from a reviewed token map that also lists
  what is kept on purpose (env vars, headers, stored keys, wire names).
  Anything not on the keep list is renamed; anything on it stays.
- **Dropping a prefix** can land on a bare name another process already reads.
  Check every bare name against the other tiers first, and give a colliding one
  a descriptive name (`PROCESS_ROLE`, not `ROLE`).

## House words

Two words the `unslop` skill bans as metaphors, decided here:

| Word | Decision | Why |
|---|---|---|
| ratchet | Keep, for a check whose baseline only falls (`check_file_size.py`, `check_brand_*.py`, the German-names specs). Say "baseline" when you mean the file | Common engineering usage for exactly this mechanism, the owner's own word (D22), and a page behind it: [`correction-ratchet.md`](correction-ratchet.md) |
| substrate | Do not use. Say what it is: the sharing layer, the shared code, the base module | It needs explaining, so it fails the explain test |

## Terms under review

Proposals for the owner. Nothing here is renamed yet: each needs the owner's
yes and, for a stored or external name, the three steps above. **High**
priority means an agent reads the term today and a standard word exists. The
brand-word renames are in ADR-0148's map, not here.

| Term today | Where | Proposed name | Priority |
|---|---|---|---|
| "agent door" in tool descriptions | `catalog/platform.ts:806`, `catalog/documents.ts:26` (`SIZE_NOTE`) | "the MCP server", or drop the phrase | High |
| canvas tools `marks`, `mark` | `packages/agent/src/agent/tools/canvas/register.py` | `annotations`, `annotation` | High |
| `document-bin` operation, `/dev/bin` | `catalog/documents.ts:98` | `document-trash`, `/dev/trash`, old name aliased one release | High |
| `## Trace-Lanes` heading in tool results | the grounding block (`common/grounding_block.py`), parsed in `deep_researcher/custom_middleware.py` | `## Collections searched` | High |
| `document-version-*` operations, `document_versions` | `catalog/`, `bff/db/schema/documents.ts` | `document-approval-*`, `revision_approvals` | High |
| `agent-ask-*` operations, `agent_asks` | `catalog/consult.ts`, `catalog/index.ts` | `agent-request-*`; A2A calls the unit a Task | High |
| door (`AgentDoor`, `doorOfPrincipal`, `agent-api/door/`) | `bff/agent-api/` | MCP server (`McpServer`, `agent-api/mcp/`); the audience is the OAuth audience (RFC 8707) | Medium |
| wake (`lib/annotations/wake*.ts`) | annotations | thread reply, matching the flag `agent-thread-replies` in ADR-0148 | Medium |
| acts, notices, ask (flag words) | WorkOS flags, constants | `agent-direct-edits`, `revision-suggestions`, `agent-requests` (ADR-0148) | Medium |
| lane (retrieval group, queue partition) | `norm_registry`, `claim.lane`, `PLATFORM_LANE` | collection (Qdrant) for retrieval; queue for the partition | Medium |
| exposure (`exposure.config.ts`, `tests/fixtures/exposure.json`) | `bff/agent-api/` | visibility, the glossary's own gloss | Medium |
| withheld (`withheld: { category, reason }`) | `exposure.config.ts` | `hidden: { category, reason }` | Medium |
| answer envelope (`answer_envelope.py`) | agent, prompts | structured answer | Medium |
| pinned session (`resolvePinnedRequesterSession`) | `bff/auth/` | resolved session (`resolveRequesterSession`) | Low |
| tenant slot (`runWithTenantSlot`, `TenantSlot`) | `bff/` | tenant context (`runWithTenantContext`) | Low |
| locus | agent ledger, docs | location; W3C Web Annotation's target and selector | Low |
| spectator | chat | viewer | Low |
| Jev | agent-host docs | turn decision model | Low |
| stage (post-answer stage, `StageSpec`) | agent, BFF | post-answer step | Low |
| workspace primitive | AGENTS.md, ADR-0055 | capability API | Low |
| search mode | MCP server `?mode=` | meta-tool mode; `search` stays accepted | Low |
| `grid/*` lint rule prefix | `apps/workspace/.oxlintrc.json`, `eslint-rules/` | a brand-free plugin namespace | Low (brand rule; rename on touch) |

Kept after review: `shelf` (the domain's Ablage), `card` (the answer block,
CONTEXT.md), `room` (Liveblocks' word), `intake`, `inbox`, `skill`, `proposal`,
`steering` (some agent runtimes use it; no MCP or A2A word exists).

## What holds each rule

| Rule | Held by | Review only? |
|---|---|---|
| No brand in an identifier | `scripts/check_brand_names.py` (`brand-names` hook) | |
| No retired name in text, no typed-out current name | `scripts/check_brand_prose.py` (`brand-prose` hook) | |
| The name has one source | `tests/test_product_name_parity.py`; `sync.mjs --check` | |
| No German stems in identifiers | `tests/test_english_names.py`, `english-names.spec.ts` | File names, routes and string tokens are review only |
| English on the agent surface | `bff/agent-api/english-only.spec.ts` | |
| Operation names | `agent-reachability.spec.ts`, `backend-operations.spec.ts` | |
| Event names | `PostHogEvent` and `ServerEvent` unions | Event shape and SDK-first are review only |
| i18n keys present everywhere | `key-coverage.spec.ts` | Key shape is review only |
| ADR file names | `scripts/check_adrs.py` | |
| Commit type in the PR title | **Conventional PR title** job | Scope is review only |
| The explain test, standard first, one word per concept | | Review only |
| Casing of files, identifiers, routes, env vars, headers, tables, flags, test ids, branches | | Review only |
| Expand, switch, contract for stored and external names | Each legacy module's own spec | The decision to alias is review only |
