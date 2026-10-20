import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { ROLLOUT, gracefulShutdown, secretChecksum, secretChecksumAnnotations } from "./rollout";
import { NODE_AGENT_RULES, installCollectorIdentity } from "./collector-identity";
import { SCRAPE_ANNOTATION } from "./scrape";
import {
  CollectorFragment,
  HEALTH_PORT,
  OTLP_HTTP_PORT,
  boundedDelivery,
  composeCollectorConfig,
  renderCollectorConfig,
} from "./collector-config";

const COMPONENT = "otel-agent";
/** The kubelet's authenticated API, on every node. */
const KUBELET_PORT = 10250;
/** How often each node's kubelet is read and each annotated pod scraped. */
const SCRAPE_INTERVAL = "30s";
const GATEWAY_EXPORTER = "otlp_http/gateway";

export interface OtelAgent {
  daemonSet: k8s.apps.v1.DaemonSet;
  configMap: k8s.core.v1.ConfigMap;
}

/**
 * One collector per node: what that node and its pods are doing.
 *
 * - **kubeletstats**: CPU, memory, network and filesystem of the node, of every
 *   pod and container on it, and of their volumes, read from the node's own
 *   kubelet.
 * - **prometheus/pods**: every pod on the node annotated
 *   `prometheus.io/scrape: "true"` (`scrape.ts`), at its `prometheus.io/port`
 *   and `prometheus.io/path`, labelled with its namespace, pod and container.
 *
 * Per node because both readings are per node: each agent reads one kubelet
 * and scrapes only the pods scheduled beside it, so every pod is scraped
 * exactly once however many nodes the cluster grows to, and no single pod
 * holds the whole cluster's scrape. The agents hold no credential for any
 * backend: they send OTLP to the gateway (`otel-collector.ts`), which stamps
 * the stack and exports to PostHog. This is the topology the OpenTelemetry
 * Helm charts call agent and gateway.
 *
 * Deployed only with PostHog metrics on: it exists to feed them.
 */
