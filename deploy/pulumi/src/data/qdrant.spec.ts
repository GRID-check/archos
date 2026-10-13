import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, qdrantStackConfig } from "../test-support/stack-config";

/**
 * The small-stack shape of `data/qdrant.ts`: one peer, no worker groups.
 * `index-qdrant.spec.ts` holds the three-peer cluster on a data group.
 *
 * One peer runs without cluster mode, so it must get no p2p URI, no internal
 * auth (there is no p2p to authenticate) and no disruption budget, and its
 * anti-affinity must stay a preference so it schedules on any node.
 */

type Env = { name: string; value?: string };
type Pod = {
  affinity: { podAntiAffinity: Record<string, unknown> };
  containers: Array<{ args: string[]; env: Env[] }>;
};
const RESOURCES: Array<{ type: string; name: string; inputs: unknown }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

describe("qdrant, one peer", () => {
  let pod: Pod;

  beforeAll(async () => {
    const { loadConfig } = await import("../config");
    const { installQdrant } = await import("./qdrant");
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...qdrantStackConfig(), "grid-oib:qdrantReplicas": "1" });
    const qdrant = installQdrant(loadConfig(), new k8s.Provider("test", {}), "grid", "http://seaweedfs:8333");
    // Registration is asynchronous: wait for the resources themselves.
    await Promise.all([qdrant.statefulSet.id, qdrant.service.id, qdrant.snapshotCronJob.id].map(resolve));
    const sts = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:StatefulSet" && r.name === "qdrant");
    pod = (await resolve(sts!.inputs as { spec: { template: { spec: Pod } } })).spec.template.spec;
  });

  it("starts without cluster mode, a p2p URI or internal auth", () => {
    const [container] = pod.containers;
    const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
    expect(container.args[0]).toMatch(/exec \.\/entrypoint\.sh$/);
    expect(container.args[0]).not.toContain("--uri");
    expect(env.QDRANT__CLUSTER__ENABLED).toBe("false");
    expect("QDRANT__SERVICE__ENFORCE_INTERNAL_AUTH" in env).toBe(false);
  });

  it("prefers a node of its own rather than requiring one", () => {
    expect(Object.keys(pod.affinity.podAntiAffinity)).toEqual(["preferredDuringSchedulingIgnoredDuringExecution"]);
  });

  it("gets no disruption budget, like every single-replica workload", () => {
    expect(RESOURCES.filter((r) => r.type === "kubernetes:policy/v1:PodDisruptionBudget")).toEqual([]);
  });

  it("snapshots its one peer", async () => {
    const cron = RESOURCES.find((r) => r.type === "kubernetes:batch/v1:CronJob" && r.name === "qdrant-snapshot");
    const spec = await resolve(
      cron!.inputs as { spec: { jobTemplate: { spec: { template: { spec: { containers: Array<{ env: Env[] }> } } } } } },
    );
    const env = spec.spec.jobTemplate.spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === "PEERS")?.value).toBe("http://qdrant-0.qdrant-headless.grid.svc.cluster.local:6333");
  });
});
