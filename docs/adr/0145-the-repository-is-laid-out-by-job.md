---
status: proposed
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The repository is laid out by job: apps, packages, contracts, evals, and no AI-Q names

## Context and Problem Statement

A new colleague or agent should understand this repository from `ls`. Today the
top-level names describe the NVIDIA AI-Q blueprint the repo was forked from,
not what is in it:

- **`frontends/` holds Python.** Next to the UI (`frontends/ui`) and the landing
  site (`frontends/web`) sit the backend host (`frontends/aiq_api`), a debug
  console (`frontends/debug`), the blueprint's command-line client
  (`frontends/cli`) and the eval harnesses (`frontends/benchmarks`). In AI-Q a
  "frontend" was anything that drove the agent. Here, three of the six are not
  frontends at all.
- **`sources/` mixes a library and adapters.** `knowledge_layer` is the
  ingestion and retrieval library the agent is built on; `ris_adapter` and
  `tavily_web_search` are thin NAT plugins in front of outside services. The
  word "sources" describes none of them.
- **The agent sits at `src/aiq_agent`**, the one package with no folder of its
  own, its tests in `tests/aiq_agent`, and its distribution is the root
  `pyproject.toml`, described as "NVIDIA AI-Q Blueprint".
- **The BFF is hidden inside the UI.** Domain modules, the Drizzle schema, the
  claim queues and the services behind every `/api` route live in
  `frontends/ui/src/lib`, beside `features/` and `components/`. Of the 937
  modules in `lib/`, 403 import `server-only` and 13 are React; the folder's
  name says neither. The workers, scheduler and purger are siblings of `src/`.
- **`shared/` is three things**: cross-language schemas (`cards/`, `wire/`) and
  one brand SVG.
- **"aiq" is everywhere and means nothing.** `aiq_agent` appears on 9,497 lines
  in 1,336 files, `aiq_api` on 1,345 lines in 361 files, the Kubernetes names
  `aiq-agent` and `aiq-api` on 331 and 178 lines, and 87 environment variables
  start `AIQ_`. ADR-0082 already decided to drop it (step D) without saying
  where things land.

Moves are cheap per file and expensive per reference, and every open PR that
touches a moved file conflicts. Measured on `develop` at 39f8628 with
`git grep -F <path> | wc -l`, excluding `tests/.test_durations`:

| Path today | Lines naming it | Files |
|---|---|---|
| `frontends/ui` | 1,464 | 460 |
| `src/aiq_agent` | 720 | 292 |
| `sources/` | 444 | 153 |
| `tests/aiq_agent` | 299 | 184 |
| `frontends/aiq_api` | 220 | 115 |
| `shared/cards` + `shared/wire` + `shared/brand` | 223 | 122 |
| `frontends/web` | 122 | 77 |
| `frontends/benchmarks` + `tests/benchmarks` | 140 | 69 |
| `tests/knowledge_layer_tests` | 78 | 43 |
| `plans/` | 21 | 16 |
| `frontends/cli`, `frontends/debug` | 11, 9 | 7, 7 |

`tests/.test_durations` is excluded because it is generated
(`task be:test:durations`), not edited: it alone carries 1,418 references to
`src/aiq_agent` and 343 to `sources/`, which is why earlier tallies of "2,138"
and "787" were higher. Inside the UI, 7,819 imports read `@/lib/…` and 2,074
`vi.mock('@/lib/…')` calls name a module by that specifier; changing the alias
would touch every one of them for no gain.

## Decision Drivers

* A directory name says its job. `ls` at the root, and one level down, is
  enough to find where a thing lives.
* Nothing is named after the AI-Q blueprint at the end.
* Next.js stays the host of the UI and the BFF: one app, one image
  (ADR-0003). Splitting the BFF out is a different decision with its own
  triggers.
* Each move is one PR that is a pure rename where it can be, so git's rename
  detection carries open branches across it.
* A skipped CI job counts as passed, so a move that forgets a path filter
  silently stops testing the moved code.
