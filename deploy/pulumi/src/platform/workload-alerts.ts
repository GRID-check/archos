import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { commonLabels } from "./namespaces";
import { objectName } from "../names";

/**
 * Prometheus alerting rules for the workloads themselves, shipped as the
 * `workload-alert-rules` ConfigMap (`workload.rules.yaml`), in the format and
 * on the terms of `data/qdrant-alerts.ts`: this repo evaluates no rules, the
 * managed VictoriaMetrics agent on the cluster (`docs/deployment/kubernetes.md`,
 * "Provider add-ons") scrapes kube-state-metrics, and the file is what an
 * evaluator (vmalert, Prometheus) is pointed at.
 *
 * The one rule is the one `pulumi up` cannot give: a Deployment with no
 * available replica. `bff-jobs`, `purger` and `skill-scheduler` sat in
 * `CreateContainerConfigError` for eight days (`couldn't find key … in Secret`)
 * while the update that renamed the key went green, because Pulumi's await
 * ends with the rollout it started. `index-key-refs.spec.ts` stops that cause
 * before it ships; this notices every other way a tier ends up with nothing
 * serving.
 *
 * Until something evaluates it, `check` is the by-hand command for the same
 * question.
 */

export const WORKLOAD_ALERT_RULES = "workload-alert-rules";

/** Minutes a Deployment may have no available replica before the alert fires. */
export const UNAVAILABLE_FOR_MINUTES = 15;

/** The rule file, in Prometheus' `groups:` format. Exported for the spec and the ConfigMap. */
export function workloadAlertRules(namespace: string): string {
  // A Deployment scaled to zero on purpose (`spec.replicas == 0`) is not down.
  const expr =
    `kube_deployment_spec_replicas{namespace="${namespace}"} > 0` +
    ` and kube_deployment_status_replicas_available{namespace="${namespace}"} == 0`;
  return `# Rendered by deploy/pulumi/src/platform/workload-alerts.ts. Edit there, not here.
groups:
  - name: workloads
    rules:
      - alert: DeploymentUnavailable
        expr: ${JSON.stringify(expr)}
        for: ${UNAVAILABLE_FOR_MINUTES}m
        labels:
          severity: critical
        annotations:
          summary: ${JSON.stringify("Deployment {{ $labels.deployment }} has had no available replica for " + UNAVAILABLE_FOR_MINUTES + " minutes")}
          check: ${JSON.stringify(`kubectl -n ${namespace} get pods -o wide && kubectl -n ${namespace} describe deploy/<deployment>`)}
`;
}

/** The rules as a ConfigMap next to the workloads they watch. */
export function installWorkloadAlerts(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): k8s.core.v1.ConfigMap {
  return new k8s.core.v1.ConfigMap(
    WORKLOAD_ALERT_RULES,
    {
      metadata: { name: WORKLOAD_ALERT_RULES, namespace, labels: commonLabels("workload-alerts") },
      data: { "workload.rules.yaml": workloadAlertRules(objectName("namespace")) },
    },
    { provider },
  );
}
