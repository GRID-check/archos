import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import * as pulumi from "@pulumi/pulumi";
import { NODE_GROUP_LABEL } from "./src/constants";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * Worker-group placement, with the knobs prod sets (IPAX, 2026-10).
 *
 * Prod was placed by hand first: Chroma on `data`, the ingest workers on
 * `batch`, the chat tier on `Node`. A `pulumi up` that renders anything else
 * moves them back, and one that places a tier nobody meant to (a store with a
 * PVC) moves it without its migration. So the whole program is built here and
 * every `nodeSelector` it emits is checked, not just the three expected ones.
 * `index.spec.ts` holds the other half: with the knobs unset, none at all.
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

/** The prod stack file's config, as `pulumi up` would read it. */
const PROD = (load(readFileSync(join(__dirname, "Pulumi.prod.yaml"), "utf8")) as { config: Record<string, unknown> })
  .config;
const PROD_KNOBS = [
  "nodeGroupApp",
  "nodeGroupData",
  "nodeGroupBatch",
  "ingestWorkerRequestsCpu",
  "ingestWorkerRequestsMemory",
  "ingestWorkerLimitsCpu",
  "ingestWorkerLimitsMemory",
];

/** Every `nodeSelector` anywhere in a resource's inputs, by resource. */
function nodeSelectors(): Record<string, unknown[]> {
  const found: Record<string, unknown[]> = {};
  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, owner));
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "nodeSelector") (found[owner] ??= []).push(child);
      walk(child, owner);
    }
  };
  for (const r of RESOURCES) walk(r.inputs, `${r.type.split(":").pop()}/${r.name}`);
  return found;
}

type Pod = {
  metadata: { annotations?: Record<string, string> };
  spec: { containers: Array<{ resources: unknown }> };
};
const podOf = (type: string, name: string): Pod =>
  (RESOURCES.find((r) => r.type === type && r.name === name)!.inputs.spec as { template: Pod }).template;

describe("worker-group placement with prod's knobs", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:observabilityEnabled": "false",
      ...Object.fromEntries(PROD_KNOBS.map((key) => [`grid-oib:${key}`, String(PROD[`grid-oib:${key}`])])),
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("names IPAX's groups as the nodes carry them, case and all", () => {
    expect(PROD["grid-oib:nodeGroupApp"]).toBe("Node");
    expect(PROD["grid-oib:nodeGroupData"]).toBe("data");
    expect(PROD["grid-oib:nodeGroupBatch"]).toBe("batch");
  });

  it("places the chat tier, Chroma and the ingest workers, and nothing else", () => {
    // Postgres, SeaweedFS, ClickHouse, Dragonfly, aiq-api and the frontend are
    // a later migration. A selector on any of them here moves a tier unplanned.
    expect(nodeSelectors()).toEqual({
      "StatefulSet/aiq-agent": [{ [NODE_GROUP_LABEL]: "Node" }],
      "StatefulSet/chroma": [{ [NODE_GROUP_LABEL]: "data" }],
      "Deployment/ingest-worker": [{ [NODE_GROUP_LABEL]: "batch" }],
    });
  });

  it("selects on the label IPAX sets", () => {
    expect(NODE_GROUP_LABEL).toBe("k8s.at/node-group");
  });

  it("sizes prod's ingest workers for big PDFs on the batch nodes", () => {
    // OOMKilled at a 6Gi limit with three files in parallel (2026-10).
    const [container] = podOf("kubernetes:apps/v1:Deployment", "ingest-worker").spec.containers;

    expect(container.resources).toEqual({
      requests: { cpu: "500m", memory: "8Gi" },
      limits: { cpu: "4", memory: "12Gi" },
    });
  });

  it("keeps Chroma's autoscaler annotation on the data group too", () => {
    const pod = podOf("kubernetes:apps/v1:StatefulSet", "chroma");

    expect(pod.metadata.annotations?.["cluster-autoscaler.kubernetes.io/safe-to-evict"]).toBe("false");
  });

  it.each(["Node group", "-data", "batch/x", "x".repeat(64)])(
    "refuses a group name no node label can carry: %s",
    async (value) => {
      const { loadConfig } = await import("./src/config");
      pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:nodeGroupData": value });

      expect(() => loadConfig()).toThrow(/grid-oib:nodeGroupData must be a Kubernetes label value/);
    },
  );
});