export function installOtelAgent(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): OtelAgent {
  const labels = commonLabels(COMPONENT);
  const identity = installCollectorIdentity(COMPONENT, NODE_AGENT_RULES, provider, namespace);
  const config = renderCollectorConfig(
    composeCollectorConfig([nodeStats(), annotatedPods(), toGateway()], { otlpReceiver: false }),
  );

  const configMap = new k8s.core.v1.ConfigMap(
    COMPONENT,
    { metadata: { name: `${COMPONENT}-config`, namespace, labels }, data: { "collector.yaml": config } },
    { provider },
  );

  const daemonSet = new k8s.apps.v1.DaemonSet(
    COMPONENT,
    {
      metadata: { name: COMPONENT, namespace, labels },
      spec: {
        selector: { matchLabels: labels },
        // One node's readings pause while its agent rolls; never all of them.
        updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1 } },
        template: {
          metadata: {
            labels,
            // The collector reads its file once, at start (see otel-collector.ts).
            annotations: secretChecksumAnnotations(secretChecksum({ "collector.yaml": config })),
          },
          spec: {
            enableServiceLinks: false,
            serviceAccountName: identity.serviceAccount.metadata.name,
            automountServiceAccountToken: true,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            // Time to flush the batch in hand to the gateway on SIGTERM.
            terminationGracePeriodSeconds: gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
            // Every node, whatever group it is in or how it is tainted: a node
            // without an agent is a node whose readings are missing, and
            // nothing reports a gap. No `onNodeGroup`, on purpose.
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: "collector",
                image: cfg.observability.collectorImage,
                imagePullPolicy: "IfNotPresent",
                args: ["--config=/etc/otelcol/collector.yaml"],
                ports: [{ containerPort: HEALTH_PORT, name: "health" }],
                env: [
                  // Which kubelet to read, and which pods are this node's.
                  { name: "K8S_NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
                  { name: "K8S_NODE_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
                ],
                volumeMounts: [{ name: "config", mountPath: "/etc/otelcol", readOnly: true }],
                resources: {
                  requests: { cpu: "50m", memory: "64Mi" },
                  limits: { cpu: "250m", memory: "256Mi" },
                },
                readinessProbe: { httpGet: { path: "/", port: HEALTH_PORT }, periodSeconds: 10, timeoutSeconds: 5 },
                livenessProbe: {
                  httpGet: { path: "/", port: HEALTH_PORT },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
            volumes: [{ name: "config", configMap: { name: configMap.metadata.name } }],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, configMap, identity.binding] },
  );

  return { daemonSet, configMap };
}

/**
 * The node's kubelet, by its host IP. `insecure_skip_verify` because a
 * kubelet's serving certificate is self-signed on most distributions and names
 * no IP; the request still carries the service account's token, which the
 * kubelet authorises against `nodes/stats`. The OpenTelemetry chart's
 * `kubeletMetrics` preset makes the same call for the same reason.
 */
export function nodeStats(): CollectorFragment {
  return {
    receivers: {
      kubeletstats: {
        auth_type: "serviceAccount",
        endpoint: `https://\${env:K8S_NODE_IP}:${KUBELET_PORT}`,
        insecure_skip_verify: true,
        collection_interval: SCRAPE_INTERVAL,
        metric_groups: ["node", "pod", "container", "volume"],
      },
    },
    pipelines: { "metrics/node": { receivers: ["kubeletstats"], exporters: [GATEWAY_EXPORTER] } },
  };
}

/**
 * Every annotated pod on this node. The relabelling is Prometheus's own
 * `kubernetes-pods` convention; `$$` is how the collector config writes the
 * `$` of a capture group, because a single `$` is its own env expansion.
 */
export function annotatedPods(): CollectorFragment {
  const meta = (annotation: string) =>
    `__meta_kubernetes_pod_annotation_${annotation.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return {
    receivers: {
      "prometheus/pods": {
        config: {
          scrape_configs: [
            {
              job_name: "kubernetes-pods",
              scrape_interval: SCRAPE_INTERVAL,
              scrape_timeout: "10s",
              kubernetes_sd_configs: [
                { role: "pod", selectors: [{ role: "pod", field: "spec.nodeName=${env:K8S_NODE_NAME}" }] },
              ],
              relabel_configs: [
                { source_labels: [meta(SCRAPE_ANNOTATION.scrape)], action: "keep", regex: "true" },
                // A pod not yet running has no address to scrape.
                { source_labels: ["__meta_kubernetes_pod_phase"], action: "keep", regex: "Running" },
                {
                  source_labels: [meta(SCRAPE_ANNOTATION.path)],
                  action: "replace",
                  regex: "(.+)",
                  target_label: "__metrics_path__",
                },
                {
                  source_labels: ["__meta_kubernetes_pod_ip", meta(SCRAPE_ANNOTATION.port)],
                  action: "replace",
                  regex: "(.+);(\\d+)",
                  replacement: "$$1:$$2",
                  target_label: "__address__",
                },
                { source_labels: ["__meta_kubernetes_namespace"], target_label: "k8s_namespace_name" },
                { source_labels: ["__meta_kubernetes_pod_name"], target_label: "k8s_pod_name" },
                { source_labels: ["__meta_kubernetes_pod_container_name"], target_label: "k8s_container_name" },
                // The job is the workload's name, so a series says which
                // service it came from without a lookup.
                {
                  source_labels: ["__meta_kubernetes_pod_label_app_kubernetes_io_name"],
                  regex: "(.+)",
                  target_label: "job",
                },
              ],
            },
          ],
        },
      },
    },
    pipelines: { "metrics/pods": { receivers: ["prometheus/pods"], exporters: [GATEWAY_EXPORTER] } },
  };
}

/** OTLP to the gateway in the same namespace; it alone holds PostHog's token. */
export function toGateway(): CollectorFragment {
  return {
    exporters: {
      [GATEWAY_EXPORTER]: {
        endpoint: `http://otel-collector:${OTLP_HTTP_PORT}`,
        compression: "gzip",
        // A gateway mid-roll must not become dropped node readings, within a bound.
        ...boundedDelivery(500),
      },
    },
  };
}
