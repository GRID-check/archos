import * as k8s from "@pulumi/kubernetes";
import { onNodeGroup } from "./scheduling";
import * as pulumi from "@pulumi/pulumi";
import { DeployConfig } from '../config'
import { commonLabels } from "./namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  secretChecksum,
  secretChecksumAnnotations,
  surgeRollout,
} from "./rollout";
import {
  LANGFUSE_SECRET_KEYS,
  langfuseOtlpBasicAuth,
  langfuseOtlpTracesEndpoint,
} from "./langfuse";
import { CLUSTER_STATE_RULES, installCollectorIdentity } from "./collector-identity";
import {
  CollectorFragment,
  HEALTH_PORT,
  OTLP_GRPC_PORT,
  OTLP_HTTP_PORT,
  OTLP_RECEIVER,
  boundedDelivery,
  composeCollectorConfig,
  renderCollectorConfig,
} from "./collector-config";

const COMPONENT = "otel-collector";
/**
 * The `prometheus` exporter's listener: every Qdrant series the collector
 * scrapes, re-exposed in the Prometheus text format for the alert rules in
 * `data/qdrant-alerts.ts`; see {@link qdrantScrape}.
 */
export const METRICS_EXPORT_PORT = 8889;
/** How often each Qdrant peer is scraped. Alert rules assume at least two scrapes in their shortest `for`. */
const QDRANT_SCRAPE_INTERVAL = "30s";
/** How often workload state is read from the API; PostHog charts at minute resolution. */
const CLUSTER_STATE_INTERVAL = "30s";

export interface OtelCollector {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  configMap: k8s.core.v1.ConfigMap;
}

export interface OtelCollectorSources {
  /**
   * The Secret carrying Langfuse's precomputed Basic-auth header (ADR-0044),
   * when that tier is deployed. It, not `cfg.langfuse.enabled`, decides the
   * Langfuse exporter: `index.ts` builds the tier under a wider guard than the
   * flag, and an exporter whose `${env:…}` nothing injects stops the collector
   * from starting, taking every export down with it.
   */
  langfuseSecretName?: pulumi.Input<string>;
  /** Every Qdrant peer's metrics listener (`host:port`), when Qdrant is deployed. */
  qdrantMetricsTargets?: pulumi.Input<string[]>;
}

/**
 * Deploys the OpenTelemetry Collector as the cluster's single OTLP ingestion
 * point (ADR-0029 amendment).
 *
 * All telemetry producers (Next.js BFF, aiq-agent, agent-worker) send plain
 * OTLP in-cluster to this Service — no API key on the producers. The collector
 * is the ONLY holder of the credentials its consumers need (Langfuse's ingestion
 * key; PostHog's public project token sits in the ConfigMap). It batches and
 * applies memory back-pressure. What it forwards, and where, is one fragment
 * per consumer below, composed by `collector-config.ts`. Swapping or adding a
 * backend later is a fragment HERE, not a change in any app.
 *
 * With PostHog metrics on it is also the one place the cluster's metrics leave
 * from: the per-node agents (`otel-agent.ts`) send it their nodes' kubelet
 * stats and scrapes over OTLP, and it reads workload state from the API
 * itself (`k8s_cluster`). One replica on purpose: a second would report every
 * workload twice.
 *
 * NetworkPolicy: same-namespace ingress is already allowed and egress is open
 * by design (see network-policies.ts); the scrape of Qdrant's metrics port is
 * the one connection out of it that needs a rule of its own (rule 18).
 */
