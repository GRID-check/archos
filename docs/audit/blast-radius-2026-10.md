# Blast radius: what a one-file change costs, October 2026

The complaint: "even though we do selective CI, everything still feels super
slow because it's so tightly coupled; one tiny change requires everything to be
imported." What should be true instead: a one-file change touches, tests and
type-checks only what it actually reaches.

Measured on `develop` at `21f1713` (2026-10-27), on a 4-core cloud container,
except section 4, which is GitHub Actions. Every number names the command or
script that produced it; the scripts are in the appendix.

## The answer in five lines

1. **Python's selection is precise, but rarely gets to run.** testmon selects 1
   to 307 of 15,631 tests for a one-file edit (section 1). But a re-run of a
   pull request added every file `develop` changed in the hour before, and that
   hour forced the full Python suite on **90 of 113** re-runs, because `develop`
   touches `pyproject.toml`, `scripts/rls-test-db.sh` or `bun.lock` most hours.
   This PR makes those re-runs select from the PR's own diff: 27 of 113.
2. **Every small Python run paid 4.6 s before its first test.** That was the
   root conftest importing LangChain, NAT and the Qdrant client, plus three
   package `__init__` barrels. A one-line harness test took 5.7 s and now takes
   1.3 s, and the Repo checks harness tests 11.8 s → 6.6 s (section 3).
3. **The UI selection is wide for a structural reason.** The median squash
   commit that touches the UI selects 815 of 1,644 specs, which is 86% of the
   suite's time (section 1). Half of those commits change one dictionary
   string, which reaches ~720 specs. The other half touch a module behind the db
   schema barrel or `lib/api/errors.ts`. That is a split, not a quick win, and
   is ranked in section 6.
4. **Every UI selection also carries 116 tree-reading specs**, 34.7 s of spec
   time, even for a leaf change that reaches one spec.
5. **Ratchets now hold both sides.** `task fe:blast-radius` fails a new UI hub or
   a hub that grows past its recorded reach. `tests/test_import_weight.py`
   fails a conftest or package `__init__` that starts importing the world again.

## 1. Selection size per change

### UI: `vitest related`, as `fe:test:related` runs it

Counted with vitest's own resolver (`createVitest` → `specifications.filterTestsBySource`,
script `related.mjs`), so these are the specs CI would run. "With CI floor" adds
the 116 specs `ci/pr_selection.py` runs on every selection because they read the
tree from disk. Spec time is the sum of `tests/vitest-durations.json` over the
selection; the full suite is 631 s of spec time.

| Changed file | `related` selects | With CI floor | Spec time |
|---|---|---|---|
| `components/shell/route-dialog.tsx` (leaf component) | 1 | 117 / 1,644 | 36 s (6%) |
| `features/documents/components/mail-import-action.tsx` (leaf) | 1 | 117 | 53 s (8%) |
| `features/documents/index.ts` (barrel) | 30 | 146 | 96 s (15%) |
| `features/chat/stores/effort-store.ts` (store) | 54 | 170 | 146 s (23%) |
| `lib/documents/findings-service.ts` (domain service) | 135 | 240 | 56 s (9%) |
| `features/documents/store.ts` (store) | 145 | 258 | 254 s (40%) |
| `lib/api/handler.ts` | 211 | 315 | 58 s (9%) |
| `components/ui/button.tsx` | 296 | 408 | 475 s (75%) |
| `lib/format.ts` (util) | 318 | 421 | 371 s (59%) |
| `lib/utils.ts` (`cn`) | 410 | 521 | 509 s (81%) |
| `i18n/config.ts` | 627 | 722 | 536 s (85%) |
| `lib/projects/project-status.ts` | 691 | 775 | 342 s (54%) |
| `lib/api/errors.ts` | 764 | 847 | 373 s (59%) |
| `shared/config/request-body-limit.ts` (a constant) | 795 | 877 | 394 s (62%) |

The first query paid 39 s of transforms to walk every spec's graph. Each CI
shard pays that walk again, inside its run.

