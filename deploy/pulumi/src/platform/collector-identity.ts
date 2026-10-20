import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { commonLabels } from "./namespaces";

/**
 * A collector's identity toward the Kubernetes API: a ServiceAccount bound to a
 * ClusterRole of read-only rules. Cluster-scoped because what the collectors
 * read is (nodes, their kubelets, every namespace's workloads), and read-only
 * because nothing they do writes: a collector holding a verb beyond
 * get/list/watch would be one more pod that can change the cluster.
 */

export type ReadRule = { apiGroups: string[]; resources: string[] };

const READ_VERBS = ["get", "list", "watch"];

/** What `k8s_cluster` watches to report workload state (its README's RBAC). */
export const CLUSTER_STATE_RULES: ReadRule[] = [
  {
    apiGroups: [""],
    resources: [
      "events",
      "namespaces",
      "namespaces/status",
      "nodes",
      "nodes/spec",
      "pods",
      "pods/status",
      "replicationcontrollers",
      "replicationcontrollers/status",
      "resourcequotas",
      "services",
    ],
  },
  { apiGroups: ["apps"], resources: ["daemonsets", "deployments", "replicasets", "statefulsets"] },
  { apiGroups: ["batch"], resources: ["jobs", "cronjobs"] },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"] },
];

/**
 * What the per-node agent reads: its node's kubelet summary (`nodes/stats`, all
 * `kubelet_stats` calls with this config) and the pods it discovers scrape
 * targets among. Never `nodes/proxy`: the kubelet authorises an exec upgrade
 * as `get nodes/proxy`, so that one "read" verb is a shell in every pod.
 */
export const NODE_AGENT_RULES: ReadRule[] = [{ apiGroups: [""], resources: ["nodes/stats", "pods"] }];

export interface CollectorIdentity {
  serviceAccount: k8s.core.v1.ServiceAccount;
  binding: k8s.rbac.v1.ClusterRoleBinding;
}

export function installCollectorIdentity(
  component: string,
  rules: ReadRule[],
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): CollectorIdentity {
  const labels = commonLabels(component);
  const serviceAccount = new k8s.core.v1.ServiceAccount(
    component,
    { metadata: { name: component, namespace, labels } },
    { provider },
  );
  // Cluster-scoped names are global: the namespace keeps two stacks on one
  // cluster from binding each other's collectors.
  const roleName = pulumi.interpolate`${namespace}-${component}`;
  const role = new k8s.rbac.v1.ClusterRole(
    component,
    {
      metadata: { name: roleName, labels },
      rules: rules.map((rule) => ({ ...rule, verbs: READ_VERBS })),
    },
    { provider },
  );
  const binding = new k8s.rbac.v1.ClusterRoleBinding(
    component,
    {
      metadata: { name: roleName, labels },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: role.metadata.name },
      subjects: [{ kind: "ServiceAccount", name: serviceAccount.metadata.name, namespace }],
    },
    { provider },
  );
  return { serviceAccount, binding };
}
