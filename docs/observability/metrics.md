# Metrics

Every metric the platform produces goes to **PostHog Metrics**, through the
OpenTelemetry collector
([ADR-0119](../adr/0119-every-metric-goes-to-posthog-through-the-collector.md)).
Open **Metrics** in the PostHog project, pick a name, and filter or group by
the attributes below. Every series carries `deployment.environment.name` (the
Pulumi stack: `dev`, `prod`), so filter on the environment first: staging and
production share the project. Application and scraped series also carry
`service.name`; the kubelet and cluster-state series are named by their
`k8s.*` resource attributes instead.

Read it when you want to know what is measured, where a number comes from, or
how to add one. Logs and errors are in [`error-tracking.md`](error-tracking.md),
LLM traces in [`langfuse.md`](langfuse.md).

## Where the numbers come from

```text
every tier (Python, Node) ── OTLP ──┐
otel-agent, one per node ── OTLP ───┤
   ├ its kubelet: nodes, pods,      │
   │ containers, volumes            ▼
   └ annotated pods on its node   otel-collector ── metrics/posthog ──▶ PostHog Metrics
                                    ├ k8s_cluster: workload state from the API
                                    └ prometheus/qdrant: every Qdrant peer
```

How it is deployed, switched and secured: [`kubernetes.md`](../deployment/kubernetes.md) §9.
Switch: `grid-oib:posthogMetricsEnabled` (default on). Compose runs no
collector, so nothing is exported there and every meter is a no-op.

## The catalogue

### Application

| Metric | Attributes | From |
|---|---|---|
| `grid.queue.depth` | `queue`, `status` | Every claim queue: `ingest` (`common/claim_queue.py`), `research` (`agent_host/jobs/queue.py`) and `bff` (`workers/jobs/queue-metrics.js`). Read from the table by every replica, so chart it with `max` |
| `grid.queue.oldest_age_seconds` | `queue` | The same queues; `max` as well. Absent while nothing is queued |
| `grid.queue.claim_latency_ms` | `queue` | One claim round trip |
| `grid.queue.job_duration_seconds` | `queue`, `kind` | One claimed job, to its end or its give-back |
| `grid.queue.dead_total` | `queue` | Jobs moved to dead |
| `grid.provider.limit` | `scope`, and `model` for a per-model limit | The fleet's adaptive limit of model calls in flight (`common/provider_limiter.py`, ADR-0081) |
| `grid.provider.inflight` | | Model calls holding a slot in this process |
| `grid.provider.wait_seconds` | `class` | Time a call waited for a slot, by priority class |
| `grid.provider.throttled_total` | `scope`, `model` | Calls the provider answered 429 |
| `grid.boot.phase_seconds` | `role`, `phase` | How long a backend role took to become useful, by phase (`observability/boot_timing.py`, ADR-0082) |
| `http.server.request.duration` | `http.request.method`, `http.response.status_code`, `grid.route.class` (`api`, `page`, `static`, `health`) | Every request the BFF gateway answers (`observability/http-metrics.js`) |
| `grid.http.requests_in_flight`, `grid.http.request_seconds` | `role` (`chat`, `api`), `kind` (`request`, `stream`) | Every HTTP request the Python web roles hold (`agent_host/inflight.py`): what the api tier would scale on |
| `nodejs.eventloop.delay.p99` | | Every Node process: the BFF, bff-jobs, the scheduler, the purger |
| `process.memory.usage` | `process.memory.type` (`rss`, `heap_used`) | The same |

### The cluster

| Metric family | What it answers | From |
|---|---|---|
| `k8s.node.*` | CPU, memory, filesystem and network of each node | `kubelet_stats` on each node's agent |
| `k8s.pod.*`, `container.*` | The same per pod and container | `kubelet_stats`. Against limits: pair `container.memory.working_set` with `k8s.container.memory_limit` (`k8s_cluster`), as the workloads alert does; the `*_limit_utilization` metrics are off, and would need `nodes/proxy` |
| `k8s.volume.*` | Free and used bytes and inodes of each mounted volume, PVCs included | `kubelet_stats` |
| `k8s.pod.phase`, `k8s.container.restarts`, `k8s.container.ready` | Is it running, is it crash-looping | `k8s_cluster` on the gateway |
| `k8s.deployment.*`, `k8s.statefulset.*`, `k8s.daemonset.*` | Desired against available replicas | `k8s_cluster` |
| `k8s.hpa.*`, `k8s.job.*`, `k8s.cronjob.*` | Autoscaler targets, job outcomes | `k8s_cluster` |
| `k8s.node.condition_*`, `k8s.node.allocatable_*` | Ready, memory, disk and PID pressure; what the scheduler can place | `k8s_cluster` |