**What real changes select.** I replayed the 115 squash commits on `develop`
from the last 7 days through `decide_ui`, using esbuild's graph (section 2) for
the reach:

| | Commits |
|---|---|
| UI none (nothing a spec reads changed) | 56 |
| UI full (manifest, lockfile, vitest config, `ci.yml`) | 14 |
| UI select | 45: median **815** specs, p90 1,089; median **86%** of suite spec time |

The widest file in each selecting commit was an i18n dictionary in 18 of 37
cases (`en/chat.ts` 6 times), a `src/lib` module at ≥600 specs in 3 more, and a
db schema table in 2.

### Python: pytest-testmon, as `be:test:affected` runs it

I recorded a fresh database with `TESTMON_DATAFILE=… pytest tests/ -n logical --testmon`
(15,631 passed, 2 min 09 s; the api suite 1,802 in 35 s). Then, for each file, I
made one edit inside its first function and one at module level, and counted
`pytest --collect-only --testmon-forceselect` (script `probe_testmon.py`).

| Changed file | Edit in a function | Edit at module level |
|---|---|---|
| `common/turn_status.py` | 47 tests in 38 files | 206 in 79 |
| `common/wire_v2.py` | 8 in 6 | 49 in 33 |
| `common/citation_verification.py` | 13 in 10 | 307 in 62 |
| `common/llm_factory.py` | 8 in 8 | 45 in 24 |
| `profile_names.py` | 2 in 2 | 21 in 17 |
| `tools/documents/filing.py` | 1 in 1 | 3 in 2 |
| `knowledge_layer/qdrant/scope.py` | 0 | 2 in 1 |
| `aiq_api/routes/config_info.py` (api suite) | 0 | 2 in 1 |
| `aiq_api/chat_socket.py` (api suite) | 2 in 1 | 80 in 2 |

Out of 15,631 tests in core and 1,802 in api: the selection is fine-grained.
Every selection still paid about 8 s to start pytest and collect, which is the
subject of section 3.

**How often the Python selection got to run.** Replaying the 113 squash
commits from 2026-10-20 20:00 to 2026-10-27 20:00 through `decide_python` and
`decide_ui`, old script against new:

