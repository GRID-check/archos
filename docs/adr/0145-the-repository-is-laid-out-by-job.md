---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The repository is laid out by job: apps, packages, contracts, evals, and no brand names

## Context and Problem Statement

A new colleague or agent should understand this repository from `ls`. Today the
top-level names describe the NVIDIA AI-Q blueprint the repo was forked from,
not what is in it:

- **`frontends/` holds Python.** Next to the UI (`frontends/ui`) and the landing
  site (`frontends/web`) sit the backend host (`frontends/aiq_api`) and the eval
  harnesses (`frontends/benchmarks`). In AI-Q a "frontend" was anything that
  drove the agent. Here, two of the four are not frontends. (#1246 already
  deleted the blueprint's debug console, command-line client and three
  inherited benchmarks.)
- **`sources/` mixes a library and adapters.** `knowledge_layer` is the
  ingestion and retrieval library the agent is built on; `ris_adapter` and
  `tavily_web_search` are thin NAT plugins in front of outside services. The
  word "sources" describes none of them. Worse, 338 lines import through the
  directory (`from sources.knowledge_layer.src.… import`), so one module has
  two identities: `knowledge_layer.X` as installed and
  `sources.knowledge_layer.src.X` by path.
- **The agent sits at `src/aiq_agent`**, the one package with no folder of its
  own. Its tests are in `tests/aiq_agent`, and its distribution is the root
  `pyproject.toml`, described as "NVIDIA AI-Q Blueprint".
- **The BFF is hidden inside the UI.** Domain modules, the Drizzle schema, the
  claim queues and the services behind every `/api` route live in
  `frontends/ui/src/lib`, beside `features/` and `components/`. Of the 937
  modules in `lib/`, 403 import `server-only`; the folder's name says nothing
  about which side runs it.
- **`shared/` is three things**: cross-language schemas (`cards/`, `wire/`) and
  one brand SVG that the site's build script renders into both apps.
- **"aiq" is everywhere and means nothing.** 13,000 lines carry it
  (case-insensitive, excluding `tests/.test_durations`): `aiq_agent` on 9,497
  lines in 1,336 files, `aiq_api` on 1,345 in 361, the Kubernetes names
  `aiq-agent` and `aiq-api` on 331 and 178, 87 `AIQ_` environment variables,
  and names that are persisted (Postgres databases, vector metadata keys, a
  browser storage key). ADR-0082 decided to drop it (step D) without saying
  where things land.

Moves are cheap per file and expensive per reference, and every open PR that
touches a moved file conflicts: 121 PRs merged in the week to 2026-10-26, and 33
were open on 2026-10-27. Measured on `develop` at 39f8628 with
`git grep -F <path> | wc -l`, excluding `tests/.test_durations`:

| Path today | Lines naming it | Files |
|---|---|---|
| `frontends/ui` | 1,464 | 460 |
| `src/aiq_agent` | 720 | 292 |
| `sources/` | ~390 (444 raw, ~56 are `resources/` and the like) | 153 |
| `tests/aiq_agent` | 299 | 184 |
| `frontends/aiq_api` | 220 | 115 |
| `shared/cards` + `shared/wire` + `shared/brand` | 223 | 122 |
| `frontends/benchmarks` + `tests/benchmarks` | 140 | 69 |
| `frontends/web` | 122 | 77 |
| `tests/knowledge_layer_tests` | 78 | 43 |
| `plans/` | 21 | 16 |

`tests/.test_durations` is excluded because it is generated
(`task be:test:durations`), not edited. It alone carries 1,418 references to
`src/aiq_agent` and 343 to `sources/`, which is why earlier tallies of "2,138"
and "787" were higher. Inside the UI, 7,819 imports read `@/lib/…` and 2,074
`vi.mock('@/lib/…')` calls name a module by that specifier; changing the alias
would touch every one of them for no gain.

## Decision Drivers

* A directory name says its job. `ls` at the root, and one level down, is
  enough to find where a thing lives.
* One word per concept (AGENTS.md): a directory, its task namespace, its CI
  tier, its image and its Kubernetes workload use the same word.
