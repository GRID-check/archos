---
status: proposed
date: 2026-10-20
decision-makers: Grid engineering
consulted: platform owner
informed: everyone working in this repo
---

# Pull request CI runs on runners in the dev cluster, with no Docker and no credentials

## Context and Problem Statement

Every CI job runs on GitHub's `ubuntu-latest`. On 2026-10-20 the account
stopped getting runners at all: every job of every workflow failed one to two
seconds after it was created, with no runner assigned and no log, on
GRID-check/grid-oib-agent#1113 and GRID-check/grid-oib-agent#1112 alike. A pull
request fans out to more than a dozen jobs (four frontend shards, backend,
packages with four minutes of IfcOpenShell, the image builds), so the minutes go
fast, and while they are gone nothing merges.

The hosted image also decides things for us that nobody chose. Its PostgreSQL is
Ubuntu's 16.15 (the runner-images README for 24.04), while production runs
CloudNativePG's 17, and `scripts/rls-test-db.sh` takes whatever server binaries
it finds: the tenant-isolation suite has been proving row-level security on a
major production does not run.

We run a Kubernetes cluster for staging already. The question is whether CI
should run there, and how, given that every CI job runs the code of a pull
request.

## Decision Drivers

* A pull request's code must not reach anything of ours: not staging's data, not
  the cluster API, not a secret.
* Results stay in GitHub: checks, logs, re-runs and required status checks,
  exactly where they are now.
* Turning it off has to be one change, because the day the dev cluster is down is
  a day CI must still run.
* The toolchain CI tests with is production's, and something other than a person
  notices when it drifts.

## Considered Options

* GitHub's runners as they are (do nothing)
* A managed runner provider (Blacksmith, Namespace, Ubicloud)
* Argo Workflows instead of GitHub Actions
* actions-runner-controller in the dev cluster, Docker-in-Docker mode
* actions-runner-controller in the dev cluster, Kubernetes (container hooks) mode
* actions-runner-controller in the dev cluster, plain mode, with every job made
  Docker-free

## Decision Outcome

Chosen option: "actions-runner-controller in the dev cluster, plain mode, with
every job made Docker-free", because it is the only one that keeps GitHub as
the place results live, removes the hosted minutes from pull requests, and needs
neither a privileged pod nor a Kubernetes credential in a pod that runs a pull
request's code.

What that is, concretely:

* **The controller and one runner scale set**, GitHub's own charts
  (`gha-runner-scale-set-controller` and `gha-runner-scale-set`, one pinned
  version), installed by the Pulumi program when `ciRunnersEnabled` is set:
  `deploy/pulumi/src/platform/ci-runners.ts`. The scale set registers with a
  GitHub App, scales from zero to `ciRunnersMaxRunners`, and is what `runs-on`
  names.
* **Plain mode.** No Docker daemon, no container hooks. The runner pod has the
  chart's no-permission service account and no token mounted, drops every
  capability and cannot escalate. Its namespace, `arc-runners`, enforces the
  Baseline Pod Security Standard.
* **A NetworkPolicy** that lets the runners reach the internet and cluster DNS
  and nothing else: no RFC 1918, CGNAT, link-local or loopback address, so not
  Postgres, not SeaweedFS, not Qdrant, not the metadata endpoint. Nothing may
  connect to a runner. The program refuses to plan the runners without
  `networkPolicies`.
* **A runner image of our own**, `deploy/ci-runner/Dockerfile`: GitHub's runner
  image plus production's Postgres server binaries, Node 22 (the setup actions
  install with `npm`), Qdrant 1.19.2, and gitleaks and trivy copied out of the
  same images CI pins. The setup actions still install Python, uv, Bun and
  go-task in every job, so a workflow behaves the same on either runner and its
  pins stay in one place. The scale set runs it by digest only.
* **Jobs without Docker.** Qdrant runs from its binary
  (`scripts/qdrant-test-server.sh`, which works on a laptop too), semgrep from
  PyPI, gitleaks and trivy as binaries, Postgres 17 installed on GitHub's runners
  by `.github/actions/setup-postgres`. Those changes are good on GitHub's runners
  as well, which is what makes the switch reversible.
