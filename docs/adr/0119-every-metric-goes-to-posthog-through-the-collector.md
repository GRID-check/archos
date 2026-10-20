---
status: accepted
date: 2026-10-20
decision-makers: Platform
consulted:
informed: everyone who ships to this repo
---

# Every metric goes to PostHog, through the collector, from an agent on every node

## Context and Problem Statement

Nothing in the stack stored a metric. The Python tiers define the
`grid.queue.*`, `grid.provider.*` and `grid.boot.*` instruments, but no process
installed a meter provider, so every reading went to a no-op; the Aspire
dashboard that once received them was retired (ADR-0029, ADR-0100). The
collector scraped Qdrant and re-exposed the series on a port nothing read. The
Node tiers measured nothing. Of the cluster itself (what each node, pod and
container uses, which workloads are available, which pods restart) nothing was
collected at all. Queue depth was readable only from Postgres, and a stalled
BFF, a node short of memory or a crash-looping worker showed up first as a
user's complaint.

PostHog, which already holds our product events, errors, logs and replays
(ADR-0100), now takes OTLP metrics at `/i/v1/metrics` with the same public
project token.

## Decision Drivers

* All of it, in one place: application meters, the cluster, and the services
  inside it, joinable with the logs and events PostHog already holds.
* No new stateful service to run, and no backend credential on any producer
  or any node (ADR-0029: the collector is the only holder).
* Each pod scraped once, however many nodes the cluster grows to.
* Every collector config the program can render is checked by the collector
  itself before it reaches a cluster.

## Considered Options

* Through the collector: OTLP from the tiers, an agent collector per node for
  the kubelet and the annotated pods, the gateway collector for workload state
  and the export to PostHog.
* A Prometheus server first, scraping everything, remote-writing or federating
  to PostHog.
* PostHog's own metrics agent (its Docker image or Helm chart) scraping the
  Prometheus endpoints.
* One collector for everything: the gateway scrapes every kubelet and every pod
  cluster-wide.

## Decision Outcome

Chosen option: "Through the collector", because it is the one ingestion point
the stack already runs and secures, the agent and gateway split is the
topology the OpenTelemetry Helm charts ship, and it needs nothing a cluster
does not already have.

* **Application meters.** Each Python process installs one meter provider, once
  per process and never stopped with a workflow (`otlp_metrics.py`); each Node
  process installs one at start (`otel-metrics.js`), with event loop delay and
  memory, and the gateway in `server.js` records
  `http.server.request.duration`. Where a signal goes and what names its
  sender is one module per runtime (`otlp_resource.py`, `otlp.js`); the
  resource names the pod and process, so replicas' cumulative series stay
  apart.
* **The node agent** (`otel-agent`, a DaemonSet on every node) reads its own
  kubelet (`kubeletstats`) and scrapes the pods on its own node annotated
  `prometheus.io/scrape: "true"` (`prometheus/pods`, discovery filtered to
  `spec.nodeName`). It sends OTLP to the gateway and holds no credential.
* **The services opt in** with three pod annotations (`scrape.ts`):
  Postgres and its PgBouncer poolers (CloudNativePG's exporters), the three
  Dragonflies, every SeaweedFS process (`-metricsPort`), ClickHouse (a
  `config.d` listener that takes no queries), Gotenberg and the KEDA operator.
  Qdrant keeps the gateway's scrape by peer name, so it is not annotated.
  Where rule 2 of `network-policies.ts` withholds a pod, a rule admits
  `otel-agent` to its metrics port alone.
* **The gateway** (`otel-collector`, one replica) reads workload state from the
  API (`k8s_cluster`), keeps its Qdrant scrape, stamps
  `deployment.environment.name` with the stack, and exports every metric on
  `metrics/posthog`.
* Both read the API as their own ServiceAccount, bound to a ClusterRole of
  get/list/watch rules only.
* `grid-oib:posthogMetricsEnabled` (default on, the same dependencies as the
  logs) switches the export and the agents together.
* The collector config is composed from one typed fragment per consumer or
  source (`collector-config.ts`), which holds the invariants once.

### Consequences

* Good, because the meters that existed and recorded nowhere now report, and
  the cluster is visible for the first time, in the product we already read.
* Good, because a workload opts into the scrape with three annotations; no
  scrape config changes for a new service.
* Good, because the agents and the tiers carry no token, and the gateway's
  bounded queue keeps a PostHog outage out of the rest of the collector.
* Bad, because PostHog Metrics is in open alpha: the endpoint may move, and
  data is kept 30 days. Moving it is one fragment in the gateway; longer
  history is not available until general availability.
* Bad, because PostHog does not evaluate PromQL, so the Qdrant alert rules
  (`data/qdrant-alerts.ts`) still need a `vmalert` at `otel-collector:8889`, or
  a rewrite as PostHog alerts. Qdrant alerting stays inactive until one exists.
* Bad, because the gateway now mounts an API token when metrics are on, and
  each node runs one more pod (50m CPU, 64 MiB requested).
* Bad, because the first deploy restarts the stores whose command or config
  gained a metrics listener: SeaweedFS (on `single`, prod's only storage
  server, a brief S3 outage), ClickHouse, the Dragonflies, Gotenberg and
  the PgBouncer poolers. The Postgres instances get their annotations from the
  operator, which may patch them in place or roll them one switchover at a
  time; watch the first deploy.
* Bad, because the agents read kubelets with `insecure_skip_verify`: a
  kubelet's serving certificate is self-signed and names no IP. The token
  still authenticates the request; the agent cannot authenticate the kubelet.
* Neutral, because a workload whose metrics port sits behind a NetworkPolicy
  that withholds it from the namespace (rule 2 in `network-policies.ts`) needs
  a rule admitting `otel-agent` before its annotations do anything.

### Confirmation

* `collector-validate.spec.ts` runs every collector config the program renders
  (gateway and agent, for each representative stack) through the pinned
  `otelcol-contrib validate`; CI's infra job installs the binary by checksum.
* `collector-config.spec.ts` holds the composition invariants;
  `posthog-metrics.spec.ts` and `otel-agent.spec.ts` the pipelines, the
  identities and the node filter; `index-node-groups.spec.ts` that the agent
  runs on every node.
* `index-scrape-targets.spec.ts` holds that every annotated pod declares the
  port it asks to be scraped on, that every withheld one admits the agent to
  it, and which workloads are scraped.
* The CrossGuard pack's workload rules (shutdown budget, bounded resources,
  pull policy, probes) cover DaemonSets as well as Deployments and
  StatefulSets.
* `test_otlp_logging_method.py` holds that a Python process installs its meter
  provider once and never stops it with a workflow.

## Pros and Cons of the Options

### A Prometheus server first

* Good, because PromQL and the Qdrant alert rules would run as written.
* Bad, because it is a stateful service with storage to size and keep, whose
  only consumer would be PostHog, which stores the series anyway.
* Bad, because the application meters are OTLP, and a Prometheus in front
  turns them into a scrape of every process.

### PostHog's metrics agent

* Good, because PostHog maintains it.
* Bad, because it is a second collector beside the one we run, holding the
  token on every node, and it scrapes Prometheus endpoints only: kubelet
  stats, workload state and OTLP would still need ours.

### One collector for everything

* Good, because it is one Deployment.
* Bad, because one pod scrapes the whole cluster, so its memory and its scrape
  load grow with the node count, and reaching every kubelet from one node
  needs the API server's node proxy or a receiver creator over node discovery.
  Per node, each agent's load is its node's.
