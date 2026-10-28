import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DeployConfig } from '../config'
import { logicalName, objectName } from "../names";

/** The single namespace holding every app + data workload. */
export function makeAppNamespace(
  cfg: DeployConfig,
  provider: k8s.Provider,
): k8s.core.v1.Namespace {
  return new k8s.core.v1.Namespace(
    logicalName("grid-ns"),
    {
      metadata: {
        name: cfg.namespace,
        labels: {
          "app.kubernetes.io/part-of": objectName("partOf"),
          // Baseline Pod Security Standard: our images run as non-root
          // (backend UID 1000, frontend UID 1001) so this is satisfied.
          "pod-security.kubernetes.io/enforce": "baseline",
        },
      },
    },
    { provider },
  );
}

/** Convenience: default metadata labels applied to every workload. */
export function commonLabels(component: string): pulumi.Input<{ [k: string]: string }> {
  return {
    "app.kubernetes.io/name": component,
    "app.kubernetes.io/part-of": objectName("partOf"),
    "app.kubernetes.io/managed-by": "pulumi",
  };
}