* Nothing is named after the AI-Q blueprint at the end.
* **Next.js is the only host of the UI and the BFF: one app, one image, one
  HTTP entrypoint** (ADR-0003). `server.js` is Next's custom-server mode (it
  runs Next's request handler in-process and proxies the chat socket to the
  backend), not a second server. The workers, scheduler and purger are
  process types of the same image, not servers. This record pre-cuts nothing
  for a split.
* Each move is a pure rename where it can be, so git's rename detection
  carries open branches across it. Where content has to change, it is its own
  commit or its own row.
* A skipped CI job counts as passed, so a move that forgets a path filter or
  the affected-test selection silently stops testing the moved code.
* Industry vocabulary: `apps/` and `packages/` is the layout Turborepo, Nx,
  pnpm and uv workspaces document, so a newcomer has seen it before.

## Considered Options

1. Do nothing; keep explaining the names in `where-is-what.md`.
2. The tree as first sketched: `tools/evals` and `tools/scripts`,
   `packages/adapters/{ris,web-search}`, the BFF in `server/`.
3. The same tree with four changes: `evals/` at the top and `scripts/` left
   where it is; adapters flat under `packages/`, named after their
   distribution; the BFF in `bff/`; the brand in `packages/brand`.
4. One big-bang PR that does every move and the rename at once.

## Decision Outcome

Chosen option 3, because it gets the clean `ls` for about 800 fewer edited
lines than option 2, keeps one rule for every package directory, and does not
put a `server/` folder next to `server.js`.

### The target tree

```
apps/                     things that run: each is an image, with its Dockerfile beside it
  workspace/              the Next.js app, UI and BFF in one image (was frontends/ui)
    app/                  Next routes: pages, layouts, thin /api route handlers
    ui/                   client code: features, components, hooks, styles, adapters
    bff/                  the BFF: domain modules, db schema, authz, queues (was src/lib); @/lib/* points here
    i18n/  shared/        read by both ui/ and bff/: dictionaries, card types, request limits
    migrations/           Drizzle migrations (was drizzle/)
    workers/  scheduler/  purger/  observability/   entrypoints of the image's other process types (unchanged)
    tests/                specs and harness, with test-utils/, mocks/ and the vitest config
    public/  scripts/  eslint-rules/  patches/  Dockerfile  server.js  proxy.ts  instrumentation.ts
  site/                   the landing site (was frontends/web)
  backend/                the Python host for the ADR-0082 roles (was frontends/aiq_api, and
                          deploy/Dockerfile with its entrypoint.py and start_web.py)
packages/                 libraries: a directory that holds a distribution is named after it
  agent/                  the agent (was src/aiq_agent + tests/aiq_agent)
  knowledge-layer/        ingestion and retrieval (was sources/knowledge_layer + tests/knowledge_layer_tests)
  ris-adapter/            (was sources/ris_adapter)
  tavily-web-search/      (was sources/tavily_web_search)
  brand/                  the mark and the script that renders it into both apps (was shared/brand
                          and frontends/web/scripts/build-brand-assets.mjs)
  ifc-spatial/  ifc-spatial-py/   (unchanged)
contracts/                schemas two languages share
  cards/  wire/           (was shared/cards, shared/wire)
evals/                    Piloti's own evaluation harnesses, each with its tests inside
  oib-retrieval/          (was frontends/benchmarks/oib_retrieval + its tests in tests/benchmarks)
  turn-shapes/            the live turn-shape eval (was tests/benchmarks/test_turn_shapes_live.py)
scripts/                  repo tooling and one-off operations (unchanged)
tests/                    repo-level tests only: guards, CI, deploy, cross-service contract fixtures
deploy/  docs/  configs/  ci/  taskfiles/  skills/  releasenotes/  data/   (unchanged)
```

`plans/` and `docs/superpowers/` were folded into `docs/plans/` and
`docs/specs/` by #1250, and both were deleted by #1252 (the one living
spec became `docs/architecture/agent-authored-documents.md`). Gone without a successor: `frontends/`, `sources/`, `shared/`,
`src/`.

