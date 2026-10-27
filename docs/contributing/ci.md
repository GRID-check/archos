# CI: what it is for, and how it decides what to run

This page is the design of the GitHub Actions setup. The workflow files carry
the details next to the code they explain; this is the map, and the reasons.

## What CI is for

| Job to do | When | Where | Gate? |
|---|---|---|---|
| Prove a pull request, applied to its base, keeps every check its change could break | every push to a PR | `ci.yml` | **Yes: `CI OK`** is the one required status check |
| Prove the merged result, build its images, tag them for the commit | every push to `develop` and `release/**` | `ci.yml` | It is what the deploy waits for |
| Put a green `develop` commit on staging | after a green push run of CI | `deploy.yml` | Staging only ever runs a commit CI passed |
| Put the pinned commit on production | push to `prod`, with reviewers | `deploy.yml` | The `production` environment's reviewers |
| Notice what turns red without a code change: new CVEs, a secret in history, external links, model drift, WorkOS drift | weekly | `security.yml`, `docs-links.yml`, `turn-shapes-live.yml`, `workos-drift.yml` | No. A red run is a finding to triage |
| PR hygiene: Conventional title, closing keywords, labels | PR events | `pr.yml` | The title check |
| Publish the changelog | merge touching `releasenotes/` | `release-notes.yml` | No |

Everything else (`claude.yml`, `claude-code-review.yml`, `blog-preview.yml`,
`labels.yml`) is assistance, not verification.

## How a CI run decides what to run

The `changes` job (named **Plan**) answers three questions before any check
starts, and every other job reads its answers.

**1. What did this change touch?** `dorny/paths-filter` over
[`.github/filters.yml`](../../.github/filters.yml), against a base:

- a pull request diffs against its base branch, the whole PR on every push;
- a push diffs against the **last commit CI passed on that branch**
  ([`ci/last_green.py`](../../ci/last_green.py)), never against the previous
  push. When there is no such commit, or the lookup fails, it diffs against the
  root commit and everything runs.

A skipped tier counts as passed, so a path no tier names is a path whose
change merges untested. [`tests/test_ci_filter_coverage.py`](../../tests/test_ci_filter_coverage.py)
fails on any tracked path outside every test tier unless its `UNFILTERED` list
says why no tier needs it; moving a directory without moving its filter line
turns Repo checks red. It matches with wcmatch and checks that against
picomatch, which is what `dorny/paths-filter` uses, wherever node is installed.

The second rule is what makes the rest safe. A push that diffed only against
its parent let a red commit's tier stop running as soon as an unrelated commit
landed on top of it, and the deploy shipped the broken code under a green run.

**2. Was this exact tree already tested?** A squash merge onto a `develop` that
did not move lands the tree the PR's last run tested. If that run was green
*and* the pushed commit's parent is the last green commit, every check skips
([`ci/reuse_green_run.py`](../../ci/reuse_green_run.py)). The parent condition
matters: a PR run that skipped the backend because it did not touch it proves
nothing about a backend that was already red on `develop`.

**3. Which images does this run build?** Each image is named by a hash of the
files its Dockerfile copies, plus the ISO week
([`ci/image_inputs.py`](../../ci/image_inputs.py)). A PR builds the images
whose hash its change moves, and pushes nothing. A push builds the images GHCR
does not have yet under `inputs-<hash>`, and re-tags the rest. The week is in
the hash because base images (`node:22-slim`, `debian:bookworm-slim`) are
floating tags: every image is rebuilt at least weekly, so a patched base
reaches production without anyone asking.

It also lists the third-party image pins the change adds or moves
([`ci/pinned_images.py`](../../ci/pinned_images.py)), for trivy.

## The jobs

