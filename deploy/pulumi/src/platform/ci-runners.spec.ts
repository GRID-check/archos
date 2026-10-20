import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The CI runners (ADR-0119). Every runner runs a pull request's code, so what
 * is checked here is the boundary: the plain runner mode with no Docker daemon
 * and no Kubernetes credentials, egress to the internet and nothing private,
 * nothing allowed in, and a config that refuses to plan any of it without
 * NetworkPolicies, a GitHub App and a digest-pinned image.
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const IMAGE = `ghcr.io/grid-check/grid-ci-runner@sha256:${"a".repeat(64)}`;
const ENABLED = {
  "grid-oib:ciRunnersEnabled": "true",
  "grid-oib:ciRunnersGithubAppId": "123",
  "grid-oib:ciRunnersGithubAppInstallationId": "456",
  "grid-oib:ciRunnersGithubAppPrivateKey": "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
  "grid-oib:ciRunnersImage": IMAGE,
};

async function loadWith(values: Record<string, string>): Promise<Error | null> {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  const { loadConfig } = await import("../config");
  try {
    loadConfig();
    return null;
  } catch (e) {
    return e as Error;
  }
}

const byName = (type: string, name: string): Inputs => {
  const found = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!found) throw new Error(`no ${type} named ${name}`);
  return found.inputs;
};
const resolved = <T>(value: unknown): Promise<T> =>
  pulumi.Output.isInstance(value)
    ? new Promise((resolve) => (value as pulumi.Output<T>).apply(resolve))
    : Promise.resolve(value as T);

describe("CI runner config", () => {
  it("is off unless asked for, and needs nothing then", async () => {
    expect(await loadWith({})).toBeNull();
    const { loadConfig } = await import("../config");
    expect(loadConfig().ciRunners.enabled).toBe(false);
  });

  it("refuses to run a pull request's code without NetworkPolicies", async () => {
    const err = await loadWith({ ...ENABLED, "grid-oib:networkPolicies": "false" });
    expect(err?.message).toMatch(/ciRunnersEnabled requires grid-oib:networkPolicies/);
  });

  it("refuses without the GitHub App the controller registers with", async () => {
    const { "grid-oib:ciRunnersGithubAppPrivateKey": _key, ...withoutKey } = ENABLED;
    expect((await loadWith(withoutKey))?.message).toMatch(/needs the GitHub App/);
  });

  it("refuses a runner image named by tag", async () => {
    const err = await loadWith({ ...ENABLED, "grid-oib:ciRunnersImage": "ghcr.io/grid-check/grid-ci-runner:latest" });
    expect(err?.message).toMatch(/must name the runner image by digest/);
  });

  it("refuses a floor above the ceiling", async () => {
    const err = await loadWith({ ...ENABLED, "grid-oib:ciRunnersMinRunners": "9" });
    expect(err?.message).toMatch(/exceeds ciRunnersMaxRunners/);
  });
});

describe("CI runners, rendered", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...ENABLED, "grid-oib:ciRunnersNodeGroup": "ci" });
    const { loadConfig } = await import("../config");
    const { installCiRunners } = await import("./ci-runners");
    const k8s = await import("@pulumi/kubernetes");
    installCiRunners(loadConfig(), new k8s.Provider("test", {}));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("pins both charts to one release", async () => {
    const { ARC_CHART_VERSION } = await import("./ci-runners");
    const controller = byName("kubernetes:helm.sh/v3:Release", "arc-controller");
    const scaleSet = byName("kubernetes:helm.sh/v3:Release", "arc-scale-set");
    expect(controller.version).toBe(ARC_CHART_VERSION);
    expect(scaleSet.version).toBe(ARC_CHART_VERSION);
    expect(controller.chart).toMatch(/gha-runner-scale-set-controller$/);
    expect(scaleSet.chart).toMatch(/gha-runner-scale-set$/);
  });

  it("runs the runners in plain mode, without Kubernetes credentials or privilege", async () => {
    const values = await resolved<Record<string, any>>(byName("kubernetes:helm.sh/v3:Release", "arc-scale-set").values);
    // No containerMode: dind would mean a privileged pod, kubernetes mode a
    // service account that can create pods.
    expect(values.containerMode).toBeUndefined();
    expect(values.runnerScaleSetName).toBe("grid-ci");
    expect(values.minRunners).toBe(0);
    expect(values.controllerServiceAccount).toEqual({ namespace: "arc-systems", name: "arc-gha-rs-controller" });
    const spec = values.template.spec;
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.serviceAccountName).toBeUndefined();
    expect(spec.nodeSelector).toEqual({ "k8s.at/node-group": "ci" });
    const [runner] = spec.containers;
    expect(spec.containers).toHaveLength(1);
    expect(runner.image).toBe(IMAGE);
    expect(runner.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(spec.volumes).toBeUndefined();
  });

  it("keeps the GitHub App key out of the Helm release's values", async () => {
    const values = await resolved<Record<string, any>>(byName("kubernetes:helm.sh/v3:Release", "arc-scale-set").values);
    expect(await resolved(values.githubConfigSecret)).toBe("arc-github-app");
    expect(JSON.stringify(values)).not.toContain("PRIVATE KEY");
  });

  it("lets the runners reach the internet and DNS, and nothing private", async () => {
    const { CLUSTER_PRIVATE_RANGES } = await import("./ci-runners");
    const policy = byName("kubernetes:networking.k8s.io/v1:NetworkPolicy", "arc-runners-isolation").spec as any;
    expect(policy.podSelector).toEqual({});
    expect(policy.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.ingress).toEqual([]);
    const blocks = policy.egress.flatMap((rule: any) => rule.to.filter((to: any) => to.ipBlock).map((to: any) => to.ipBlock));
    expect(blocks).toEqual([{ cidr: "0.0.0.0/0", except: CLUSTER_PRIVATE_RANGES }]);
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]) {
      expect(CLUSTER_PRIVATE_RANGES).toContain(range);
    }
    // The one other egress rule is DNS: kube-system, port 53 only.
    const named = policy.egress.filter((rule: any) => !rule.to.some((to: any) => to.ipBlock));
    expect(named).toEqual([
      {
        to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
    ]);
  });

  it("holds both namespaces to the Baseline Pod Security Standard", () => {
    for (const name of ["arc-systems", "arc-runners"]) {
      const labels = (byName("kubernetes:core/v1:Namespace", `${name}-ns`).metadata as any).labels;
      expect(labels["pod-security.kubernetes.io/enforce"], name).toBe("baseline");
    }
  });
});
