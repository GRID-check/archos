import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  secretChecksum,
  secretChecksumAnnotations,
  surgeRollout,
} from "./rollout";
import { ERR2ISSUE_OTLP_HTTP } from "./err2issue";
import {
  LANGFUSE_SECRET_KEYS,
  langfuseOtlpBasicAuth,
  langfuseOtlpTracesEndpoint,
} from "./langfuse";

const COMPONENT = "otel-collector";
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const HEALTH_PORT = 13133;

export interface OtelCollector {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  configMap: k8s.core.v1.ConfigMap;
}

/**
 * Deploys the OpenTelemetry Collector as the cluster's single OTLP ingestion
 * point (ADR-0029 amendment).
 *
 * All telemetry producers (Next.js BFF, aiq-agent, agent-worker) send plain
 * OTLP in-cluster to this Service — no API key on the producers. The collector
 * is the ONLY holder of the credentials its consumers need (Langfuse's ingestion
 * key; PostHog's public project token sits in the ConfigMap). It batches and
 * applies memory back-pressure. It carries a traces pipeline (to Langfuse) and
 * logs pipelines (to PostHog and err2issue); there is no metrics pipeline,
 * because nothing consumes metrics (the Aspire dashboard was the only consumer
 * and has been retired). Swapping or adding a backend later is a config change
 * HERE, not in any app.
 *
 * NetworkPolicy: none needed — same-namespace ingress is already allowed and
 * egress is open by design (see network-policies.ts).
 */