`bff/`, not `server/`: next to `server.js`, a `server/` folder makes a reader
guess which is which, and Node's `require('./server')` resolves to the file
first. "BFF" is the word ADR-0003 and the code already use.

### Naming rules

1. **A directory name says its job**, as a noun a newcomer would use: `site`,
   not `web`; `backend`, not `aiq_api`; `evals`, not `benchmarks`.
2. **`apps/` runs, `packages/` is imported.** An app is a deployable unit: an
   image, or a process type of one. A package has no entrypoint of its own.
3. **A directory that holds one distribution is named after it**, in
   `kebab-case`. A new import name is the distribution in `snake_case`. An
   existing library keeps its import (`ifc-spatial-py` imports `ifc_spatial`).
4. **One word per concept.** The directory's word is also its task namespace,
   its CI filter tier, its image and its Kubernetes workload. The words that
   change: `frontend`/`fe:` becomes `workspace`, and `web` becomes `site`.
   `backend`/`be:` already matches.
5. **No brand in a code or infrastructure name**: not `aiq`, not `grid`, not
   `piloti`. That covers paths, packages and distributions, imports,
   identifiers, environment variables, wire, telemetry and operation names,
   images, deploy names and stored keys. Piloti is due a rebrand, and a name
   that carries the brand moves the day the brand does. So the agent is
   `packages/agent` importing `agent`, and the backend app imports
   `backend`. Neither import is taken in the environment (checked on
   2026-10-27), but both distribution names are taken on PyPI (`agent`,
   `backend`). A workspace member always resolves to the member, so that is
   only a risk where something installs by name from an index; nothing may
   (`pip install agent`, an exported requirements file, an image stage
   that runs `uv pip install` without the workspace). Brands stay where people
   read them: copy, i18n, docs prose, and the assets in `packages/brand`.
   `grid` the CSS layout is a word, not the company. Vendors appear where the
   adapter is one vendor's (`tavily-web-search`). `aiq` goes first, because
   it carries the most names (the inventory below). History is exempt: ADRs,
   `releasenotes/`, `docs/audit/` and migrations say what was true then, and
   are not renamed.

### The brand inventory

Every category found on 39f8628, what replaces it, and the row that does it:

| Category | Today | Target | Row |
|---|---|---|---|
| Python imports and distributions | `aiq_agent`/`aiq-agent`, `aiq_api`/`aiq-api` | `agent`/`agent`, `backend`/`backend` | 10a |
| Python symbols | `AIQAPIConfig`, `AIQAPIWorker`, `register_aiq_api`, … | `Backend…`, `register_backend` | 10a |
| Entry points | group `aiq_api.validators`; NAT plugins `aiq_*` | `backend.validators`; the plugin's job (`research`, `chat`, …). No `NAT_PLUGIN_*` list exists in `deploy/` or `configs/`; re-check before renaming | 10a |
| Environment variables | 87 `AIQ_*`, renamed to `GRID_*` by #1270 (192 variables in all) | no prefix at all (`GRID_MAX_ACTIVE_JOBS_PER_ORG` → `MAX_ACTIVE_JOBS_PER_ORG`), and a descriptive name only where a bare one would collide with a platform or library variable (`SERVICE_ROLE`, not `ROLE`). Decided by the owner on 2026-10-27. Read both for one release, warn on the old one, then drop it | 10b |
| Wire names | headers `X-AIQ-Mode`, `x-aiq-access-channel` | brand-free names with no `X-Grid-` prefix (`x-organization-id`, `x-user-id`, `x-internal-token`), decided by the owner on 2026-10-27. The BFF and the backend deploy separately, so the receiver accepts both for one release | 10b |
| Telemetry names | span attributes `aiq.auth.*`, `aiq.user.*`, `aiq.access.channel`; OTel services `grid-aiq-agent`, `grid-aiq-api`; `LANGCHAIN_PROJECT=aiq-research` | `app.*` (`app.auth.*`, `app.user.*`, `app.access.channel`), decided on 2026-10-27: OpenTelemetry wants custom attributes namespaced and `app` carries no brand. Keep clear of the names the semantic conventions register under `app.` for client apps (`app.installation.id`, `app.screen.*`). Services `backend-chat`, `backend-api`. Langfuse and PostHog views that filter on the old names are re-pointed in the same PR | 10b |
| Kubernetes | `aiq-agent`, `aiq-agent-headless`, `aiq-api`, Secret `aiq-agent-occupancy-auth`, `agent-worker`; and by rule 4, `frontend`, `web` | `chat`, `chat-headless`, `api`, `chat-occupancy-auth`, `research-worker`; `workspace`, `site` | 10c |
| Compose | services and containers `aiq-*`, `aiq-blueprint-*`, network `aiq-network`, the NVIDIA image tags in the comments | role names as in Kubernetes; the Compose default network | 10c |
| Images | CI images `grid-oib-backend`, `grid-oib-frontend`, `grid-oib-web` | `backend`, `workspace`, `site` (rules 4 and 5; the registry path already names the owner) | 10c |
| Persisted names | Postgres databases `aiq_jobs`, `aiq_checkpoints`, role `aiq`; vector metadata keys `aiq:embed_fingerprint`, `aiq:embed_model`, `aiq:bm25_length`; browser key `aiq-chat-store`; Compose volume `aiq-data` | `jobs`, `checkpoints`, role `agent`; `embed_fingerprint`, `embed_model`, `bm25_length`; `chat-store`; `data`. Renamed last, each with a migration that reads the old name. The Postgres rename is a one-way door for the operator and gets its own plan when scheduled | 10d |
| Other distributions | `@grid/ifc-spatial`, `grid-oib-pulumi`, `grid-oib-policy`, `aiq-blueprint-ui`, `piloti-web` | `ifc-spatial`, `infra`, `infra-policy`, `workspace`, `site` | the row that moves each, else 10a |
| Agent-door names | MCP operations `piloti-ask-create`, `-get`, `-cancel`, `piloti-change-undo`; resources `piloti://guide`, `catalog`, `glossary`, `operation`, `project`; the `piloti-mcp-mode` header | the operation's job (`ask-create`, …) and a neutral URI scheme, the old names served beside the new for one release, because outside agents have them configured | 10b |
| Deploy names | `grid-app-*` Kubernetes objects and Jobs (`grid-app-authz-catalog`, `grid-app-migrate`, `grid-app-folder-grants`, …) | role names, as in the Kubernetes row | 10c |
| Other paths | 124 path names, most of them the site's art and downloads, the UI's card modules (`grid-cards`), docs and fixtures (`grid_request_context.json`), counted with every other brand name by `scripts/check_brand_names.py` (#1302) | renamed with the code around them; the count only falls | each row |
| Docs and tests | prose and test names | follow the row that renames the thing they describe | each row |

### Inside `apps/workspace`

The BFF gets its own folder by a file move: `src/lib/` becomes `bff/`, and
`tsconfig.json` and `vitest.config.ts` map `@/lib/*` to `./bff/*`. No import
specifier and no `vi.mock` specifier changes. The catch-all `@/*` → `./src/*`
is replaced by one alias per folder, since there is no single root left:
`@/app`, `@/lib`, `@/features`, `@/components`, `@/hooks`, `@/styles`,
`@/adapters`, `@/i18n`, `@/shared`, `@/types`, `@/utils`, `@/test-utils` and
`@/mocks`. `proxy.ts` and `instrumentation.ts` move to the app root, where Next
looks for them when there is no `src/`.

Relative paths that cross the new boundaries do change: `server.js` requires
`./src/lib/…` 8 times, and `next.config.ts`, `drizzle.config.ts`, the
Dockerfile's per-file `COPY /app/src/lib/*` lines, `.oxlintrc.json`'s `src/`
globs and the `eslint-rules/*` allowlists name paths. So row 9 is two commits:
the `git mv`, then the path fixes. The workers, scheduler, purger and
observability stay at the app root because they are entrypoints (rule 2). The
container commands in Pulumi and Compose (`node purger/index.js`, …) therefore
do not change, and row 9 needs no operator apply.

The move takes `lib/` whole. `bff/` starts with the client modules that live in
`lib/` today (6 by a hook or `'use client'` grep: `documents/document-changes.ts`,
`user-preferences/client.ts`, `use-show-reasoning-skills.ts`,
`workos/use-widget-appearance.ts`, `organizations/client.ts`,
`bim/compliance-cache.ts`). The `@react-pdf` renderers in `lib/pdf/` run on the
server and stay. It also starts with 21 `lib/` modules that import from
`@/features`. Both move afterwards, one PR per area, under the ratchets below,
because sorting them inside the rename would turn the rename into a refactor.

### Evals and scripts

`evals/` holds the harnesses that measure Piloti, with their tests inside
each one. Rule 3 renames the distribution `oib-retrieval-eval` to
`oib-retrieval`, with the import to match, in row 2's second commit. It is an
editable path source of the root dev group, not a workspace member: a path
source locks no extra (its `dense` extra would pull torch into `uv.lock`), and
the backend image's `uv sync --all-packages` does not need `evals/` in its
context. The second harness, `oib_compliance`, was deleted in row 2 rather than
moved: its latency and cost bounds had waited for calibration since July
(`bounds_calibration_pending: true`), and nothing but its own checklist unit
test ever ran it. The eval runners now in
`scripts/` (`decision_eval*.py`, `loop_eval.py`, `intake_eval/`,
`root_sort_eval.py`, `turn_census/`) follow into `evals/` in a PR of their own.

### Python workspace

`packages/*` is not one uv glob. `ifc-spatial` is TypeScript, and
`ifc-spatial-py` keeps its own `uv.lock` on purpose so that IfcOpenShell stays
out of the main lock (`packages/AGENTS.md`). So the root `pyproject.toml` lists
its members explicitly, pytest `testpaths` is an explicit list, the `packages`
CI tier stays `packages/ifc-spatial*/**`, the moved Python packages join
the `backend` tier, and `packages/brand` joins the `site` and `workspace` tiers
(its script writes into both apps). Once the agent moves (row 8), the root `pyproject.toml`
becomes a virtual workspace root, and the agent's dependencies and NAT entry
points move to `packages/agent/pyproject.toml`.

The agent imports the backend app in 3 places (`auth/utils.py`,
`auth/workos_validator.py`, `turn/api_seam.py`), and its tests in 8. A package
importing an app breaks rule 2. This is recorded as debt with a guard (below),
not fixed inside a move.

### Move order

Cheapest and least contended first. Each row is its own PR, merged when the
open PRs touching that tree have drained or been rebased by their authors.

| # | Move | Lines | Waits on |
|---|---|---|---|
| 0 | Gates: the filter-coverage test (every tracked path matched by a `.github/filters.yml` filter; in flight, and written here if that PR has not merged), and `tests/test_repo_layout.py` (below) | — | — |
| 1 | `plans/` and `docs/superpowers/` deleted (#1250, #1252) | — | — |
| 2 | `frontends/benchmarks/oib_retrieval` + `tests/benchmarks` → `evals/`; distribution name per rule 3; `oib_compliance` deleted | 140 | — |
| 3 | `frontends/web` → `apps/site`; `shared/brand` and the brand script → `packages/brand`; task namespace `web:` → `site:` | ~140 | open site PRs |
| 4 | `shared/cards`, `shared/wire` → `contracts/` | 211 | open card and wire PRs |
| 5 | Import hygiene: `sources.<pkg>.src.X` → the installed name (338 lines), and the 69 dotted `tests.aiq_agent.…` imports → an importable helpers module: one `<distribution>_testing` support package per suite family, on pytest's `pythonpath`, held by `tests/test_test_imports.py`. This ends the double identity and makes rows 6 and 7 pure renames | ~410 | open retrieval and agent-test PRs |
| 6 | `sources/*` + `tests/knowledge_layer_tests` → `packages/<distribution>` | ~470 | row 5 |
| 7 | `frontends/aiq_api`, `deploy/Dockerfile` with `entrypoint.py` and `start_web.py` → `apps/backend`. Paths only | ~220 | open backend-route PRs |
| 8 | `src/aiq_agent` + `tests/aiq_agent` → `packages/agent`: the `git mv`, then the pyproject split as its own commit. The distribution stays `aiq-agent` until 10a; the layout test allowlists that. Re-keys the brand baseline | ~1,020 | row 5; open agent PRs |
| 9 | `frontends/ui` → `apps/workspace`, with `app/ ui/ bff/` inside, in two commits; task namespace `fe:` → `workspace:` and CI tier `frontend` → `workspace` | 1,464 | the in-flight UI queue |
| 10a | Python rename: imports, distributions, symbols, entry points | ~10,800 | an empty Python PR queue |
| 10b | Environment variables, wire names, telemetry names, each read-both for one release | ~150 names | 10a |
| 10c | Kubernetes, Compose and image names, in three deploys (below) | ~550 | 10a; an operator to apply |
| 10d | Persisted names, each with its migration | 8 names | 10c; an operator for Postgres |

Paths move before names change (8 before 10a), because a PR that renames a
directory **and** edits the content of 1,336 files defeats git's rename
detection, and every open branch then conflicts on every file. Split this way,
each PR is either a pure rename or a pure content edit.

The Kubernetes rename recreates resources. The chat tier is a StatefulSet
whose per-pod DNS (`aiq-agent-<i>.aiq-agent-headless`) the BFF hashes
conversations onto, with drains of up to ~45 minutes (ADR-0080). It rolls out
expand, switch, contract:

1. **Expand.** New Pulumi resources with new logical names (`chat`,
   `chat-headless`, `api`, their HPA and KEDA objects, network policies,
   Secret) are created beside the old ones. Not Pulumi `aliases`: an alias
   makes Pulumi treat the new name as the old resource and replace it in place,
   which is the outage this avoids. `npm run preview` shows creates only.
2. **Switch.** The workspace's chat and API URLs and the housekeeping CronJobs'
   target point at the new Services. New conversations land on `chat`; turns
   running on `aiq-agent` finish there. `npm run preview` shows updates to the
   workspace and the CronJobs only.
3. **Contract.** Once `aiq-agent` reports no active turns for a full drain
   window, the old resources are deleted. `npm run preview` shows deletes only.

`frontend` → `workspace` and `web` → `site` follow the same three steps, with
the Gateway routes switching in step 2. Each deploy is applied by an operator.
An agent runs `npm run preview`, never `npm run up`.

### Per-move checklist

The generic gate comes first. After a move, `git grep -F <old path>` returns
nothing outside history (accepted ADRs, `releasenotes/`), and
`tests/test_repo_layout.py` asserts it. The list below says where the hits
usually are; the gate is what proves none was missed. Every move PR goes
through the list and says in its description which lines did not apply:

- `git mv` only, in its own commit, before any edit, so the rename is a
  rename. The PR shows `git diff -M --stat` reporting renames, not deletes and
  adds.
- CI:
  - `.github/filters.yml`, including the single-file and cross-tier entries
    (`src/aiq_agent/cards/models.py` and `shared/cards/schemas.json` in the
    frontend tier, `migrations:`, the site tier's paths into the UI tree).
  - `ci/pr_selection.py`, the affected-test selection; a stale path there
    skips tests silently.
  - `ci/image_inputs.py`, `ci/require_release_note.py`, and the workflows
    and `.github/actions/build-image`.
  - `.github/labeler.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`.
  - `tests/test_ci_workflows.py`.
- Deploy:
  - The Dockerfiles, `.dockerignore`, and `tests/test_dockerfile_paths.py`.
    The workspace image's build context is its app directory alone, so a move
    that makes it read outside that directory changes the image build, not
    just a path.
  - Compose `build.context` and `command:` lines, in both Compose files.
  - Pulumi container commands.
  - The Coolify configuration, which lives outside the repo; the PR says
    whether it changes.
- Taskfile variables, `taskfiles/*.yml`, and the scripts that hardcode paths
  (`scripts/setup.sh`, `scripts/dev.sh`, `scripts/start_e2e.sh`,
  `scripts/check_env_docs.py`).
- Python: in `pyproject.toml`, the workspace members, `[tool.uv.sources]`,
  pytest `testpaths` and `pythonpath`, and ruff `per-file-ignores`. Then
  `uv lock`, and `task setup` to drop stale `*.egg-info` (the
  ModuleNotFoundError entry in `docs/contributing/gotchas.md`). Python tests
  that read UI files by path (`test_reasoning_settings.py`,
  `test_retrieval_settings.py`) also move.
- TypeScript:
  - `tsconfig.json` paths and `include`, `vitest.config.ts` aliases and roots.
  - `.oxlintrc.json` globs and the `eslint-rules/*` allowlists.
  - `drizzle.config.ts` and the `next.config.ts` imports.
  - `bun install`, so `tests/test_js_lockfiles.py` stays green.
- Repo config: `.pre-commit-config.yaml`, `.gitignore`, `.gitleaks.toml`,
  `.semgrepignore`, `.devcontainer/devcontainer.json`, `apm.yml`.
- Path-keyed ratchet baselines: `ci/english_names_baseline_py.json`,
  `ci/german_stems.json`, `frontends/ui/english-names-baseline.json`, and
  `ci/size_baseline.json` (`python scripts/check_file_size.py --rebaseline`).
  Rewrite the keys and review the baseline diff: only keys change, never a
  count.
- `tests/.test_durations`: rewrite the keys or regenerate with
  `task be:test:durations`, or the shards unbalance.
- Every `AGENTS.md` and `CLAUDE.md` pair moves with its directory;
  `scripts/check_agent_docs.py` fails a guide that links to a moved path.
- Docs: `docs/architecture/where-is-what.md` (`scripts/check_doc_paths.py`
  fails a dead path), `system-overview.md`, `backend-deep-dive.md`,
  `CONTRIBUTING.md`, the table in `definition-of-done.md`, the root
  `AGENTS.md` introduction, and whatever else the generic gate finds.
- The layout test's allowlist: the old name leaves it in the same PR.

### Consequences

* Good, because `ls` says what is where: things that run, things they import,
  the schemas between them, and the evals that measure them.
* Good, because the BFF becomes a folder a reader can find, at the cost of
  two config files and the relative paths that cross into it.
* Good, because row 5 removes a real defect: one module reachable under two
  names, which Python loads as two modules with two copies of their state.
* Good, because every package directory is its distribution's name, so uv,
  Dependabot and a reader all see the same list.
* Good, because each move is a separate, mechanical PR that an agent can do
  with this checklist and the gate.
* Bad, because more than a dozen PRs of churn land on a repo that merges about
  17 a day, and each forces open branches to merge `develop` across a rename.
* Bad, because `git log` and `git blame` need `--follow` across each move, and
  links into old paths from outside the repo (issues, chat) break.
* Bad, because rule 4 renames task namespaces people type every day (`fe:`,
  `web:`), and 10c needs operator deploys for no functional change.
* Bad, because 10a touches about 1,700 files in one PR, and 10d migrates stored
  data to change a name.
* Bad, because until row 9 lands, the tree is half old and half new. The
  layout test's allowlist says which half each directory is in.
* Neutral: `scripts/` and `tests/` keep their names and lose some contents.
  `apps/workspace` shares a word with "uv/bun workspace"; the product's word
  wins, and `apps/` disambiguates.

### Confirmation

Nothing enforces the target yet. Row 0 adds the gates, and each move tightens
them:

- `tests/test_repo_layout.py`:
  - Every top-level tracked directory, dot-directories included (`.github`,
    `.claude`, `.devcontainer`), is in an allowlist of the target names plus
    the legacy names still waiting to move. A move removes its legacy name. A
    new top-level directory fails until someone adds it, which is the moment
    to ask whether its name says its job.
  - For each completed move, `git grep -F <old path>` finds nothing outside
    history.
  - The number of tracked lines containing `aiq` (case-insensitive, history
    and `tests/.test_durations` excluded) may only fall from its baseline of
    about 13,000. After 10d it is zero, except names allowlisted with a reason.
- `scripts/check_brand_names.py` (#1302), a pre-commit hook in **Repo checks**
  on every pull request: no new name carries `aiq`, `grid` or `piloti`.
  `ci/brand_names_baseline.json` counts the existing ones per file, and each
  directory as its own key, so a new file in an old directory passes and a new
  branded directory fails. Identifiers, file names, environment variables,
  routes, headers and resource names all count; prose, the CSS `grid` and
  history do not. A count only falls, and each move re-keys the baseline
  (`--rebaseline`) in its own PR.
- The filter-coverage test catches a moved path that no CI filter matches.
- After row 9, two count ratchets on `apps/workspace/bff/`: client modules
  (hooks or `'use client'`, 6 today) and imports from `@/features`
  (21 modules today). Both fall to zero.
- An import guard (import-linter contract or a test) counts imports of the
  backend app from `packages/agent` (3 today) and lets the count only
  fall.
- Each move is verified by `task lint:repo` and `task verify`, plus:
  - `task be:test:sources` for row 6;
  - `task web:build` for row 3, which renders the brand assets;
  - `task db:test:rls` for row 9 (the tenant boundary moves);
  - one local build of any image whose Dockerfile or context moved.

## Pros and Cons of the Options

### 1. Do nothing

* Good, because no churn.
* Bad, because the translation is paid by every session that opens the repo.
  The root `AGENTS.md` introduction alone needs three paths to say what the code
  is, and none of the three is named after its job.

### 2. The first sketch: `tools/`, `packages/adapters/*`, `server/`

* Good, because one top-level `tools/` collects everything that is neither app
  nor library.
* Bad, because moving `scripts/` touches 795 lines in exchange for a parent
  folder named "tools", which says less than "scripts" did. Premise: 795
  references, measured on 39f8628 without `tests/.test_durations`.
* Bad, because `packages/adapters/ris` breaks rule 3 (the directory is not the
  distribution `ris-adapter`) and adds a nesting level for a folder that holds
  two packages.
* Bad, because `server/` sits beside `server.js`, and `require('./server')`
  resolves to the file. Premise: the workspace keeps a custom server named
  `server.js`.

### 4. One big-bang PR

* Good, because the half-moved state never exists.
* Bad, because it conflicts with every open PR at once and cannot land while
  any of them is in flight. Premise: 121 PRs merged in the week to 2026-10-26
  and 33 were open on 2026-10-27, so the queue is never empty for the whole
  repo, only for one tree at a time.

## More Information

* ADR-0003 (Next.js hosts the BFF), ADR-0050 (scoped guides beside the code),
  ADR-0080 (chat drain), ADR-0082 (backend roles; this record says where step
  D lands), ADR-0103 (Bun toolchain), ADR-0122 (the agent door).
* The names (rows 10a to 10d) sit in this record because ADR-0082's step D points
  here, and naming a directory without naming what it holds would leave the
  layout half decided. A one-way door among them (the Postgres rename) gets its
  own plan when it is scheduled.
* Splitting the BFF out of Next.js would supersede ADR-0003 and this record.
  Nothing here pre-cuts for it.
* Rule 5 was amended on 2026-10-27, before rows 6 to 9, at the owner's word:
  "no brand names in code or infrastructure identifiers. Not AIQ, not Grid,
  not Piloti; Piloti will be rebranded soon too." It replaced `piloti-agent`,
  `piloti_agent`, `piloti_backend` and the `GRID_`, `X-Grid-` and `grid.*`
  targets. The owner chose the environment, header and telemetry names the
  same day (the inventory), and the brand-names series carries them out.
* The first draft of this record was reviewed by a separate agent before
  merge. Its findings (import-through-directory, the `packages/*` glob, the
  unlisted `aiq` categories, `server/` next to `server.js`, the missing
  checklist items) are folded in above.