* Industry vocabulary: `apps/` and `packages/` is the layout Turborepo, Nx,
  pnpm and uv workspaces all document, so a newcomer has seen it before.

## Considered Options

1. Do nothing; keep explaining the names in `where-is-what.md`.
2. The `apps/ packages/ contracts/ tools/` tree as first sketched, with
   `tools/evals` and `tools/scripts`, and `packages/adapters/{ris,web-search}`.
3. The same tree with three changes: `evals/` at the top and `scripts/` left
   where it is, adapters flat under `packages/` named after their
   distribution, and the inherited AI-Q leftovers removed rather than moved.
4. One big-bang PR that does every move and the rename at once.

## Decision Outcome

Chosen option 3, because it gets the clean `ls` for about a thousand fewer
edited lines than option 2, and keeps one rule for every package directory.

### The target tree

```
apps/                     things that run: each is an image or a process
  workspace/              the Next.js app, UI and BFF in one image (was frontends/ui)
    app/                  Next routes: pages, layouts, thin /api route handlers
    ui/                   features, components, hooks, i18n, styles, adapters, shared
    server/               the BFF: domain modules, db schema, authz, queues (was src/lib); @/lib/* points here
      migrations/         Drizzle migrations (was drizzle/)
      workers/  scheduler/  purger/   the other process types of the same image
    public/  config/  scripts/  tests/  observability/  server.js  proxy.ts  instrumentation.ts
  site/                   the landing site (was frontends/web)
    brand/                piloti-mark.svg, the master both apps render from (was shared/brand)
  backend/                the Python host for the ADR-0082 roles (was frontends/aiq_api)
    src/piloti_backend/   routes, roles, the debug console as .debug (was frontends/debug)
packages/                 libraries: directory name = distribution name
  piloti-agent/           the agent (was src/aiq_agent + tests/aiq_agent)
  knowledge-layer/        ingestion and retrieval (was sources/knowledge_layer + tests/knowledge_layer_tests)
  ris-adapter/            (was sources/ris_adapter)
  tavily-web-search/      (was sources/tavily_web_search)
  ifc-spatial/  ifc-spatial-py/   (unchanged)
contracts/                schemas two languages share
  cards/  wire/           (was shared/cards, shared/wire)
evals/                    Piloti's own evaluation harnesses
  oib_retrieval/  oib_compliance/  tests/   (was frontends/benchmarks + tests/benchmarks)
scripts/                  repo tooling and one-off operations (unchanged)
tests/                    repo-level tests only: guards, CI, deploy, cross-service contract fixtures
deploy/  docs/  configs/  ci/  taskfiles/  skills/  releasenotes/  data/   (unchanged)
```

`plans/` (the June 2026 MVP plans) moves to `docs/plans/`. Gone without a
successor: `frontends/`, `sources/`, `shared/`, `src/`.

### Naming rules

1. **A directory name says its job**, as a noun a newcomer would use: `site`,
   not `web`; `backend`, not `aiq_api`; `evals`, not `benchmarks`.
2. **`apps/` runs, `packages/` is imported.** An app is a deployable unit (an
   image or a process type of one). A package has no `main` of its own.
3. **In `packages/`, the directory is the distribution name** (`kebab-case`),
   and the import is that name in `snake_case`. `ls packages` then is the
   dependency list, and the uv workspace is one glob, `packages/*`.
4. **A product name appears only where the thing is the product.** The agent
   is Piloti, so `piloti-agent`; the Python packages hosted by `apps/` take
   the `piloti_` prefix only because a bare `backend` import would shadow
   anything else of that name. Vendors appear where the adapter is one
   vendor's (`tavily-web-search`).
5. **No `aiq`**, in paths, imports, distributions, entry points, Kubernetes
   names or environment variables.

### Names that replace `aiq`

