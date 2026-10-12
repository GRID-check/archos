import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { NODE_GROUP_LABEL } from "../constants";

/**
 * Scheduling helpers for the provider's managed-k0s behaviour.
 *
 * Two provider facts drive this module (docs/deployment/kubernetes.md §1):
 *   1. **Version upgrades are automatic** and replace/drain worker nodes with no
 *      operator involvement. A voluntary node drain that evicts every replica of
 *      a service at once is a self-inflicted outage during a routine upgrade.
 *   2. The **cluster-autoscaler reacts to unschedulable pods**, and the provider
 *      lists `topologySpreadConstraints` (alongside HPAs and requests/limits) as
 *      a precondition for it to behave well.
 *
 * So every workload that runs ≥2 replicas gets:
 *   - a **PodDisruptionBudget** (`maxUnavailable: 1`) so a drain can only take one
 *     replica down at a time, and
 *   - a soft **topologySpreadConstraint** across nodes so replicas land on
 *     different worker nodes (a single node loss never takes the whole tier).
 *
 * NOTE — single-replica workloads deliberately get NO PDB: `minAvailable: 1` on a
 * 1-replica workload would block the node drain forever and deadlock the
 * provider's automatic upgrades. Postgres HA is handled by CloudNativePG's own
 * PDB.
 */

/**
 * Spread a workload's pods across worker nodes. Drop this onto a pod `spec`.
 *
 * Soft by default (`ScheduleAnyway`): it never blocks a rollout when the cluster
 * is briefly down to one schedulable node (e.g. mid node-replacement), but the
 * scheduler spreads whenever it can. `required` makes it `DoNotSchedule`, for a
 * tier whose replicas are worthless on one node and whose group is known to hold
 * enough nodes (the PgBouncers on the data group).
 *
 * `matchLabels` must be labels the pods really carry. An operator that builds
 * the pods may overwrite the template's labels (CloudNativePG does), and a
 * selector that matches no pod spreads nothing and fails no check.
 */
export function spreadAcrossNodes(
  matchLabels: pulumi.Input<{ [k: string]: string }>,
  required = false,
): k8s.types.input.core.v1.TopologySpreadConstraint[] {
  return [
    {
      maxSkew: 1,
      topologyKey: "kubernetes.io/hostname",
      whenUnsatisfiable: required ? "DoNotSchedule" : "ScheduleAnyway",
      labelSelector: { matchLabels },
    },
  ];
}

/**
 * Pin a pod to one worker group, by the label IPAX puts on the group's nodes
 * (`NODE_GROUP_LABEL`). A nodeSelector, not a taint and toleration, because an
 * IPAX worker group cannot be tainted from the Control Center: a selector keeps
 * a tier ON its group but not other pods OFF it. So every pod template in the
 * program calls this, and the data nodes stay for the stores only because
 * nothing else selects them (`index-node-groups.spec.ts` fails a template that
 * does not). Spread onto a pod `spec`; with no group (the knob unset) it adds
 * nothing.
 */
export function onNodeGroup(group: string | undefined): { nodeSelector?: { [k: string]: string } } {
  return group ? { nodeSelector: { [NODE_GROUP_LABEL]: group } } : {};
}

/**
 * A PodDisruptionBudget capping voluntary disruptions at one pod. `maxUnavailable`
 * (not `minAvailable`) is used on purpose: it scales with any replica count and
 * can never deadlock a drain the way `minAvailable: <replicas>` would.
 */
export function installPdb(
  name: string,
  namespace: pulumi.Input<string>,
  provider: k8s.Provider,
  matchLabels: pulumi.Input<{ [k: string]: string }>,
  dependsOn: pulumi.Resource[] = [],
): k8s.policy.v1.PodDisruptionBudget {
  return new k8s.policy.v1.PodDisruptionBudget(
    name,
    {
      metadata: { name, namespace },
      spec: {
        maxUnavailable: 1,
        selector: { matchLabels },
      },
    },
    { provider, dependsOn },
  );
}