| Job | Runs when | What it does |
|---|---|---|
| Plan (`changes`) | always | the three answers above, written to the run summary with the reason for each |
| Repo checks (`repo`) | unless reused | pre-commit on all files, the agent-skill lockfile, ruff, the tests of `ci/`, the workflows and the release-note pipeline (`task be:test:harness`), release-note lint and (PRs) the release-note requirement, gitleaks over the commits a PR adds (a push: its full history) |
| SAST (`semgrep`) | PRs touching code | Semgrep, diff-aware: blocks findings the PR introduces |
| Backend affected tests (`backend-affected`) | PRs, backend tier, selection possible | per suite (core, aiq_api, `sources/`), only the tests the change reaches (`task be:test:affected`), plus the claim queues on Postgres |
| Backend test database (`backend-testmon`) | every push to `develop` | records which test runs which code (`task be:test:testmon`) and caches it when green. Not a check |
| Backend core (`backend`) | backend tier: pushes, and PRs testmon cannot select for | the core suite in 4 shards (`task be:test:shard`), each writing coverage data |
| Backend coverage gate (`backend-coverage`) | backend tier | combines the shards' data, the 65% gate, the PR comment |
| Backend suites (`backend-suites`) | backend tier | three jobs side by side: the aiq_api suite, the `sources/` suites, and the migration test with the claim-queue suites on a real Postgres (`task be:test:postgres`) |
| Frontend (`frontend`) | frontend tier | card schema check, lint, types, and the tenant-isolation suite against a real Postgres |
| Frontend tests (`frontend-test`) | frontend tier; on a PR, unless nothing a UI spec reads changed | the vitest suite in 8 shards, split by recorded time (`tests/vitest-durations.json`, refreshed with `task fe:test:durations`, read by `config/vitest/duration-sequencer.ts`); on a PR whose change a selection can see, only the specs it reaches (`task fe:test:related`) |
| Frontend coverage | PRs, frontend tier | merges the shards' coverage into the PR comment. Not in `CI OK` |
| Web, Infra, Standalone packages | their tier | `task site:verify`; `task infra:types` + `infra:test`; `task pkg:test:*` |
| Image vulns (`trivy`) | a pin added or moved | trivy on those pins |
| Image build (`image`) | PRs that change an image's inputs | builds it, read-only token, no push. For the UI this IS the production build check: `fe:build` is not run separately |
| Image build + push (`image-push`) | pushes, image not in GHCR | builds and pushes `inputs-<hash>` and the layer cache |
| Tag images (`publish`) | pushes, after every check passed | `sha-<commit>` on all three images, and `latest` on `develop` |
| `CI OK` (`ci-ok`) | always | fails unless every needed job passed or was skipped; on a green PR, records the tested tree for reuse |

`task verify` runs the same checks locally, minus the image builds, the RLS
suite and `packages/` (see
[testing-and-verification.md](testing-and-verification.md)).

## Images and deploys

The contract, end to end:

1. A push builds content-addressed images (`inputs-<hash>`) beside its checks.
   An image tag of that kind claims nothing about any commit.
2. Only when every check on the push has passed does `publish` put
   `sha-<commit>` on **all three** images. A commit CI failed has no `sha-` tag.
3. `CI OK` needs `publish`, so a push run concludes `success` only with the
   tags in place.
4. `deploy.yml` runs on `workflow_run` of CI, for a successful **push** run of
   this repository on `develop`, and pins all three services to
   `sha-<commit>`. No polling, no per-service guessing.
5. A prod promotion pins any `develop` commit CI passed. All of them have all
   three images.

What this replaced, and why it had to go: Publish Images rebuilt each image
only when its own paths changed since the previous push, from two hand-written
path lists that disagreed with the Dockerfiles. On 2026-10-09 a merge train of
nine commits ran Publish Images nine times; seven runs were dropped as
superseded while queued, and the last one diffed only against its own parent,
a changelog commit. It built the web image. The frontend and backend changes of
five merged pull requests were never built, and staging kept running the old
images until someone dispatched a rebuild by hand.

`GRID_GIT_SHA` inside an image is the commit that *built* it. An image whose
inputs did not change is re-tagged, not rebuilt, so a container reports the
commit its code came from.

## PostHog releases and source maps