| Today | Target | Notes |
|---|---|---|
| `aiq_agent` (import), `aiq-agent` (distribution) | `piloti_agent`, `piloti-agent` | The root `pyproject.toml` becomes a virtual workspace root; the agent gets `packages/piloti-agent/pyproject.toml` with its NAT entry points |
| `aiq_api`, `aiq-api` | `piloti_backend`, `piloti-backend` | |
| `aiq_debug`, `aiq-debug` | `piloti_backend.debug` | `aiq_api/plugin.py` is its only caller; a package of one caller is a module |
| `aiq_research_cli` (`frontends/cli`) | removed | The blueprint's terminal client. No task, CI job or doc of record uses it, and it exits 0 on every failure (`docs/audit/ux-system-audit.md`, UX-7). People reach Piloti through the workspace and the MCP door (ADR-0122) |
| entry-point group `aiq_api.validators` | `piloti_backend.validators` | |
| NAT plugin names `aiq_*` (`aiq_researcher`, `aiq_bim`, …) | `piloti_*` | The `pyproject.toml` comment kept them for `NAT_PLUGIN_*` allow and deny lists; none exists in `deploy/` or `configs/` today. Re-check before renaming |
| `AIQ_*` environment variables (87) | `GRID_*` | `GRID_` is the house prefix (192 variables). Read both for one release, warn on the old one, then drop it |
| Kubernetes `aiq-agent`, `aiq-agent-headless` | `chat`, `chat-headless` | The ADR-0082 role names, as `frontend`, `web`, `purger`, `ingest-worker` already are |
| Kubernetes `aiq-api` | `api` | |
| Kubernetes `agent-worker` | `research-worker` | Already decided in ADR-0082 |

Image names (`grid-oib-backend`, `grid-oib-frontend`, `grid-oib-web`) carry no
AI-Q name and stay.

### Inside `apps/workspace`

The BFF gets its own folder by a pure file move: `src/lib/` becomes `server/`,
and `tsconfig.json` and `vitest.config.ts` map `@/lib/*` to `./server/*`. No
import and no `vi.mock` specifier changes. The other aliases are mapped one
by one (`@/features/*` → `./ui/features/*`, and so on); the catch-all
`@/*` → `./src/*` is replaced by them, since there is no one root left to point
at. `proxy.ts` and `instrumentation.ts` move to the app root, where Next looks
for them when there is no `src/`.

The move takes `lib/` whole, so `server/` starts with the 13 React modules and
the isomorphic helpers the UI imports. Those move to `ui/` afterwards, one PR
per area, under a count ratchet (below), because sorting them inside the
rename would make the rename a refactor.

### Evals and scripts

`evals/` holds the two harnesses that measure Piloti (`oib_retrieval`,
`oib_compliance`) and their tests. The three inherited AI-Q benchmarks
(`deepresearch_bench`, `deepsearch_qa`, `freshqa`) are removed in the same PR:
no task, CI job or test runs them, and two are uv workspace members only. If
someone owns one of them by then, it moves to `evals/` instead. The eval
runners now in `scripts/` (`decision_eval*.py`, `loop_eval.py`,
`intake_eval/`, `root_sort_eval.py`, `turn_census/`) follow into `evals/` in
a PR of their own.

### Move order

Cheapest and least contended first. Each row is its own PR, merged when the
open PRs touching that tree have drained or been rebased by their authors. Row
0 is a precondition for all others.

| # | Move | Lines | Waits on |
|---|---|---|---|
| 0 | The filter-coverage test (every tracked path matched by a `.github/filters.yml` filter, in flight) and `tests/test_repo_layout.py` (below) | — | — |
| 1 | `plans/` → `docs/plans/`; remove `frontends/cli` | 32 | — |
| 2 | `frontends/benchmarks` + `tests/benchmarks` → `evals/`; remove the three AI-Q benchmarks | 140 | — |
| 3 | `frontends/web` → `apps/site`; `shared/brand` → `apps/site/brand` | 134 | open site PRs |
| 4 | `shared/cards`, `shared/wire` → `contracts/` | 211 | open card and wire PRs |
| 5 | `sources/*` + `tests/knowledge_layer_tests` → `packages/<distribution>` | 522 | open retrieval PRs |
| 6 | `frontends/aiq_api` → `apps/backend`; `frontends/debug` into it (paths only, imports unchanged) | 229 | open backend-route PRs |
| 7 | `src/aiq_agent` + `tests/aiq_agent` → `packages/piloti-agent` (paths only) | 1,019 | open agent PRs |
| 8 | `frontends/ui` → `apps/workspace`, with `app/ ui/ server/` inside | 1,464 | the in-flight UI queue |
| 9a | Python rename: `aiq_agent` → `piloti_agent`, `aiq_api` → `piloti_backend`, entry points, distributions | ~10,800 | an empty Python PR queue |
| 9b | `AIQ_*` → `GRID_*`, read-both for one release | 87 names | 9a |
| 9c | Kubernetes rename, in three deploys (below) | 509 | 9a; an operator to apply |