export function installOtelCollector(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
  /**
   * The Secret carrying Langfuse's precomputed Basic-auth header (ADR-0044),
   * when that tier is deployed. Undefined leaves the collector config
   * byte-identical to what it was before Langfuse existed.
   */
  langfuseSecretName?: pulumi.Input<string>,
): OtelCollector {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;

  // err2issue (ADR-0031) is a consumer of the logs signal that gets only what
  // is worth waking someone for. Every fragment below is empty when the sink
  // is off, so enabling the sink is the only thing that changes the config.
  //
  // The filter drops everything below ERROR *before* the exporter rather than
  // letting err2issue discard it on arrival: the sink only ever acts on ERROR,
  // so forwarding INFO/DEBUG would be pure waste of collector egress, sink CPU
  // and pod memory at exactly the moment a service is noisiest.
  const err2issueExporter = cfg.err2issue.enabled
    ? `
  otlp_http/err2issue:
    endpoint: ${ERR2ISSUE_OTLP_HTTP}
    compression: none`
    : "";
  const err2issueProcessor = cfg.err2issue.enabled
    ? `
  filter/errors_only:
    # A malformed record must not take the pipeline down — the other logs
    # pipelines are on the other side of the same receiver.
    error_mode: ignore
    # \`log_conditions\` (with the \`log.\` prefix), NOT the older
    # \`logs: log_record:\` nesting: the latter is deprecated as of
    # collector-contrib 0.146 and slated for removal, and this stack pins
    # 0.157. Conditions DROP what they match, so this keeps ERROR and above.
    log_conditions:
      - 'log.severity_number < SEVERITY_NUMBER_ERROR'`
    : "";
  // Its own pipeline: the severity filter is per-pipeline, so sharing one with
  // another consumer would silently strip that consumer's logs too.
  const err2issuePipeline = cfg.err2issue.enabled
    ? `
    logs/err2issue:
      receivers: [otlp]
      processors: [memory_limiter, filter/errors_only, batch]
      exporters: [otlp_http/err2issue]`
    : "";

  // Langfuse (ADR-0044) is the consumer of the traces signal, which is the
  // change ADR-0029 predicted when it wrote that swapping or adding a storage
  // backend "is a config change HERE, not in any app".
  //
  // It has the traces pipeline to itself. Its exporter gets an explicit,
  // bounded queue below instead of the default: exporters on one pipeline share
  // a fate for back-pressure, so an unbounded queue behind a slow Langfuse would
  // grow collector RSS until `memory_limiter` starts refusing the pipeline's
  // traffic. Neither consumer is in a request path, so dropped telemetry is the
  // accepted failure.
  // Keyed off `langfuseSecretName`, NOT `cfg.langfuse.enabled` — the two are
  // not the same condition, and the difference is a total telemetry outage.
  //
  // `index.ts` builds the Langfuse tier under a WIDER guard than the flag:
  // `cfg.langfuse.enabled && clickhouse && langfuseQueue && postgres.langfuseDsn`.
  // Those extra three are in lockstep with the flag today, but that is an
  // invariant maintained by hand across two files. Break it and this function
  // writes `${env:LANGFUSE_OTLP_AUTH}` into the ConfigMap while nothing injects
  // the variable — and the collector REFUSES TO START on an unresolvable env
  // reference, taking every export down with it. The parameter is already the single source of truth here; use it.
  const langfuseExporter = langfuseSecretName
    ? `
  otlp_http/langfuse:
    # \`otlp_http\`, NOT \`otlphttp\`. Both resolve today, so this is easy to
    # "correct" in the wrong direction: upstream renamed the component and
    # \`otlphttp\` is now the DeprecatedType
    # (exporter/otlphttpexporter/internal/metadata/generated_status.go —
    # \`Type = MustNewType("otlp_http")\`, \`DeprecatedType = MustNewType("otlphttp")\`).
    #
    # \`traces_endpoint\`, not \`endpoint\`: the latter would have the exporter
    # append \`/v1/traces\` to a path that already ends in it.
    traces_endpoint: ${langfuseOtlpTracesEndpoint()}
    # Basic base64(pk:sk), precomputed into the Langfuse Secret because the
    # collector cannot base64 two env vars together (see LANGFUSE_SECRET_KEYS).
    headers:
      Authorization: \${env:LANGFUSE_OTLP_AUTH}
      # Langfuse v4 writes spans that carry this straight to its events table;
      # without it they wait for the ~15-minute server-side propagation.
      x-langfuse-ingestion-version: "4"
    # Langfuse accepts gzip (it is a Next.js route), and the hop pays for
    # itself: spans carry prompts and completions, which compress roughly an
    # order of magnitude.
    compression: gzip
    # Bounded rather than unlimited. The queue is what keeps a Langfuse restart
    # — a deploy, a node drain — from immediately becoming dropped spans, but
    # an unbounded one would let a long outage grow collector RSS until
    # \`memory_limiter\` starts refusing the pipeline's traffic.
    sending_queue:
      enabled: true
      queue_size: 2000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s`
    : "";

  // PostHog Logs is a consumer of the logs signal only. Traces are deliberately
  // not sent: LLM traces reach PostHog through Langfuse's own PostHog
  // integration, and APM traces are out of scope.
  //
  // Same shape as err2issue and for the same reason: its own pipeline, because
  // the severity filter is per-pipeline. WARN rather than ERROR because PostHog
  // is the searchable log store, not an alert sink, but INFO/DEBUG is what
  // would burn the 10 GB free tier. `severity_number < 13` is SEVERITY_NUMBER_WARN; a
  // record with no severity (0) is dropped too, which is the safe side.
  //
  // The project token is PostHog's public `phc_` key (it ships in the browser
  // bundle), so it sits in the ConfigMap as plain config, unlike the Langfuse
  // credential, which arrives by env reference. Hence no env var on the
  // pod and no secret checksum: a changed token changes the ConfigMap and the
  // collector reads it from there. Keyed off `cfg.posthog.logsEnabled`, which
  // already implies host + token + observability, so the exporter can never be
  // written without its endpoint.
  const posthogLogs = cfg.posthog.logsEnabled;
  const posthogProcessor = posthogLogs
    ? `
  filter/warn_and_above:
    error_mode: ignore
    log_conditions:
      - 'log.severity_number < SEVERITY_NUMBER_WARN'`
    : "";
  const posthogExporter = posthogLogs
    ? `
  otlp_http/posthog:
    # \`logs_endpoint\`, not \`endpoint\`: PostHog serves logs at /i/v1/logs and
    # that is the whole path, whatever the exporter would append.
    logs_endpoint: ${cfg.posthog.host.replace(/\/+$/, "")}/i/v1/logs
    headers:
      Authorization: "Bearer ${cfg.posthog.projectToken}"
    compression: gzip
    # Bounded for the reason the Langfuse exporter is: a PostHog outage must
    # not grow collector memory until memory_limiter refuses the pipeline.
    sending_queue:
      enabled: true
      queue_size: 1000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s`
    : "";
  const posthogPipeline = posthogLogs
    ? `
    logs/posthog:
      receivers: [otlp]
      processors: [memory_limiter, filter/warn_and_above, batch]
      exporters: [otlp_http/posthog]`
    : "";

  // Every signal a producer sends keeps a pipeline whatever consumes it, because
  // the OTLP receiver answers a signal no pipeline carries with an error that
  // every producer would log on each export. `nop` is the collector's own
  // exporter that accepts and discards, so a stack with PostHog logs and no
  // Langfuse still takes the traces its producers send, and one with Langfuse
  // and no log consumer still takes the logs. Declared only when a pipeline
  // needs it.
  const tracesOnNop = !langfuseSecretName;
  const logsOnNop = !cfg.err2issue.enabled && !posthogLogs;
  const nopExporter = tracesOnNop || logsOnNop ? "\n  nop:" : "";
  const tracesPipeline = `
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [${tracesOnNop ? "nop" : "otlp_http/langfuse"}]`;
  const nopLogsPipeline = logsOnNop
    ? `
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [nop]`
    : "";

  // ${env:LANGFUSE_OTLP_AUTH} is interpolated by the collector at startup from
  // the container env (secretKeyRef below) — the key never sits in the ConfigMap.
  const collectorConfig = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${OTLP_GRPC_PORT}
      http:
        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  batch:
    timeout: 5s
    send_batch_size: 1024${err2issueProcessor}${posthogProcessor}

exporters:${nopExporter}${err2issueExporter}${langfuseExporter}${posthogExporter}

extensions:
  health_check:
    endpoint: 0.0.0.0:${HEALTH_PORT}

service:
  extensions: [health_check]
  pipelines:${tracesPipeline}${nopLogsPipeline}${err2issuePipeline}${posthogPipeline}
`;

  const configMap = new k8s.core.v1.ConfigMap(
    COMPONENT,
    {
      metadata: { name: `${COMPONENT}-config`, namespace, labels },
      data: { "collector.yaml": collectorConfig },
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
            annotations: secretChecksumAnnotations(
              secretChecksum({
                ...(cfg.langfuse.enabled ? { "langfuse-otlp-auth": langfuseOtlpBasicAuth(cfg) } : {}),
              }),
            ),
          },
          spec: {
            enableServiceLinks: false,
            // No K8s API access needed — don't hand the pod an API token.
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
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
                ],
                env: [
                  // Present only when Langfuse is deployed. The collector
                  // fails to START on an unresolvable `${env:…}` in its
                  // config, so this env var and the exporter block above are
                  // one decision — both keyed off `cfg.langfuse.enabled`.
                  ...(langfuseSecretName
                    ? [
                        {
                          name: "LANGFUSE_OTLP_AUTH",
                          valueFrom: {
                            secretKeyRef: {
                              name: langfuseSecretName,
                              key: LANGFUSE_SECRET_KEYS.otlpBasicAuth,
                            },
                          },
                        },
                      ]
                    : []),
                ],
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
    { provider, dependsOn: [...dependsOn, configMap] },
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
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { deployment, service, configMap };
}