Error tracking and the self-driving inbox date a regression by asking which
commit an exception came from and when the cluster started running it. Three
pieces of CI answer that. All are off until the secret and variable below
exist, so a fork, a pull request and a repository without PostHog build and
deploy exactly as before.

| Piece | Where | What it does |
|---|---|---|
| Source maps and release | `image-push` for the frontend image, inside `next build` in the Docker build (`@posthog/nextjs-config`, wired in `frontends/ui/next.config.ts`) | At the end of the build, injects a chunk id into the shipped JavaScript, uploads the maps to PostHog, deletes them. The release is `grid-ui` at the commit that built the image, which is the `GRID_GIT_SHA` the container reports |
| Backend release | `deploy.yml` (staging), before the plan (`PostHog/resolve-release`) | Finds or creates release `grid-agent` at the backend image's commit and hands its id to the Python tiers as `POSTHOG_RELEASE_ID` (below) |
| Deploy marker | `deploy.yml`, after each `Pulumi up` (`deploy/pulumi/scripts/posthog-annotate.sh`) | A project annotation `deploy dev <sha>` or `deploy prod <sha>` at the time the apply finished. `continue-on-error`: a PostHog outage never turns a deploy red |

| Name | Kind | Value |
|---|---|---|
| `POSTHOG_CLI_API_KEY` | secret | A personal API key with scopes `error_tracking:write`, `organization:read` and `annotation:write`, created at PostHog → Settings → User API keys. Repository-level, because `image-push` has no environment; the deploy jobs read the same one |
| `POSTHOG_PROJECT_ID` | variable | The numeric project id (269895 for the EU staging project). Not secret |
| `POSTHOG_CLI_HOST` | variable, optional | The PostHog **app** host. Default `https://eu.posthog.com`. Not the ingestion host `eu.i.posthog.com` |

Why it is built this way:

- **Inside the Docker build, not a workflow step.** The injection rewrites the
  files the image ships. A step after the build would inject into files the
  image never contained, and the chunk ids in the image would match nothing.
  `PostHog/upload-source-maps` works on a directory of the runner, so it does
  not fit an image built by BuildKit. `@posthog/nextjs-config` runs the PostHog
  CLI from Next's own after-compile hook, which is inside the build.
- **A BuildKit secret, never a build arg.** An arg is written into the image
  history. The key reaches the Dockerfile as `--mount=type=secret`, and the RUN
  that builds exports it as `POSTHOG_CLI_API_KEY` for `next.config.ts` and the
  CLI. `build-image` passes it only for the frontend image and only from
  `image-push`; a pull request build has no access and uploads nothing, so
  unmerged code never creates a release.
- **Off unless it can upload.** `next.config.ts` wraps its config with
  `withPostHogConfig` (outermost, as the package requires) only when the key
  and `POSTHOG_PROJECT_ID` are both present, and imports the package only then.
  Every other build, and the running server, which loads `next.config.ts` too,
  gets the config as written with no map flags.
- **The maps are uploaded and not served.** Next serves `.next/static/**/*.map`,
  original source included, to anyone. The package turns browser maps on only
  for the uploading build and deletes them after the upload; `next.config.ts`
  turns server maps on beside it. The same Dockerfile RUN then deletes every
  `.map` still under `.next/static` or `.next/server` (Turbopack writes some
  unasked, uploading or not) and fails the build if one survives. It fails as
  well when it uploaded and no chunk id was injected, which would mean the
  upload matches no stack frame.
- **`symbol-set` release mode**, set explicitly: the maps are bound to the
  release, as the CLI did before the package. The newer `event` mode injects a
  release id for posthog-js to send per event, which the pinned posthog-js is
  not known to read.
- **Why the release is a build commit.** An image whose inputs did not change is
  re-tagged, not rebuilt (above), so an error on such a deploy names the older
  commit that built the code. The deploy marker carries the commit that was
  deployed. Read the pair together: the release says where the code came from,
  the annotation says when users got it.
- **Chunk ids are content-addressed**, so a rebuild of unchanged files yields
  the same ids and a re-run cannot orphan an earlier upload.