export function installOtelCollector(
  cfg: DeployConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
  sources: OtelCollectorSources = {},
): OtelCollector {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;
  const { langfuseSecretName, qdrantMetricsTargets } = sources;

  const metrics = cfg.posthog.metricsEnabled;
  const configFor = (qdrant: string[] | undefined): string =>
    renderCollectorConfig(
      composeCollectorConfig([
        ...(langfuseSecretName ? [langfuseTraces()] : []),
        ...(cfg.posthog.logsEnabled ? [posthogLogs(cfg.posthog.host, cfg.posthog.projectToken)] : []),
        ...(qdrant ? [qdrantScrape(qdrant)] : []),
        ...(metrics
          ? [
              clusterState(),
              posthogMetrics(cfg.posthog.host, cfg.posthog.projectToken, pulumi.getStack(), [
                OTLP_RECEIVER,
                CLUSTER_STATE_RECEIVER,
                ...(qdrant ? [QDRANT_RECEIVER] : []),
              ]),
            ]
          : []),
      ]),
    );
  // Read access to the API only when cluster state is collected; otherwise the
  // pod gets no token at all.
  const identity = metrics ? installCollectorIdentity(COMPONENT, CLUSTER_STATE_RULES, provider, namespace) : undefined;
  const config: pulumi.Input<string> = qdrantMetricsTargets
    ? pulumi.output(qdrantMetricsTargets).apply((targets) => configFor(targets))
    : configFor(undefined);

  const configMap = new k8s.core.v1.ConfigMap(
    COMPONENT,
    {
      metadata: { name: `${COMPONENT}-config`, namespace, labels },
      data: { "collector.yaml": config },
    },
    { provider, dependsOn },
  );

  const deployment = new k8s.apps.v1.Deployment(
    COMPONENT,
    {
      metadata: { name, namespace, labels },
      spec: {
        replicas: 1,
        // Stateless OTLP forwarder — surge so producers always have a collector
        // Service endpoint to export to, even mid-roll.
        ...surgeRollout(ROLLOUT.observability),
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // The pod's credential arrives by `secretKeyRef`, which is read ONCE
            // at container start (rollout.ts §5). Without this the collector
            // keeps presenting a retired key after a rotation while `pulumi up`
            // reports success — and the symptom is the quietest one in the
            // tier: the exporter 401s and telemetry simply stops.
            //
            // The config is in the digest for the same reason: the collector
            // reads its file once, at start, and the ConfigMap keeps its name,
            // so a new pipeline (Qdrant turned on, a PostHog token changed)
            // would otherwise wait for the next unrelated restart.
            annotations: secretChecksumAnnotations(
              secretChecksum({
                ...(cfg.langfuse.enabled ? { "langfuse-otlp-auth": langfuseOtlpBasicAuth(cfg) } : {}),
                "collector.yaml": config,
              }),
            ),
          },
          spec: {
            enableServiceLinks: false,
            ...(identity
              ? { serviceAccountName: identity.serviceAccount.metadata.name, automountServiceAccountToken: true }
              : { automountServiceAccountToken: false }),
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
            ...onNodeGroup(cfg.nodeGroups.app),
            containers: [
              {
                name: "collector",
                image: cfg.observability.collectorImage,
                imagePullPolicy: "IfNotPresent",
                args: ["--config=/etc/otelcol/collector.yaml"],
                ports: [
                  { containerPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
                  { containerPort: OTLP_HTTP_PORT, name: "otlp-http" },
                  { containerPort: HEALTH_PORT, name: "health" },
                  ...(qdrantMetricsTargets ? [{ containerPort: METRICS_EXPORT_PORT, name: "metrics" }] : []),
                ],
                // Present only when Langfuse is deployed: the env var and the
                // exporter that reads it are one decision (see sources).
                env: langfuseSecretName
                  ? [
                      {
                        name: "LANGFUSE_OTLP_AUTH",
                        valueFrom: {
                          secretKeyRef: { name: langfuseSecretName, key: LANGFUSE_SECRET_KEYS.otlpBasicAuth },
                        },
                      },
                    ]
                  : [],
                volumeMounts: [
                  { name: "config", mountPath: "/etc/otelcol", readOnly: true },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                readinessProbe: {
                  httpGet: { path: "/", port: HEALTH_PORT },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: HEALTH_PORT },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
            volumes: [
              { name: "config", configMap: { name: configMap.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, configMap, ...(identity ? [identity.binding] : [])] },
  );

  const service = new k8s.core.v1.Service(
    COMPONENT,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
          { port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT, name: "otlp-http" },
          ...(qdrantMetricsTargets
            ? [{ port: METRICS_EXPORT_PORT, targetPort: METRICS_EXPORT_PORT, name: "metrics" }]
            : []),
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { deployment, service, configMap };
}

/**
 * Traces to Langfuse (ADR-0044), the one consumer of the traces signal.
 *
 * `otlp_http`, NOT `otlphttp`: both resolve today, and upstream made
 * `otlphttp` the DeprecatedType. `traces_endpoint`, not `endpoint`: the latter
 * would have the exporter append `/v1/traces` to a path that already ends in it.
 */
export function langfuseTraces(): CollectorFragment {
  return {
    exporters: {
      "otlp_http/langfuse": {
        traces_endpoint: langfuseOtlpTracesEndpoint(),
        headers: {
          // Basic base64(pk:sk), precomputed into the Langfuse Secret because
          // the collector cannot base64 two env vars together.
          Authorization: "${env:LANGFUSE_OTLP_AUTH}",
          // Langfuse v4 writes spans that carry this straight to its events
          // table; without it they wait for the ~15-minute propagation.
          "x-langfuse-ingestion-version": "4",
        },
        // Spans carry prompts and completions, which compress roughly an order
        // of magnitude; Langfuse accepts gzip.
        compression: "gzip",
        // Keeps a Langfuse restart (a deploy, a node drain) from becoming
        // dropped spans, within a bound.
        ...boundedDelivery(2000),
      },
    },
    pipelines: { traces: { receivers: [OTLP_RECEIVER], exporters: ["otlp_http/langfuse"] } },
  };
}

/**
 * WARN-and-above logs to PostHog Logs, and the logs signal only: LLM traces
 * reach PostHog through Langfuse's own integration.
 *
 * Its own pipeline because the severity filter is per pipeline, and a second
 * log consumer must not inherit it. WARN rather than ERROR because PostHog is
 * the searchable log store, not an alert sink; INFO and DEBUG are what would
 * burn the free tier. A record with no severity (0) is dropped too, which is
 * the safe side. The project token is PostHog's public `phc_` key (it ships in
 * the browser bundle), so it is plain config, and a changed token changes the
 * ConfigMap, whose digest restarts the collector.
 */
export function posthogLogs(host: string, projectToken: string): CollectorFragment {
  return {
    processors: {
      "filter/warn_and_above": {
        error_mode: "ignore",
        log_conditions: ["log.severity_number < SEVERITY_NUMBER_WARN"],
      },
    },
    exporters: {
      "otlp_http/posthog": {
        // The whole URL: PostHog serves logs at /i/v1/logs, whatever the
        // exporter would append.
        logs_endpoint: `${host.replace(/\/+$/, "")}/i/v1/logs`,
        headers: { Authorization: `Bearer ${projectToken}` },
        compression: "gzip",
        ...boundedDelivery(1000),
      },
    },
    pipelines: {
      "logs/posthog": {
        receivers: [OTLP_RECEIVER],
        processors: ["filter/warn_and_above"],
        exporters: ["otlp_http/posthog"],
      },
    },
  };
}

const QDRANT_RECEIVER = "prometheus/qdrant";
const CLUSTER_STATE_RECEIVER = "k8s_cluster";

/**
 * Scrape every Qdrant peer, and re-expose the series on
 * `otel-collector:8889/metrics` for the alert rules in `data/qdrant-alerts.ts`.
 *
 * Per peer, by its headless name: `/metrics` reports only the peer that
 * answers. The metrics port needs no key (`PORT.qdrantMetrics`), so the
 * collector holds no Qdrant credential. `up{job="qdrant"}` is the receiver's
 * own series and is what a dead peer looks like.
 */
export function qdrantScrape(targets: string[]): CollectorFragment {
  return {
    receivers: {
      [QDRANT_RECEIVER]: {
        config: {
          scrape_configs: [
            {
              job_name: "qdrant",
              scrape_interval: QDRANT_SCRAPE_INTERVAL,
              scrape_timeout: "10s",
              metrics_path: "/metrics",
              static_configs: targets.map((target) => ({
                targets: [target],
                labels: { peer: target.split(".")[0] },
              })),
            },
          ],
        },
      },
    },
    exporters: {
      prometheus: {
        endpoint: `0.0.0.0:${METRICS_EXPORT_PORT}`,
        // A peer that stops answering stops refreshing its series; they leave
        // the export after this, while `up` keeps reporting the peer as down.
        metric_expiration: "5m",
      },
    },
    pipelines: { "metrics/qdrant": { receivers: [QDRANT_RECEIVER], exporters: ["prometheus"] } },
  };
}

/**
 * Workload state from the Kubernetes API: pod phases and restarts, deployment,
 * statefulset and daemonset availability, HPA targets, job outcomes, node
 * conditions and allocatable resources. What a pod is DOING is the agents'
 * (`otel-agent.ts`); this is what the cluster says it should be.
 */
export function clusterState(): CollectorFragment {
  return {
    receivers: {
      [CLUSTER_STATE_RECEIVER]: {
        auth_type: "serviceAccount",
        collection_interval: CLUSTER_STATE_INTERVAL,
        node_conditions_to_report: ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"],
        allocatable_types_to_report: ["cpu", "memory", "ephemeral-storage", "pods"],
      },
    },
  };
}

/**
 * Every metric the collector receives or reads, to PostHog Metrics: the
 * application meters (OTLP from every tier), the agents' node and pod readings
 * (OTLP), workload state and the Qdrant scrape.
 *
 * Its own exporter beside the logs one: one exporter per PostHog signal keeps
 * each signal's switch and queue its own. The project token is the same
 * public `phc_` key as the logs'. `deployment.environment.name` is the stack,
 * so dev and prod stay apart in one PostHog project; `insert` leaves a value a
 * producer set itself.
 */
export function posthogMetrics(
  host: string,
  projectToken: string,
  environment: string,
  receivers: string[],
): CollectorFragment {
  return {
    processors: {
      "resource/environment": {
        attributes: [{ key: "deployment.environment.name", value: environment, action: "insert" }],
      },
    },
    exporters: {
      "otlp_http/posthog_metrics": {
        metrics_endpoint: `${host.replace(/\/+$/, "")}/i/v1/metrics`,
        headers: { Authorization: `Bearer ${projectToken}` },
        compression: "gzip",
        ...boundedDelivery(1000),
      },
    },
    pipelines: {
      "metrics/posthog": {
        receivers,
        processors: ["resource/environment"],
        exporters: ["otlp_http/posthog_metrics"],
      },
    },
  };
}
