# Metrics

Every metric the platform produces goes to **PostHog Metrics**, through the
OpenTelemetry collector
([ADR-0119](../adr/0119-every-metric-goes-to-posthog-through-the-collector.md)).
Open **Metrics** in the PostHog project, pick a name, and filter or group by
the attributes below. Every series carries `service.name` and
`deployment.environment.name` (the Pulumi stack: `dev`, `prod`), so filter on
the environment first: staging and production share the project.

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
| `grid.queue.depth` | `queue`, `status` | Every claim queue: `ingest` (Python, `common/claim_queue.py`) and `bff` (`workers/jobs/queue-metrics.js`). Read from the table by every replica, so chart it with `max` |
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
| `nodejs.eventloop.delay.p99` | | Every Node process: the BFF, bff-jobs, the scheduler, the purger |
| `process.memory.usage` | `process.memory.type` (`rss`, `heap_used`) | The same |

### The cluster

| Metric family | What it answers | From |
|---|---|---|
| `k8s.node.*` | CPU, memory, filesystem and network of each node | `kubeletstats` on each node's agent |
| `k8s.pod.*`, `container.*` | The same per pod and container, with its limits and requests (`*.limit_utilization`) | `kubeletstats` |
| `k8s.volume.*` | Free and used bytes and inodes of each mounted volume, PVCs included | `kubeletstats` |
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
| KEDA operator | 8080 | Scaler errors and values per ScaledObject (`keda_scaler_errors_total`, `keda_scaler_metrics_value`): whether a trigger can read its queue |
| Qdrant (every peer) | 6336 | Collections, points, search latency, Raft (`collection_*`, `rest_responses_*`). Scraped by the gateway by peer name, not by annotation, and also re-exposed on `otel-collector:8889` for the alert rules |

Charts that annotate their own pods with `prometheus.io/scrape` (in any
namespace) are scraped the same way, without a change here.

## Adding a metric

**In application code**, measure through the OpenTelemetry API. The process
already has a meter provider wherever a collector exists; nothing to install.

- Python: `metrics.get_meter("aiq_agent.<module>")`, then
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

## Known gaps

- **Alerting.** PostHog evaluates its own alerts on insights, not PromQL. The
  Qdrant rules (`qdrant-alert-rules`) still need a `vmalert` at
  `otel-collector:8889`, or a rewrite as PostHog alerts
  ([`qdrant-runbook.md`](../deployment/qdrant-runbook.md)).
- **Langfuse web and worker** export no Prometheus metrics; their health is the
  container and request numbers above.
- **Retention.** PostHog Metrics is in open alpha and keeps 30 days.
