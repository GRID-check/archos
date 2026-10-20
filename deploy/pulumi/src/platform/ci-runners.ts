import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { NODE_GROUP_LABEL } from "../constants";

/**
 * The actions-runner-controller charts, controller and scale set, and the only
 * place their version is written. The two are released together and must match:
 * the scale set chart writes the CRDs' current version, which only the controller
 * of the same release reads.
 */
export const ARC_CHART_VERSION = "0.15.0";
const ARC_CHARTS = "oci://ghcr.io/actions/actions-runner-controller-charts";

/** The controller and the scale set's listener. Needs the Kubernetes API; runs no pull request code. */
export const ARC_SYSTEM_NAMESPACE = "arc-systems";
/** The runner pods: every one runs a pull request's code. */
export const ARC_RUNNERS_NAMESPACE = "arc-runners";
/** The controller's Helm release name; its service account is `<release>-gha-rs-controller`. */
const CONTROLLER_RELEASE = "arc";

/**
 * Every address a pod in the cluster could reach that is not the internet:
 * RFC 1918, CGNAT (100.64/10, which some CNIs give pods), link-local (the cloud
 * metadata endpoint) and loopback. The runners' egress is the internet minus
 * these, so a pull request's code reaches GitHub and the package and image
 * registries, and nothing that is ours.
 */
export const CLUSTER_PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"];

export interface CiRunners {
  controller: k8s.helm.v3.Release;
  scaleSet: k8s.helm.v3.Release;
}

/**
 * GitHub Actions runners in this cluster (ADR-0118).
 *
 * Bought, not built: the actions-runner-controller is GitHub's own autoscaler
 * for runner pods. What is written here is the boundary around it, because
 * every runner runs code from a pull request:
 *
 * - The runners run in ARC's plain mode: no Docker daemon, no container hooks,
 *   no privileged pod. The jobs that run here need none of those: the runner
 *   image carries Postgres, Qdrant and the scanners as binaries. Image builds
 *   stay on GitHub's runners until a BuildKit pin clears trivy (ADR-0118).
 * - A runner pod gets no Kubernetes credentials: the chart's no-permission
 *   service account, and no token mounted at all.
 * - A NetworkPolicy gives the runners the internet and nothing in the cluster
 *   but DNS, and lets nothing call them.
 * - Placed on their own worker group when `ciRunnersNodeGroup` is set. An IPAX
 *   group cannot be tainted, so the group stays the runners' because every
 *   other workload names its own (`index-node-groups.spec.ts` holds that).
 *   Running the dev stack unplaced lets a runner land beside staging's pods,
 *   which the NetworkPolicy still keeps it off.
 *
 * The scale set scales to zero by default: an idle cluster runs the controller
 * and one listener, and a burst of jobs gets up to `maxRunners` pods.
 */
export function installCiRunners(cfg: GridConfig, provider: k8s.Provider): CiRunners {
  const runners = cfg.ciRunners;
  const opts = { provider };

  const systemNs = namespace(ARC_SYSTEM_NAMESPACE, provider);
  const runnersNs = namespace(ARC_RUNNERS_NAMESPACE, provider);
  installRunnerNetworkPolicy(provider, [runnersNs]);

  const controller = new k8s.helm.v3.Release(
    "arc-controller",
    {
      name: CONTROLLER_RELEASE,
      chart: `${ARC_CHARTS}/gha-runner-scale-set-controller`,
      version: ARC_CHART_VERSION,
      namespace: ARC_SYSTEM_NAMESPACE,
      values: {
        resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
      },
    },
    { ...opts, dependsOn: [systemNs] },
  );

  // The chart's GitHub App variant takes the key inline; a Secret of our own
  // keeps it out of the Helm release's stored values.
  const githubSecret = new k8s.core.v1.Secret(
    "arc-github-app",
    {
      metadata: { name: "arc-github-app", namespace: ARC_RUNNERS_NAMESPACE },
      stringData: {
        github_app_id: runners.githubApp.appId,
        github_app_installation_id: runners.githubApp.installationId,
        github_app_private_key: runners.githubApp.privateKey,
      },
    },
    { ...opts, dependsOn: [runnersNs] },
  );

  const scaleSet = new k8s.helm.v3.Release(
    "arc-scale-set",
    {
      name: runners.scaleSetName,
      chart: `${ARC_CHARTS}/gha-runner-scale-set`,
      version: ARC_CHART_VERSION,
      namespace: ARC_RUNNERS_NAMESPACE,
      values: scaleSetValues(runners, placementFor(runners.nodeGroup), githubSecret.metadata.name),
    },
    { ...opts, dependsOn: [controller, githubSecret] },
  );

  return { controller, scaleSet };
}

/** The scale set chart's values (exported for the spec, which renders them with `helm template`). */
export function scaleSetValues(
  runners: GridConfig["ciRunners"],
  placement: Placement,
  githubSecretName: pulumi.Input<string>,
): Record<string, unknown> {
  return {
    githubConfigUrl: runners.githubConfigUrl,
    githubConfigSecret: githubSecretName,
    runnerScaleSetName: runners.scaleSetName,
    minRunners: runners.minRunners,
    maxRunners: runners.maxRunners,
    controllerServiceAccount: { namespace: ARC_SYSTEM_NAMESPACE, name: `${CONTROLLER_RELEASE}-gha-rs-controller` },
    template: {
      spec: {
        automountServiceAccountToken: false,
        ...placement,
        containers: [
          {
            name: "runner",
            image: runners.image,
            command: ["/home/runner/run.sh"],
            resources: runners.resources,
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          },
        ],
      },
    },
  };
}

type Placement = { nodeSelector?: Record<string, string> };

/** On the CI worker group, when there is one. */
export function placementFor(nodeGroup: string | undefined): Placement {
  return nodeGroup ? { nodeSelector: { [NODE_GROUP_LABEL]: nodeGroup } } : {};
}

function namespace(name: string, provider: k8s.Provider): k8s.core.v1.Namespace {
  return new k8s.core.v1.Namespace(
    `${name}-ns`,
    {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/part-of": "grid-ci",
          "pod-security.kubernetes.io/enforce": "baseline",
        },
      },
    },
    { provider },
  );
}

/**
 * The runners reach the internet and DNS, and nothing calls them: a runner
 * calls GitHub, never the other way round.
 */
function installRunnerNetworkPolicy(provider: k8s.Provider, dependsOn: pulumi.Resource[]): void {
  new k8s.networking.v1.NetworkPolicy(
    "arc-runners-isolation",
    {
      metadata: { name: "runner-isolation", namespace: ARC_RUNNERS_NAMESPACE },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: CLUSTER_PRIVATE_RANGES } }] },
        ],
      },
    },
    { provider, dependsOn },
  );
}