Paths move before names change (7 before 9a), because a PR that renames a
directory **and** edits the content of 1,336 files defeats git's rename
detection, and every open branch then conflicts on every file. Split, each PR
is either a pure rename or a pure content edit, and both are mechanical.

The Kubernetes rename recreates resources, and the chat tier is a StatefulSet
whose per-pod DNS (`aiq-agent-<i>.aiq-agent-headless`) the BFF hashes
conversations onto, with drains of up to ~45 minutes (ADR-0080). It rolls out
expand, switch, contract:

1. **Expand.** New Pulumi resources with new logical names (`chat`,
   `chat-headless`, `api`, their HPA and KEDA objects, network policies)
   created beside the old ones. Not Pulumi `aliases`: an alias makes Pulumi
   treat the new name as the old resource and replace it in place, which is
   the outage this avoids. `npm run preview` shows creates only.
2. **Switch.** The frontend's chat and API URLs and the housekeeping CronJobs'
   target point at the new Services. New conversations land on `chat`; turns
   running on `aiq-agent` finish there. `npm run preview` shows updates to the
   frontend and CronJobs only.
3. **Contract.** Once `aiq-agent` reports no active turns for a full drain
   window, the old resources are deleted. `npm run preview` shows deletes only.

Each deploy is applied by an operator; an agent runs `npm run preview` and
never `npm run up`.

### Per-move checklist

Every move PR goes through this list and says in its description which lines
did not apply:

- `git mv` only, in its own commit, before any edit, so the rename is a
  rename.
- `.github/filters.yml`: the new path in the same tier; the filter-coverage
  test proves no tracked path is left unmatched.
- `.github/labeler.yml`, `.github/dependabot.yml` directories, `CODEOWNERS`.
- Dockerfiles (`deploy/Dockerfile`, the app's own `deploy/Dockerfile`,
  `Dockerfile.typecheck`) and `.dockerignore`; `tests/test_dockerfile_paths.py`.
  The workspace image's build context is the app directory alone, so a move
  that makes it read outside that directory changes the image build, not
  just a path.
- `ci/image_inputs.py` (image hashes), `ci/require_release_note.py` (path
  patterns), `tests/test_ci_workflows.py`.
- `Taskfile.yml` variables and `taskfiles/*.yml`.
- `pyproject.toml`: `[tool.uv.workspace] members`, `[tool.uv.sources]`,
  pytest `testpaths` and `pythonpath`, ruff `per-file-ignores`; then
  `uv lock`, and `task setup` to drop stale `*.egg-info` (the
  ModuleNotFoundError entry in `docs/contributing/gotchas.md`).
- `tsconfig.json` paths and roots, `vitest.config.ts` aliases and roots, ESLint
  config globs; `bun install` so `tests/test_js_lockfiles.py` stays green.
- `.pre-commit-config.yaml` file patterns and `.gitignore`.
- Path-keyed ratchet baselines: `ci/english_names_baseline_py.json`,
  `ci/german_stems.json`, `frontends/ui/english-names-baseline.json`. Rewrite
  the keys; the counts must not change.
- `tests/.test_durations`: rewrite the keys or regenerate with
  `task be:test:durations`, or the shards unbalance.