### The services

Scraped by the node agent on the service's node, labelled `job` (the workload's
`app.kubernetes.io/name`), `k8s_namespace_name`, `k8s_pod_name` and
`k8s_container_name`, under the names each service exports.

| Service | Port | What it adds |
|---|---|---|
| Postgres (every CloudNativePG instance) | 9187 | Connections, replication lag, WAL, database and table sizes (`cnpg_*`, `pg_*`) |
| PgBouncer (every pooler) | 9127 | Pools, client and server connections, wait time (`cnpg_pgbouncer_*`) |
| Dragonfly (cache, rate limit, Langfuse queue) | 6379 | Memory, keys, hits and misses, clients, command latency (`dragonfly_*`). Served without the password; the console beside it is not |
| SeaweedFS (each process) | 9327 | Requests and latency by S3 action, volume and filer operations, disk (`SeaweedFS_*`) |
| ClickHouse (Langfuse's trace store) | 9363 | Queries, merges, parts, memory (`ClickHouse*`), on a listener that takes no queries |
| Gotenberg | 3000, `/prometheus/metrics` | Conversions, their durations, LibreOffice restarts |
| KEDA operator | 8080 | Errors and values per ScaledObject (`keda_scaled_object_errors_total`, `keda_scaler_detail_errors_total`, `keda_scaler_metrics_value`): whether a trigger can read its queue |
| Qdrant (every peer) | 6336 | Collections, points, search latency, Raft (`collection_*`, `rest_responses_*`). Scraped by the gateway by peer name, not by annotation, and also re-exposed on `otel-collector:8889` for the alert rules |

Charts that annotate their own pods with `prometheus.io/scrape` (in any
namespace) are scraped the same way, without a change here, provided the
annotated port is one the container declares: the agent keeps only that target,
so a pod with several ports is scraped once.

Scraped names are the exporter's own. Whether the collector's Prometheus
receiver keeps a counter's `_total` and a unit suffix such as `_bytes` depends on
its translation settings, so a query that must not break on an upgrade matches
both spellings, as the alerts do.

## Adding a metric

**In application code**, measure through the OpenTelemetry API. The process
already has a meter provider wherever a collector exists; nothing to install.

- Python: `metrics.get_meter("agent.<module>")`, then
  `create_counter`/`create_histogram`/`create_observable_gauge`. The provider
  is installed when the first workflow is built; an instrument made before that
  forwards once it exists.
- Node: `metrics.getMeter("grid.<module>")`, created after `initOtelMetrics`,
  because the JS API has no proxy meter: an instrument made before the provider
  stays a no-op. `http-metrics.js` creates its histogram on first use for that
  reason.

Name it `grid.<area>.<what>` with a unit, or by the OpenTelemetry semantic
conventions when one exists. **Keep attributes bounded**: every distinct
combination is a series PostHog stores and charts. A route class, a status, a
queue, a model are fine; an organization, a user, a document, a path segment or
a job id are not. That detail belongs in a trace or a log.

**For a service that exports Prometheus metrics**, add
`scrapeAnnotations(port, path)` (`deploy/pulumi/src/platform/scrape.ts`) to its
pod template and declare the port on its container. If `network-policies.ts`
withholds the pod from the namespace (rule 2), add a rule admitting
`otel-agent` to that port alone. `index-scrape-targets.spec.ts` fails if
either is missing.

## Alerts

One alert in PostHog, **Platform health (prod)**, on the insight
[`tqqimEor`](https://eu.posthog.com/project/269895/insights/tqqimEor) on the
[Platform health (prod)](https://eu.posthog.com/project/269895/dashboard/1040252)
dashboard. The insight is a SQL query over `posthog.metrics` that evaluates
one row per rule and folds them into a single row: `rule` lists every rule
that fired, each prefixed by its area and naming what breaks it, and `breach`
counts them. The alert fires when `breach` is above 0, and its notification
carries the `rule` text, so it says which pod, queue or node. One row because
PostHog's scheduled check errored on every run of the multi-row version
([`deploy/posthog/README.md`](../../deploy/posthog/README.md#alerts)). It checks hourly (the free plan's fastest),
production only, emails its subscriber and posts to `#alerts-prod`.

It used to be five alerts, one per area. The plan allows five insight alerts
in total, and support and costs need two of them
([`deploy/posthog/README.md`](../../deploy/posthog/README.md#alerts)), so the
five areas are now rows of one query. The per-area insights below stay on the
dashboard for reading; their SQL is what the merged query wraps, so a
threshold changes in both.

| Area (prefix, per-area insight) | Rules |
|---|---|
| Workloads ([`EHKZOYDv`](https://eu.posthog.com/project/269895/insights/EHKZOYDv)) | A container restarted 3+ times in an hour; a pod Pending or Failed for 15 min; a Deployment, StatefulSet or DaemonSet below its desired count for 15 min; a node not Ready or under memory, disk or PID pressure; a PVC over 85% full; a container above 90% of its memory limit for 15 min |
| Hintergrundjobs ([`cc8ZCJlX`](https://eu.posthog.com/project/269895/insights/cc8ZCJlX)) | A queue's oldest job waiting 30+ min for 15 min; any job moved to dead; any KEDA ScaledObject error (a trigger it cannot read); an HPA pinned at its maximum for 30 min |
| Datenbanken ([`66kuIQ3u`](https://eu.posthog.com/project/269895/insights/66kuIQ3u)) | A Postgres exporter reporting down; a replica 60+ s behind for 15 min; PgBouncer clients waiting for 15 min; a Qdrant peer down for 15 min; the rate-limit or Langfuse Dragonfly over 90% of its memory (the cache evicts by design); the Langfuse queue evicting anything (lost traces) |
| Anwendung ([`Z7X5CRIF`](https://eu.posthog.com/project/269895/insights/Z7X5CRIF)) | The BFF answering 5%+ with 5xx over an hour of 200+ requests; a Node event loop's p99 delay above 0.5 s for 15 min; 30+ provider 429s in an hour |
| Telemetrie ([`CFVybMF0`](https://eu.posthog.com/project/269895/insights/CFVybMF0)) | No metric labelled `prod` from `grid-ui`, `grid-skill-scheduler` or `grid-purger` in 20 min; one of them silent for 20 min after it had sent; cluster state silent for 20 min; a node the cluster lists whose agent is silent |

Telemetrie is the area that reads silence as a failure. The others read a
missing metric as healthy, so without it an exporter that died would look like
a quiet night. Its first rule was added on 2026-10-27: the other heartbeat
rules only notice a service that sent and then stopped, so a production that
never sent anything (metrics export not yet deployed there) looked healthy for
a week. It watches the Node tiers, which report their runtime every 30 s, not
the Python ones, which may export nothing while idle.

A rule that names a metric the cluster never sends returns `breach = 0`
forever, so once production sends metrics, open the insight and look for the
rows, not only the zeros.

## Known gaps

- **The Qdrant PromQL rules.** PostHog does not evaluate PromQL. The data-store
  alert covers a peer being down; the finer rules in `qdrant-alert-rules`
  (`data/qdrant-alerts.ts`) still need a `vmalert` at `otel-collector:8889`, or
  a rewrite as rows of that alert ([`qdrant-runbook.md`](../deployment/qdrant-runbook.md)).
- **Alert cadence.** Hourly is the free plan's fastest check, so an outage can
  run an hour before anyone is mailed. Error-tracking and log alerts are
  separate products and can be faster.
- **Langfuse web and worker** export no Prometheus metrics; their health is the
  container and request numbers above.
- **Retention.** PostHog Metrics is in open alpha and keeps 30 days.