* **One switch.** A job that may run on the cluster says
  `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. With the repository
  variable unset, every job stays on GitHub; set to the scale set's name
  (`grid-ci`), they move.
* **What stays on GitHub's runners:** every job that holds a secret or writes
  the registry (`image-push`, `publish`, `deploy.yml`, the runner image's own
  publish), everything on `pull_request_target`, and the image builds (below).

### Consequences

* Good, because a pull request's jobs stop spending hosted minutes, and an
  outage of those minutes no longer stops merges.
* Good, because the RLS and claim-queue suites now run on production's Postgres
  major on every runner, and `tests/test_ci_toolchain_pins.py` fails when CI's
  Qdrant, Postgres, trivy, gitleaks or Node moves away from production's or from
  each other.
* Good, because results, logs and required checks stay in GitHub, unchanged.
* Good, because developers get the same Qdrant command CI uses, with no Docker.
* Bad, because the dev cluster now carries CI's load: up to `maxRunners` pods of
  2 CPU / 4 GiB requested each. Without `ciRunnersNodeGroup` they share nodes
  with staging, and an IPAX worker group cannot be tainted, so the CI group stays
  CI's only because every other workload names its own.
* Bad, because a runner can still reach the internet. A pull request can still
  exfiltrate what it can read, which is its own checkout and its own read token,
  the same as on GitHub's runners. Egress to GitHub only is not possible with a
  plain NetworkPolicy, since npm, PyPI and the registries sit behind CDNs.
* Bad, because Docker Hub rate-limits by IP, and every runner shares the cluster's
  egress addresses. A pull-through mirror is the remedy when pulls start failing.
* Bad, because the image builds stay on GitHub's runners (below), so not every
  hosted minute goes away.
* Bad, because we now own an image and a controller upgrade: the runner image
  when GitHub's runner moves (old runner versions stop being accepted), and the
  ARC charts.

### Confirmation

* `deploy/pulumi/src/platform/ci-runners.spec.ts`: plain mode, no service-account
  token, no privilege, the egress rule, the deny-all ingress, Baseline namespaces,
  a digest-pinned image, both charts at one version, and the config refusing to
  plan without NetworkPolicies, the GitHub App or a digest.
* `tests/test_ci_workflows.py`, arriving with the workflow change itself (the
  workflow files are changed in a commit of their own, reviewed separately): a
  job on `CI_RUNNER` uses exactly the fallback
  expression, reads no secret, cannot write the registry, is not on
  `pull_request_target`, and asks for no service container, container job,
  `docker run` or image build.
* `tests/test_ci_toolchain_pins.py`: the versions above.

## Pros and Cons of the Options

### GitHub's runners as they are

* Good, because nothing to run.
* Bad, because the outage that prompted this happens again whenever the minutes
  do, and the Postgres drift stays.

### A managed runner provider

A `runs-on` swap to a provider that runs the same images faster and cheaper.

* Good, because it is the least work and nothing to operate.
* Bad, because it is still minutes on a bill, and the toolchain is still the
  provider's image.
* Neutral: still the right fallback if operating the controller turns out to cost
  more than it saves. The `CI_RUNNER` switch takes a provider's label as easily
  as ours.

### Argo Workflows

* Bad, because it is a workflow engine, not a CI system: GitHub would show a
  status, and logs, re-runs and the job graph would live in Argo's UI. That fails
  the one driver everyone named.
* Bad, because every workflow, path filter, cache and required check would be
  rewritten as templates, with no gain the runner swap does not already give.
* Argo CD, the deploy tool, is a different question: it would compete with Pulumi,
  not with Actions.

### ARC, Docker-in-Docker mode

* Good, because every job runs unchanged.
* Bad, because the Docker daemon is a privileged container in a pod running a
  pull request's code, on the cluster that runs staging.

### ARC, Kubernetes mode

* Good, because `services:` and `container:` keep working, each in a pod of its
  own.
* Bad, because the runner needs a service account that can create pods in its
  namespace, and the container hooks need a volume per job.
* Bad, because a job's services land in a separate pod from its steps unless the
  job has a container of its own, so `localhost:6333` stops reaching Qdrant
  (runner-container-hooks `prepare-job.ts`).

## More Information

**Rolling it out.**

1. Merge with `ciRunnersEnabled` off. Nothing changes.
2. The runner image workflow publishes `grid-ci-runner` on develop. Set its
   digest as `grid-oib:ciRunnersImage` in `Pulumi.dev.yaml`.
3. Create a GitHub App on the organisation, installed on this repository, with
   Actions and Administration read/write. Set `ciRunnersGithubAppId`,
   `ciRunnersGithubAppInstallationId` and, with `--secret`,
   `ciRunnersGithubAppPrivateKey`. Optionally create a CI worker group in IPAX
   and set `ciRunnersNodeGroup`.
4. Set `ciRunnersEnabled: true` and deploy dev. The scale set appears under
   Settings → Actions → Runners.
5. Set the repository variable `CI_RUNNER=grid-ci`. Unset it to move back.

**Image builds, not moved yet.** A runner without a Docker daemon builds through
a BuildKit service. Rootless BuildKit was drafted for this: its own namespace,
mutual TLS from cert-manager, reachable from the runners alone. It is not in this
change because every BuildKit release scanned on 2026-10-20 fails the trivy gate
on fixable HIGH findings: v0.33.1 (golang.org/x/net among others) and v0.34.0
(Alpine's expat, and the Go standard library compiled into its binaries). The
house rule (`.trivyignore.yaml`) is to bump past a finding before boxing it, and
there is no newer release to bump to. The options: box the findings with an
expiry and a written reason each, or build BuildKit ourselves on a current Go
from `deploy/`. Both are a call for whoever owns the trivy policy. Rootless
BuildKit also needs seccomp and AppArmor unconfined, so its namespace would be
the one labelled privileged.

**The OIB corpus gate, not restored.** ADR-0058's structure gate left CI because
no checkout can hold the licensed Richtlinien. A runner here could fetch them,
but not from our SeaweedFS: the NetworkPolicy keeps runners off every in-cluster
address, and opening that path would put a pull request's code next to
staging's data. The way that keeps the boundary is to fetch each PDF from its
publisher, checked against a recorded sha256, which also works on GitHub's
runners. That needs the platform owner to confirm automated download is within
the licence, and someone to record the URLs, which oib.or.at does not expose as
direct links. Until then the gate stays an opt-in local tool, as ADR-0058 says.
