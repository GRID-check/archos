import * as k8s from "@pulumi/kubernetes";
import { PLATFORM_RESOURCES } from "../constants";
import { scrapeAnnotations } from "./scrape";

/** Namespace KEDA runs in; the network policies that let it read the queues name it. */
export const KEDA_NAMESPACE = "keda";

/**
 * The KEDA chart version, and the only place it is written. The chart's version
 * is KEDA's own (chart 2.21.0 installs KEDA 2.21.0), and the CRD schemas
 * `scripts/validate-crs.mjs` checks every ScaledObject and TriggerAuthentication
 * against are the release of the same number: a plan that validates must be a
 * plan the installed operator accepts. `keda.spec.ts` holds the two together, so
 * moving one without the other fails `task infra:test`.
 */
export const KEDA_CHART_VERSION = "2.21.0";

/** The label KEDA's operator pods carry (chart value `operator.name`), which a NetworkPolicy selects them by. */
export const KEDA_OPERATOR_LABEL = { "app.kubernetes.io/name": "keda-operator" } as const;
/** The operator's Prometheus listener (chart value `prometheus.operator.port`, its default). */
const KEDA_OPERATOR_METRICS_PORT = 8080;

/**
 * KEDA — the event-driven autoscaler the queue-driven tiers scale with: the
 * ingest-worker (ADR-0076), the agent-worker and the bff-jobs pool (ADR-0079),
 * and the chat tier (ADR-0080).
 *
 * The CPU HPAs this cluster already runs cannot scale ingestion: an ingest
 * worker spends most of a job waiting on the model provider, so its CPU says
 * nothing about how much work is waiting, and `metrics.k8s.io` is the only
 * metrics API here (no Prometheus adapter). KEDA answers the question directly
 * — it runs `SELECT COUNT(*)` against the durable queue and sets the replica
 * count from it — and brings its own `external.metrics.k8s.io` provider, so no
 * metrics pipeline has to exist first. It can also scale a tier to zero, which
 * an HPA cannot.
 *
 * Bought rather than built: the alternative is a controller of our own that
 * polls Postgres and patches a Deployment's replicas, i.e. a worse KEDA.
 */
export function installKeda(provider: k8s.Provider): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace("keda-ns", { metadata: { name: KEDA_NAMESPACE } }, { provider });
  return new k8s.helm.v3.Release(
    "keda",
    {
      chart: "keda",
      // Pinned, unlike the other platform charts: this one runs the autoscaler of
      // four tiers, `fallback` and the scaler's metric types are KEDA-version
      // behaviour, and the plan is validated against this release's CRDs.
      version: KEDA_CHART_VERSION,
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://kedacore.github.io/charts" },
      values: {
        resources: {
          operator: PLATFORM_RESOURCES.kedaOperator,
          metricServer: PLATFORM_RESOURCES.kedaMetricServer,
          webhooks: PLATFORM_RESOURCES.kedaWebhooks,
        },
        // The operator runs every scaler, so its metrics are the ones that say
        // whether a trigger can read its queue (`keda_scaler_errors_total`,
        // `keda_scaler_metrics_value`): a trigger that cannot leaves its tier
        // at its count while the queue grows, and nothing else reports it. The
        // node agents scrape them (ADR-0119); nothing outside `keda` is
        // granted anything for it, since `keda` has no ingress policy.
        prometheus: { operator: { enabled: true, port: KEDA_OPERATOR_METRICS_PORT } },
        podAnnotations: { keda: scrapeAnnotations(KEDA_OPERATOR_METRICS_PORT) },
      },
    },
    { provider, dependsOn: [ns] },
  );
}