- The CLI is the `@posthog/cli` the package depends on (pinned through
  `@posthog/nextjs-config`, an exact devDependency). Its npm package downloads
  the binary on first use (`bun install --ignore-scripts` skips its
  postinstall), which happens inside the build RUN, and the same RUN deletes
  the binary. It has to: `bun install --production` over an existing
  `node_modules` does not prune devDependencies (measured with bun 1.3.11), so
  the later production install would let it ship in the runtime image.
- Caching: `ARG GRID_GIT_SHA` is declared before `bun run build`, because the
  release version is read during the build. That costs nothing a rebuild did
  not already pay: an image is rebuilt only when its inputs changed, and then
  the build layer re-runs anyway. `POSTHOG_PROJECT_ID` is an arg before the
  build too, so a build with PostHog configured never reuses one without maps.

An image already in GHCR under its `inputs-<hash>` is not rebuilt when the
secret is added later, so its maps are never uploaded. Wait for the weekly
rebuild, or bump `SCHEME` in `ci/image_inputs.py`.

Python (`aiq_agent`) has no source maps; PostHog links its exceptions to a
release through `POSTHOG_RELEASE_ID`, which the SDK (`posthog>=7.59`) sends as
`$release_id`. The staging deploy runs
[`PostHog/resolve-release`](https://posthog.com/docs/error-tracking/link-releases/python)
before the plan, for release `grid-agent` at the commit the backend image was
built from (the sha in `BACKEND_IMAGE_REF`), and sets its `release-id` output as
the stack key `grid-oib:posthogReleaseId`; the program injects it as
`POSTHOG_RELEASE_ID` on every Python tier, beside `POSTHOG_HOST` and the token
and never without them. The image's commit rather than the deployed one, so a
re-deploy of the same image resolves the same release and the pods do not roll.
Without the secret the action outputs an empty id and the key is not set; the
step is `continue-on-error`, so PostHog never blocks a deploy. Prod is not
wired: its stack has no PostHog configured, so it would have nowhere to send
the id.

## Quick merges one after another

A branch has one concurrency group. A running push run is never cancelled; a
queued one is replaced when a newer push arrives. A train of nine merges
therefore costs the run in progress plus one more, and the survivor diffs
against the last green commit, so it covers every commit that was dropped. A
dropped run concludes `cancelled`, which the deploy reads as superseded.

A pull request's newer push cancels its older run, since every PR run diffs
the whole PR. Merging or closing a pull request cancels its run too
(`ci-cancel.yml` joins the same concurrency group): the squash merge's push run
tests the merged tree, and the PR run's slots go back to the queue.

What this does not give you is a test of each PR against the PR merged just
before it. GitHub's merge queue does that, by testing the merge group before it
lands; the push run here is what catches a semantic conflict after the fact,
and it does catch it before staging. Enabling the queue is a repository setting
(and for a private repository, a plan question); `ci.yml` would need a
`merge_group` trigger, and the reuse marker would then hit on every merge.

## Runner slots are the budget

The repository's runners are capped. Before this design, a full-stack PR push
started about 33 jobs across CI (19), Security (6), Docker Build (4), PR (3) and
CodeQL (3), and a merge train ran a full CI per commit. Measured on
2026-10-08/09 over 100 PR runs of CI: the median successful run took **43
minutes** from push to green (p90 53) for about five minutes of work. One run's
jobs sat queued for 20 to 29 minutes, and its three-second `CI OK` job waited
nine minutes for a runner.

So the rule is: work that shares a toolchain shares a job, unless splitting it
shortens the critical path. Lint, the release-note checks and gitleaks share the
Python job; tenant isolation rides with UI lint and types. Security scans that
cannot be caused by a change moved to the weekly run.

Splitting does shorten the critical path for the two test suites, and by
2026-10-19 the slots were no longer the constraint: in eleven runs measured
then, no job waited more than three seconds for a runner. So the backend core
suite runs in four shards and the UI suite in six (it had four, and they had
grown to 7 to 11 minutes each); see [The backend lane](#the-backend-lane).

One duplicate remains outside this repository's files: GitHub's **CodeQL
default setup** runs three analysis jobs on every PR push and a five-to-ten
minute analysis on every `develop` push, beside Semgrep, which was adopted to
replace CodeQL. Turning one of them off is a setting
(Settings → Code security), and it is the largest remaining cost per push.

## The backend lane

Measured on 2026-10-19: CI runs took 13 to 15 minutes, and the one `backend`
job was 13 to 14 of them. It ran the core suite (7:30 to 8:00), then aiq_api
(1:20), then `sources/` (3:30), in one job, while every other check was done by
minute three. Job-level queueing was under three seconds in every run looked at,
so the runner cap was not what made the run long; this one job was.

What it was made of, and what was done about each:

- **The core suite is CPU, spread thin.** ~410 worker-seconds on a 4-core
  sandbox, ~900 on a 2-vCPU runner. No test, import or fixture dominates
  (the slowest is 15s; collection is ~12s per worker; coverage on Python 3.14
  uses `sys.monitoring` and costs ~6%; `--dist` modes are within noise). The
  only lever is more CPUs, so it runs as four shards. `pytest-split` assigns
  tests by their recorded time in `tests/.test_durations`
  (`task be:test:durations` refreshes it); a test missing from the file counts
  at the average, so a stale file unbalances the shards and never drops a test.
  Each shard writes coverage data and `backend-coverage` combines it and
  applies the 65% gate, so the gate still sees the whole suite.
- **`sources/` is Qdrant collection setup.** About 130 tests each create and
  drop collections, and each collection was ~47 sequential payload-index
  calls. It runs in its own job beside the shards.
- **Most PRs ran the lane without touching backend code.** The backend filter
  listed `releasenotes/**`, `ci/**` and every workflow because ~10 seconds of
  tests read them, and most PRs carry a release note. Those tests now run in
  Repo checks as `task be:test:harness`, and the filter no longer lists them.
- **Plan's checkout fetched 1.1 GB.** Full history with every blob, ~29s on the
  job every other job waits for. It is now blobless (`filter: blob:none`,
  16 MB); the steps that read a file at the base fetch it on demand, with the
  job token handed to git through that step's env (`ci/git_auth.sh`) rather
  than written to `.git/config`.
- **Repo checks and SAST cloned the whole history**, ~75 s and ~72 s of every
  PR's critical path (`docs/audit/blast-radius-2026-10.md` §7). A pull
  request's Repo checks now start at depth 1 and `ci/fetch_merge_base.sh`
  deepens them only down to the merge base, which the release-note rule and
  gitleaks read; reno's own lint, which walks the whole history, runs only
  when the notes, reno's config or its pin change (`release:lint:house` is the
  rest). A push keeps the full clone. `semgrep ci` finds its merge base itself,
  from the GitHub API (`GH_TOKEN`) or by deepening the shallow clone.

**A pull request runs only the Python tests its change reaches.** Sharding
made the full suite ~5 minutes; a typical change reaches a few dozen tests.
Every push to `develop` records, with pytest-testmon, which test executed which
function, one database per suite, and caches it when every test passed. A pull
request restores it and runs the tests whose recorded functions it changed,
plus every test file that names a changed non-Python file (a config, a prompt,
a schema), which coverage cannot connect to anything. The full sharded suite
and the 65% coverage gate run on every push to `develop`, which the deploy
waits for, so a test a selection missed turns `develop` red before staging,
not production. [`ci/pr_selection.py`](../../ci/pr_selection.py) decides, and
runs the full suite on a pull request whenever testmon cannot see the change:
a conftest, a Python fixture, the lockfile or a `pyproject.toml`, how the
backend jobs run, Python outside the tested packages (tests load `scripts/` and
`deploy/` by path or in a subprocess), package data or a fixture
no test names, or no recorded database. A data fixture under `tests/fixtures/`
adds the tests that name it or one of its directories, as tests read whole
fixture directories. A non-Python file that a helper or conftest reads (a
quoted name) runs the full suite, since nothing says which tests load it. Known blind spot: a test that only exercises
code in a subprocess is selected when its own file changes, not when the code
it spawns does; the push run is what catches that.

**The UI suite selects the same way, by import graph.** `vitest related`
keeps the specs whose imports reach a changed file, split over the same eight
shards. Every spec that reads the tree from disk instead of importing it (the
route, key and migration walkers; ~100 found by what they call, not by a
list) runs on every selection, because no import graph connects them to a
change. Changes to what every spec loads (the manifest, the vitest config and
setup, the mocks the setup installs, tsconfig) run the whole suite. A median
squash commit that touches the UI still selected 815 of 1,644 specs, 86% of
the suite's time, in October 2026: half of them change a dictionary string,
which reaches ~720 specs, and the rest mostly touch a module behind
`lib/api/errors.ts` or the schema barrel. A leaf change reaches a handful.
`task fe:blast-radius` holds each hub to the specs it reached when recorded;
the hubs, and the splits that would cut them, are in
[`docs/audit/blast-radius-2026-10.md`](../audit/blast-radius-2026-10.md). The
coverage comment comes only from a full run.

**What a later push to the same pull request re-runs.** Two references are
sound, and the Plan job takes the one that forces fewer full suites, then the
one with fewer files. One is the whole pull request against its base: a test
that reaches none of its files answers on the merge commit what it answers on
`develop`, whose own full run is the deploy gate. The other is the pull
request's last green run: the tests that ran passed, so the next push owes the
pull request's own diff since that run's head, plus every file the base branch
changed since an hour before that run started (the merge commit CI tests
carries both). The second wins while `develop` stands still. When it moved, the
hour of `develop` it adds (a median 83 files) used to force the full Python
suite on 90 of 113 re-runs, where the pull request's own diff forces it on 27.
The first holds only measured from `develop`'s testmon database, so when it
wins (`reference: base`) the api and sources suites restore that one instead
of their own. The backend keeps its testmon database per pull request for the
same reason, so tests that failed keep running until they pass. A push that
only answers a review comment runs the few tests that comment touched, and one
that touches nothing a UI spec reads runs no UI spec at all.

Not done, and why: a prebuilt container with the toolchain and venv baked in
saves ~28s of setup per backend job and costs 20 to 30s to pull and unpack on
a fresh runner, and it goes stale on every `uv.lock` change.

## What GitHub offers, and what we use

Checked against GitHub's feature set on 2026-10-09.

| Feature | Status | Why |
|---|---|---|
| Concurrency groups | Used | One group per PR and per branch; see above. Groups span workflows, which is how closing a PR cancels its run |
| `workflow_run` chaining | Used | Deploy follows a green CI push run, no polling |
| Job outputs, dynamic matrix | Used | The Plan job's answers; the image matrix is the plan's `build` list |
| Path filtering | Used, in a job | `on.paths` cannot skip a *required* check (it never reports), so the Plan job filters and every job skips through `if:` |
| Job timeouts | Used | Every job has one, a few times its measured run. The default is 360 minutes, and a hung job holds a capped slot for all of them. A test fails on a job without one |
| Annotations | Used | oxlint (`--format=github`), ruff (`--output-format=github`) and vitest (`github-actions` reporter) put findings on the PR's diff |
| Run summaries | Used | Plan's decisions, Semgrep findings, the deploy's URL and image refs |
| Environments, deployments | Used | `staging` and `production`, with the stack's `appUrl` as the deployment URL; production has required reviewers |
| Actions pinned by commit SHA | Used | A tag can be moved after review (tj-actions/changed-files, March 2025). Dependabot bumps the SHA and its version comment, workflows and composite actions both. A test and Semgrep's `github-actions-mutable-action-tag` rule refuse a tag |
| Job-scoped `GITHUB_TOKEN` permissions | Used | Read-only by default; only `image-push` and `publish` can write packages |
| Caching | Used where measured | pre-commit envs, uv, npm, Astro assets, trivy layers. Not `bun install`: 8 seconds cold, so a cache restore would buy nothing |
| Merge queue | **Not used: plan** | Would test each PR on top of the one merged before it. Needs the `merge_group` trigger and, for a private repository, GitHub Enterprise Cloud |
| Artifact attestations | **Not used: plan** | Signed provenance for the images. Private repositories need GitHub Enterprise Cloud |
| OIDC to Pulumi Cloud | **Not used: your setting** | Would replace the stored `PULUMI_ACCESS_TOKEN` with a short-lived token per job. [cd.md](../deployment/cd.md#3-github-environments-settings--environments) has the steps |
| Environment branch policies | **Your setting** | `staging` deploys only from `develop`, `production` only from `prod`, and the token is an environment secret, not a repository one. [cd.md](../deployment/cd.md#3-github-environments-settings--environments) |
| Larger or third-party runners | **Not used: cost** | The cap on runner slots is this design's main constraint. More slots, or faster ones, shorten every run; nothing in the workflows has to change for it |

## Repository settings this design expects

- Required status checks on `develop`: **`CI OK`** and **`Conventional PR
  title`**. Not `Security OK`: that job no longer exists, and a required check
  that never reports blocks every PR.
- The `staging` and `production` environments as in
  [cd.md](../deployment/cd.md).
- Optional: the secret `POSTHOG_CLI_API_KEY` and the variable
  `POSTHOG_PROJECT_ID` (`POSTHOG_CLI_HOST` to override the EU default), for
  source maps and deploy markers
  ([above](#posthog-releases-and-source-maps)).

## Changing CI

The surfaces are the workflows (`.github/workflows/`), the composite actions
(`.github/actions/`), the tier filter (`.github/filters.yml`), the scripts the
workflows run (`ci/`), the hooks (`.pre-commit-config.yaml`) and review routing
(`.github/CODEOWNERS`). Every one of them gates every pull request, so a change
that does not serve one of the jobs in the first table needs a reason.

- Every job has a `timeout-minutes` of a few times its measured run, and every
  action is pinned by commit SHA with a `# vX.Y.Z` comment. Both are tested.
- A new job takes its `if:` from a `changes` output, or it runs on every merge
  including the reused ones. [`tests/test_ci_workflows.py`](../../tests/test_ci_workflows.py)
  evaluates every job's condition and fails on one that does not skip.
- A new job that must pass before images are tagged goes into `publish`'s
  `needs` as well as `CI OK`'s; the same test checks that.
- A push diffs against the last green commit (`steps.green.outputs.sha`), never
  `github.event.before`: the previous push hides a red tier.
- Only `image-push` and `publish` write to GHCR, and only on a push. No pull
  request job gets `packages: write`.
- Image inputs come from the Dockerfiles' `COPY` lines
  ([`ci/image_inputs.py`](../../ci/image_inputs.py)). Do not hand-list paths.
- A finding the change did not cause (a new CVE in an untouched pin) belongs in
  the weekly run, not in a check that blocks every pull request.
- Make CI pass by fixing the cause. Widening the `.gitleaks.toml` allowlist,
  loosening auth gating or code-owner review is a design discussion first.
- A `CODEOWNERS` change goes with the paths it routes, or reviews go to the
  wrong people.

Verify a change before you push it:

```bash
actionlint                                  # go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
.venv/bin/pre-commit run --files <changed>
.venv/bin/pytest tests/test_ci_workflows.py tests/test_reuse_green_run.py \
  tests/test_last_green.py tests/test_image_inputs.py tests/test_pinned_images.py \
  tests/test_plan_summary.py -q
```

`pre-commit` is not the whole gate: the backend suites run in the `backend` job,
not in a hook, so run `task be:verify` when you touch what they cover. Run the
job's own `task` too, and `bash -n` any `run:` block you edited. When a run
fails, read the job's log for the failing line rather than the summary, and
exercise an external call (a registry, an API) against the real service before
saying the fix works. Some paths only run after the merge, on a push; say
plainly which ones your change could not prove.