- Every `AGENTS.md` and `CLAUDE.md` pair moves with its directory;
  `scripts/check_agent_docs.py` fails a guide that links to a moved path. The
  scope list in ADR-0050's consequences is history; the root `AGENTS.md`
  pointer is not.
- Docs: `docs/architecture/where-is-what.md` (`scripts/check_doc_paths.py`
  fails a dead path), `system-overview.md`, `backend-deep-dive.md`,
  `CONTRIBUTING.md`, `definition-of-done.md`'s table, and every other doc
  `git grep -F <old path>` finds.
- The layout test's allowlist: the old name leaves it in the same PR.

### Consequences

* Good, because `ls` says what is where: things that run, things they import,
  the schemas between them, the evals that measure them.
* Good, because the BFF becomes a folder a reader can find, at the cost of
  two config files and no import.
* Good, because every package directory is its distribution name, so uv's
  workspace, Dependabot and a reader all see the same list.
* Good, because each move is a separate, mechanical PR that an agent can do
  with this checklist and the guards named here.
* Bad, because ten PRs of churn land on a busy repo, and each one forces open
  branches to merge `develop` across a rename.
* Bad, because `git log` and `git blame` need `--follow` across each move, and
  links into old paths from outside the repo (issues, chat) break.
* Bad, because 9a touches about 1,700 files in one PR, and the Kubernetes
  rename needs three operator deploys for no functional change.
* Bad, because until row 8 lands the tree is half old and half new. The
  layout test's allowlist says which half each directory is in.
* Neutral: `scripts/` and `tests/` keep their names and lose some contents.

### Confirmation

Nothing enforces the target yet. Row 0 adds the gate, and each move tightens
it:

- `tests/test_repo_layout.py` asserts that every top-level tracked directory
  is in an allowlist of the target names plus the legacy names still waiting
  to move. A move removes its legacy name; a new top-level directory fails
  until someone adds it, which is the moment to ask whether it says its job.
- The same test counts tracked paths containing `aiq` against a baseline that
  may only fall, and after 9c asserts zero.
- After row 8, a count ratchet on React modules under
  `apps/workspace/server/`, starting at 13 and falling to zero.
- Each move is verified by `task lint:repo` and `task verify`, plus
  `task pkg:test` for row 5 (it lands in `packages/`) and
  `task db:test:rls` for row 8 (the tenant boundary moves); a moved image is
  built once locally; the PR shows `git diff -M --stat` reporting renames,
  not deletes and adds.
- The filter-coverage test from row 0 is what catches a move that leaves a
  path outside every CI filter.

## Pros and Cons of the Options

### 1. Do nothing

* Good, because no churn.
* Bad, because every newcomer and every agent session pays the explanation,
  and `where-is-what.md` grows rows that exist only to translate names.

### 2. `tools/evals` and `tools/scripts`, `packages/adapters/*`

* Good, because one top-level `tools/` collects everything that is neither
  app nor library.
* Bad, because moving `scripts/` touches 982 lines in exchange for a parent
  folder named "tools", which says less than "scripts" did. Premise: 982
  references measured on 39f8628.
* Bad, because `packages/adapters/ris` breaks rule 3 (the directory is not the
  distribution `ris-adapter`) and needs a second uv workspace glob for a
  folder that holds two packages.

### 4. One big-bang PR

* Good, because the half-moved state never exists.
* Bad, because it conflicts with every open PR at once and cannot land while
  any is in flight. Premise: the repo merges several PRs a day across all
  trees, so there is never an empty queue for the whole repo, only for one
  tree at a time.

## More Information

* ADR-0003 (Next.js hosts the BFF), ADR-0050 (scoped guides beside the code),
  ADR-0082 (backend roles; this record says where step D lands), ADR-0103
  (Bun toolchain; `bun install` per JavaScript workspace), ADR-0122 (the agent
  door).
* Revisit if Next.js stops hosting the BFF (ADR-0003's option B triggers): the
  BFF then becomes `apps/` of its own and `server/` is the cut line.
* Revisit the `piloti_` prefix if the product is renamed; the directories do
  not carry it and would not move.