| | Python full | Python select | UI full | UI none |
|---|---|---|---|---|
| A first run (the commit's own files), old | 33 | 80 | 14 | 55 |
| A first run, new (fixture and helper rules) | 27 | 86 | 14 | 54 |
| A re-run that adds the 75 min of `develop` before it, as the old `changed_paths` did | **90** | 23 | 45 | 3 |
| A re-run now (cheaper of the two sound references, this PR) | 27 | 86 | 14 | 54 |

Before, the re-run's full runs came from `develop`'s files, not the PR's:
`pyproject.toml` (27 windows), `scripts/rls-test-db.sh` (18), `tests/fixtures/**` (12),
`.github/` (11), `taskfiles/` (8). A 75-minute window of `develop` held a median
83 files (p90 384). In 3 of the 8 PR Plan logs sampled in section 4, the full run
came from one fixture alone, `tests/fixtures/citation_pipeline/grounding_block_all_fields.txt`.

## 2. Fan-in hubs

### UI (`frontends/ui/src`)

The graph comes from esbuild's metafile, with all 1,610 TS specs as entry
points, `packages: 'external'` and the repo's tsconfig: 4,164 modules in 5 s.
esbuild drops type-only imports the way vitest's transform does. On the 14 files
above it never selected fewer specs than `vitest related`, and up to 2× more,
because it does not know `vi.mock` replaces a module. dependency-cruiser
(`--ts-pre-compilation-deps`, so type-only edges included, 25 s) gave the
type-checker's view.

Distribution of runtime reach: the median module is reached by **64** specs, p75
by 131, p90 by 413. **179 modules each reach ≥700 specs.**

Top 30 by specs reaching the module (`node scripts/blast-radius.mjs --top 30`):

| # | Module | Specs reaching it | Direct importers |
|---|---|---|---|
| 1 | `src/shared/config/request-body-limit.ts` | 874 | 8 |
| 2 | `src/i18n/config.ts` | 851 | 30 |
| 3 | `src/lib/api/errors.ts` | 843 | 390 |
| 4 | `src/lib/documents/document-status.ts` | 819 | 34 |
| 5 | `src/lib/project-profile/primitive-value.ts` | 815 | 2 |
| 6 | `src/lib/project-profile/evidence-schema.ts` | 815 | 9 |
| 7 | `src/lib/project-profile/types.ts` | 815 | 82 |
| 8 | `src/lib/project-profile/legacy-names.json` | 812 | 2 |
| 9 | `src/lib/project-profile/legacy-names.ts` | 812 | 19 |
| 10 | `src/lib/projects/month.ts` | 811 | 19 |
| 11 | `src/lib/projects/project-status.ts` | 808 | 64 |
| 12 | `src/lib/tasks/task-vocabulary.ts` | 794 | 14 |
| 13 | `src/lib/projects/folders.ts` | 784 | 22 |
| 14 | `src/lib/documents/document-authors.ts` | 782 | 7 |
| 15 | `src/lib/limits/catalog.ts` | 780 | 11 |
| 16 | `src/lib/limits/rules.js` | 780 | 1 |
| 17 | `src/lib/annotations/types.ts` | 779 | 80 |
| 18 | `src/lib/geocoding/types.ts` | 777 | 23 |
| 19 | `src/lib/documents/lifecycle-types.ts` | 776 | 58 |
| 20 | `src/lib/project-intake/types.ts` | 775 | 71 |
| 21 | `src/lib/proposals/types.ts` | 771 | 54 |
| 22 | `src/lib/projects/memory-vocabulary.ts` | 771 | 4 |
| 23 | `src/lib/db/schema/projects.ts` | 770 | 20 |
| 24 | `src/lib/db/schema/task-model.ts` | 769 | 2 |
| 25 | `src/lib/db/schema/conversations.ts` | 769 | 8 |
| 26 | `src/lib/db/schema/project-folders.ts` | 768 | 5 |
| 27 | `src/lib/db/schema/documents.ts` | 768 | 17 |
| 28 | `src/lib/db/schema/product-feedback.ts` | 768 | 2 |
| 29 | `src/lib/db/schema/document-annotations.ts` | 766 | 2 |
| 30 | `src/lib/db/schema/permit-records.ts` | 766 | 3 |

Most of these are leaves with few importers. They are wide because they sit
below one of two funnels:

- **The db schema barrel**, `src/lib/db/schema/index.ts`: 62 re-exports, 372
  direct importers, reached by 765 specs. Every table file and everything a
  table imports (profile types, task vocabularies, document status) is reached
  by every spec that touches the database. Removing the barrel from the graph
  takes `db/schema/product-feedback.ts` from 768 to 291 specs,
  `tasks/task-vocabulary.ts` from 794 to 538 and `documents/document-status.ts`
  from 819 to 642.
- **`src/lib/api/errors.ts`**, with 390 direct importers. Its own reach (843) is
  inherent, but it imports `request-body-limit.ts` for one constant
  (`BYTES_PER_MB`), which makes a config constant the widest module in the app
  (874).

**Barrels** (47 `index.ts` files) by reach: `lib/db/schema/index.ts` (765, 62
re-exports), `i18n/dictionaries/en/index.ts` and `de/index.ts` (724/723, 42 and 43
namespaces each), `i18n/dictionaries/index.ts` (707), `lib/db/index.ts` (563),
`lib/cache/index.ts` (503), `features/chat/lib/citations/index.ts` (492),
`i18n/index.ts` (399, 607 direct importers), `test-utils/index.tsx` (321),
`adapters/api/index.ts` (205). `features/documents/index.ts` (75 lines of
re-exports) reaches only 53 specs at runtime, but it is a member of the type-only
cycle below.

**Type-only hubs** cost the type-checker, never vitest: `lib/limits/types.ts`
(3,048 dependents counting type edges, 0 at runtime) and `lib/auth/types.ts`
(2,985 vs 2). Counting type edges, one strongly connected component holds 372
modules (142 in `features/documents`, 89 in `features/chat`, 38 in
`features/grid-cards`, 26 in `features/search`). Without type edges, the largest
runtime cycle is 31 modules, in `lib/documents`. That component is why
`bun check src/features/documents/store.ts` checks 1,130 files. A leaf like
`components/shell/route-dialog.tsx` checks 8.

**Giant modules** (lines, specs reaching): `lib/documents/service.ts` (3,346,
279), `lib/project-profile/intake-definition.ts` (2,549, 466),
`lib/documents/repository.ts` (2,414, 369), and the dictionaries `en/chat.ts`
and `de/chat.ts` (2,168 and 2,199, ~724 each). `layout/components/InputArea.tsx`
(2,781, 13) and `ChatArea.tsx` (2,600, 6) are big but not wide.

### Python (`aiq_agent`, `aiq_api`, `knowledge_layer` and their tests)

Built with grimp 3.18, the engine of import-linter: 1,188 modules, 662 test
modules, built in 0.2 s. Test directories are not packages, so they were
mirrored into a scratch tree with `__init__.py` files to make them importable.
grimp counts static imports, function-local ones included. It does **not**
count the parent-package `__init__` that Python executes before every submodule,
which is where the cost really was (section 3).

| # | Module | Test modules importing it (transitively) | Direct importers |
|---|---|---|---|
| 1 | `aiq_agent.profile_names` | 503 | 10 |
| 2 | `aiq_agent.project_context` | 501 | 78 |
| 3 | `aiq_agent.observability.trace_context` | 491 | 9 |
| 4 | `aiq_agent.observability.retrieval_trace` | 488 | 14 |
| 5 | `aiq_agent.observability.decision_trace` | 487 | 5 |
| 6 | `aiq_agent.observability.turn_outcome` | 487 | 7 |
| 7 | `aiq_agent.observability.turn_phases` | 487 | 5 |
| 8 | `aiq_agent.common.image_redaction` | 486 | 5 |
| 9 | `aiq_agent.observability.langfuse_trace_attributes` | 486 | 30 |
| 10 | `aiq_agent.common.cache` | 477 | 20 |
| 11 | `aiq_agent.common.source_kinds` | 475 | 70 |
| 12 | `aiq_agent.common.lease_slots` | 471 | 4 |
| 13 | `aiq_agent.common.profiler` | 471 | 15 |
| 14 | `aiq_agent.observability.usage_rollup` | 471 | 2 |
| 15 | `aiq_agent.common.provider_limiter` | 468 | 26 |
| 16 | `aiq_agent.common.wire_v2` | 467 | 65 |
| 17 | `aiq_agent.common.prompt_caching` | 466 | 4 |
| 18 | `aiq_agent.common.estate_paths` | 465 | 12 |
| 19 | `aiq_agent.common.llm_factory` | 465 | 15 |
| 20 | `aiq_agent.common.message_contract` | 465 | 3 |
| 21 | `aiq_agent.common.model_overrides` | 465 | 24 |
| 22 | `aiq_agent.common.openrouter` | 465 | 30 |
| 23 | `aiq_agent.common.reasoning_settings` | 465 | 8 |
| 24 | `aiq_agent.common.turn_status` | 461 | 86 |
| 25 | `aiq_agent.common.workspace_records` | 461 | 5 |
| 26 | `aiq_agent.common.cost_tracking` | 458 | 36 |
| 27 | `aiq_agent.common.llm_credentials` | 457 | 9 |
| 28 | `aiq_agent.common.config_validation` | 454 | 2 |
| 29 | `aiq_agent.common.credential_resolution` | 454 | 19 |
| 30 | `aiq_agent.common.message_utils` | 454 | 19 |

The static fan-in matters less here than in the UI, because testmon selects by
executed code (section 1). Where it matters is import cost, and there the hubs
were four **eager package barrels**:

- `aiq_agent/common/__init__.py`: 61 re-exports from 25 submodules, plus
  LangGraph's Postgres and SQLite checkpointers and psycopg's pool at import.
- `aiq_agent/agents/__init__.py`, `agents/piloti/__init__.py` and
  `agents/deep_researcher/__init__.py`: each imported its register modules, so
  `aiq_agent.agents.piloti.ledger` loaded both agent graphs.
- `knowledge_layer/__init__.py` (`sources/knowledge_layer/src`): imported
  `register`, `browse` and `read_passage` for their NAT registrations, so
  `knowledge_layer.qdrant.scope` loaded LlamaIndex and NAT.

**Cycle:** 26 non-test modules form one strongly connected component across
`knowledge_layer.llamaindex` (8), `aiq_agent.knowledge` (7), `aiq_agent.agents`
(3) and `aiq_agent.stages` (2). **Giant modules** (lines, test modules reaching
them): `knowledge_layer.llamaindex.adapter` (6,905, 380),
`common.citation_verification` (4,509, 400), `knowledge_layer.register` (3,119,
380), `knowledge_layer.browse` (2,863, 380), `cards.models` (2,693, 380),
`common.turn_status` (2,226, 461).

## 3. Startup cost

### Python imports (`python -X importtime -c "import X"`, cumulative, 3 runs)

| Module | Before | After this PR |
|---|---|---|
| `aiq_agent.common.turn_status` | 1.87–1.99 s (1.66 s of it the `aiq_agent.common` package) | 0.75–0.89 s |
| `aiq_agent.common.wire_v2` | 1.85–2.06 s | 0.28–0.37 s |
| `aiq_agent.agents.piloti.ledger` | 3.44–3.51 s | 2.57–2.71 s |
| `knowledge_layer.qdrant.scope` | 3.31–3.50 s | 0.99–1.27 s |
| `aiq_api.routes.config_info` | 3.65–3.76 s | 3.05–3.14 s |
| `tests.conftest` | 3.46 s (4.8 s wall) | no LangChain, NAT, LangGraph or Qdrant at all |

### pytest end to end (wall, 3 runs each)

| Run | Before | After |
|---|---|---|
| `pytest tests/test_bun_version_pin.py` (7 tests, 0.03 s of test time) | 5.6–5.9 s; 1.05–1.15 s with `--noconftest` | 1.17–1.48 s |
| `pytest tests/aiq_agent/common/test_turn_status.py` (88 tests) | 6.4–6.9 s | 4.5–4.6 s |
| `be:test:harness` (the Repo checks job's 372 tests) | 11.6–12.1 s | 6.4–6.8 s |
| `pytest tests/ -n logical` (whole core suite) | 96.7 s | 93.7 s (unchanged: it imports everything either way) |
| `pytest tests/ --collect-only` | 19.2 s | 21.0 s (the imports moved from the conftest into collection) |

The win lands on small runs: a selected `be:test:affected` shard, the harness
tests, and every local single-file run. The full suite stays the same.

### vitest per-file cost

`bunx vitest run src/lib/ids.spec.ts` (3 tests of a pure function): 0.75–0.85 s
of vitest duration, of which setup is 41–47% and the happy-dom environment
37–49%; the tests are 1%. The same spec under `// @vitest-environment node`
takes 0.22–0.33 s. Of 1,194 `.spec.ts`/`.test.ts` files, 744 already declare
`node`. Of the ~450 that do not, about 120 reference a DOM API. That leaves
roughly **330 specs × ~0.5 s ≈ 165 s of worker time** on a full run (the suite
is 631 s), plus the same share of any selection. I left this out of the PR because
it means a header in ~330 spec files across `features/` and `lib/`, which other
sessions are moving. It is the first follow-up below.

### Type-checking

`bun run type-check` (TypeScript 7's checker in Bun, the whole 4,536-file
program, no incremental state) takes 8.3–12.1 s. `bun check <file>` checks a file
and its imports: `lib/ids.ts` 1 file in 0.98 s, `lib/api/handler.ts` 161 files
in 1.5 s, `features/documents/store.ts` 1,130 files in 2.8 s (the type-only cycle
above). About 1 s of each run is loading the program. Not a bottleneck.

## 4. CI (GitHub Actions, `ci.yml`)

Sampled read-only through the Actions API: 19 finished develop push runs and
the 20 newest green pull-request runs, all on 2026-10-27. That is one day, so
read the numbers as indicative.

| | develop push | pull request |
|---|---|---|
| Wall time, median / p90 | 11.8 / 15.9 min | 4.2 / 5.7 min |
| Wait before the first job, median | 193 s (the develop concurrency group queues, `cancel-in-progress: false`; 11 of 30 develop runs ended cancelled) | 3 s |
| Runner-minutes per run, median | 34.9 | 25.2 |

What dominates:

- **On pull requests: Repo checks.** It runs on every PR, takes 194 s median
  (p90 301), and finished last in 9 of 20 runs. Its `fetch-depth: 0` checkout
  alone is 75 s median, max 384 s; the checks themselves are ~80 s. SAST does
  the same full-history checkout (72 s) for a 10-second Semgrep scan.
- **On develop: the frontend image build**, 503 s median for `build-image`
  (199 s without push on PRs). It was the last job in 13 of 19 develop runs.
- **Backend core shard**: 109 s of tests plus ~40 s of setup (python env 22 s).
  **Frontend shard**: 118 s full or 84 s selected, plus ~24 s of setup.
- **Path filters and selection** on the 20 PR runs: Python full 9, select 3,
  backend off 8; UI full 4, select 6, off 10. In the 8 Plan logs read, the
  "changes since" set was 101 to 1,131 files, and Python came out full in 6 of
  them. Three of those six were the single fixture file named in section 1.

## 5. What this pull request changed, and what each bought

| Change | Before → after | Measured by |
|---|---|---|
| A re-run takes the cheaper of two sound references, the PR's whole diff or the diff since its last green run plus `develop`'s hour (`ci/pr_selection.py` `changed_paths`, `cheaper`) | Re-runs forcing the full Python suite 90 → 27 of 113; full UI 45 → 14; no UI at all 3 → 54 | Replay of 113 develop commits through old and new `decide_*` |
| A data fixture under `tests/fixtures/` selects the tests that name it or any of its directories; full if none does, for a Python fixture, or when a helper or conftest reads it (by a quoted name), since nothing says which tests load the helper | First runs forcing full Python 33 → 27; the fixture that forced 3 of 8 sampled PR runs now selects `test_grounding_block.py`. The helper rule applies to every non-Python input and closes a hole: `intake/conftest.py` and `folder_cards/conftest.py` read UI schema files no test file names | Same replay; `tests/test_pr_selection.py` |
| `aiq_agent`, `aiq_agent.common`, `aiq_agent.agents`, `agents.piloti`, `agents.deep_researcher` and `knowledge_layer` re-export lazily (`aiq_agent/lazy_exports.py`, PEP 562) | Import times in section 3 | `-X importtime` |
| `knowledge_layer.browse` and `knowledge_layer.read_passage` get their own `nat.plugins` entry points, as `sources/AGENTS.md` asks, and `knowledge_layer/__init__.py` re-exports nothing (nothing imported its six names, and `read_passage` was both a function and a submodule) | `list_files` and `read_passage` still register; the package `__init__` was what registered them | NAT's `discover_and_register_plugins` lists all three; `test_import_weight.py` |
| Root conftest imports only `pytest`; the model doubles move to `tests/provider_doubles.py`; the Qdrant fixtures to `sources/knowledge_layer/tests/qdrant_fixtures.py`, which imports the client on first use | A 7-test file 5.7 s → 1.3 s; harness 11.8 s → 6.6 s | Section 3 |

Every suite passed afterwards: core 15,636 passed / 381 skipped, api 1,802 /
27, sources 609 / 149.

**Why the re-run change is sound.** The old reference already treated a first
run against the merge base as sound, with no `develop` files added. The
argument behind that: a test that reaches none of the PR's files gives on the
merge commit what it gives on `develop`, and `develop`'s own full run is the
deploy gate. On a re-run, the PR's whole diff is that same reference, and it
holds only measured from `develop`'s testmon database. The api and sources
suites keep a database per pull request, from which a test reaching a file an
earlier push changed is no longer selected. So when the whole diff wins, the
Plan job says so (`reference: base`) and those suites restore `develop`'s
database instead (found by the independent review; `tests/test_ci_workflows.py`
pins it). The old re-run reference stays a candidate, and wins whenever
`develop` stood still.

## 6. Ratchets added

- **`task fe:blast-radius`** (`frontends/ui/scripts/blast-radius.mjs`, ~5 s, in
  `fe:verify` and the CI Frontend job). It counts, for every module, the specs
  that reach it, over esbuild's graph, and compares the counts with
  `scripts/blast-radius.baseline.json` (every module at ≥240 specs that
  imports something of ours, 308 of them). A recorded module fails when it
  grows by more than 10% or 10 specs, whichever is larger; a module outside
  the baseline fails past 300 with the same slack (330). Both limits scale
  with the number of specs, so specs other pull requests add do not fail
  this one. A leaf, which imports nothing of ours, is held by neither rule:
  it is as wide as its importers, and an edge that widens it shows up on
  them. The first version had neither the new-hub slack nor the leaf rule,
  and `develop` went red minutes after it merged, when #1256 and #1257
  landed beside it (#1261 re-recorded; `docs/contributing/gotchas.md` says
  what to do next time). `-- --update` rewrites the baseline, and the PR
  says why; `-- --top 30` prints the list above.
- **`tests/test_import_weight.py`** (~5 s, core suite). In a fresh interpreter,
  each lazy package loads none of its own submodules and nothing heavy, and
  re-exports no name one of its submodules has; neither conftest every test
  loads (core and api) loads LangChain, LangGraph, NAT, Qdrant, LlamaIndex,
  OpenAI or `aiq_agent.common`; and each knowledge-layer module that registers
  a tool is a `nat.plugins` entry point. Against the old code, 6 of its first
  8 cases failed.

## 7. Structural fixes, ranked by what they would cut

For the sessions splitting giant files and moving directories. Each estimate is
the esbuild reach with the edge removed, so it is an upper bound on what vitest
would drop.

1. **Split the i18n dictionaries by namespace at the import site.**
   `i18n/dictionaries/index.ts` aggregates `en/` and `de/` (42 and 43 namespace
   files), and everything that translates reaches it. A copy change selects
   ~724 specs; it was the widest change in 18 of 37 recent UI-selecting commits.
   Fix: components import (or `useTranslations` resolves) their own namespace
   module, and only the provider and `key-coverage.spec.ts` hold the aggregate.
   With the aggregate gone, `en/chat.ts` drops to the 29 specs that import it
   directly. The realistic figure is that plus the specs rendering a chat
   component. Highest value, because copy changes are the most common UI change.
2. **Stop importing the db schema barrel from repositories.**
   `lib/db/schema/index.ts` (62 tables, 372 importers) puts every table file and
   its imports below every database-touching spec. Import the table module
   directly (`@/lib/db/schema/projects`), and leave the barrel only where drizzle
   needs the whole schema object (`lib/db/index.ts`, the relational query API).
   That client needs the full schema, so `lib/db/index.ts` (563 specs) stays a
   hub, and the cut comes from repositories that take the client and import
   tables directly. Removing the barrel takes a table from ~768 to ~291 specs
   and `task-vocabulary.ts` from 794 to 538.
3. **Cut `lib/api/errors.ts` → `shared/config/request-body-limit.ts`.** Inline
   `BYTES_PER_MB` (a constant), or move the error that needs it into
   `lib/api/body-limit-error.ts`. That takes the config file from 874 specs to
   its real users. `errors.ts` (843) is inherent, so keep it a leaf: it must
   never import a domain module, which the ratchet now enforces.
4. **Vocabulary leaves that import `ForbiddenError`.** `lib/projects/project-status.ts`
   (808), `session-documents/conversation-id.ts` (766) and similar modules pull
   `lib/api/errors.ts` in to throw. Return a result and let the route map it, or
   import a tiny `lib/api/forbidden.ts`. Each such leaf then stops dragging
   `errors.ts`'s 390-importer cone along, and vice versa.
5. **Break the 372-module type-only cycle** in `features/documents`,
   `features/chat`, `features/grid-cards` and `features/search`. It costs nothing
   at test time but makes `bun check` of one store check 1,130 files.
   `features/documents/index.ts` (75 lines of re-exports) is the first barrel to
   delete: import from the defining file.
6. **Python: break the 26-module cycle** between `knowledge_layer.llamaindex`,
   `aiq_agent.knowledge`, `aiq_agent.agents` and `aiq_agent.stages`, and split
   `knowledge_layer.llamaindex.adapter` (6,905 lines, 380 test modules) and
   `common.citation_verification` (4,509, 400). testmon already selects
   precisely, so the gain is import time (~1 s per small run) and module-level
   edits. A module-level edit to `citation_verification` selects 307 tests; one
   inside a function selects 13.
7. **`lib/project-profile/intake-definition.ts`** (2,549 lines, 466 specs) and
   **`lib/documents/service.ts`** (3,346, 279): both large and wide, both
   already on the split list.

Not structural, but measured and left out of this PR:

- **The `node` vitest environment for ~330 pure-logic specs**, about 165 s of
  worker time per full run (section 3). Mechanical, but it touches ~330 spec
  files that other sessions are moving. Do it after the moves.
- **The 116 tree-reading specs on every UI selection** (34.7 s of spec time,
  117 specs for a one-spec change). Most read a fixed set of paths. Giving each
  spec a declared input glob would let `decide_ui` run one only when its inputs
  change.
  *Done (2026-10-27): each declares a `// @disk-inputs:` line, checked at run
  time by `config/vitest/disk-inputs.ts`; a one-file chat change now selects
  ~25 of 124 (`docs/contributing/ci.md`).*
- **Repo checks and SAST check out the full history** (75 s and 72 s median).
  A shallow clone plus a targeted fetch of the base would save about a minute
  on every PR's critical path.

## Appendix: reproducing

The scripts are not in the repo. They live in the session scratchpad and are
described here.

- UI `related` counts: `createVitest('test', {watch:false, run:true})`, then for
  each file `vitest.config.related = [file]` and
  `specifications.filterTestsBySource(await specifications.globTestSpecifications())`,
  run from `frontends/ui`.
- UI graph: `node scripts/blast-radius.mjs --top N` (in the repo now).
  dependency-cruiser 18.7 needs `typescript@5` beside it, because the UI's
  TypeScript 7 has no JS API.
- Python graph: `grimp.build_graph('aiq_agent', 'aiq_api', 'knowledge_layer', <mirrored test packages>)`,
  then `find_downstream_modules` per module.
- testmon: `TESTMON_DATAFILE=<db> pytest tests/ -n logical --testmon`. Then, per
  file and edit, a copy of the database and
  `pytest tests/ --collect-only --testmon-forceselect`.
- Replay: `git log --first-parent --since='7 days ago' origin/develop`, each
  commit's files through `decide_python` and `decide_ui` from the old
  (`git show HEAD:ci/pr_selection.py`) and new script, with the files `develop`
  changed in the 75 minutes before each commit as the re-run's base set.
