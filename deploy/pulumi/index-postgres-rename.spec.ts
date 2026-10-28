import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * The databases and the owner role are renamed from their AI-Q names on the
 * deploy that carries ADR-0145 row 10d, by `pg-rename-legacy-names`. It must run
 * before anything connects with the new names (every tier waits on the init
 * Job, so the init Job waits on it), as the superuser the Cluster now exposes,
 * and the Cluster must bootstrap a fresh stack with the new names directly.
 */

const JOB = "kubernetes:batch/v1:Job";
const CLUSTER = "kubernetes:postgresql.cnpg.io/v1:Cluster";
const STATEFULSET = "kubernetes:apps/v1:StatefulSet";
const DEPLOYMENT = "kubernetes:apps/v1:Deployment";

const INPUTS = new Map<string, Record<string, unknown>>();
let graph: DependencyGraph;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      INPUTS.set(`${args.type}::${args.name}`, args.inputs);
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const inputs = (type: string, name: string) => {
  const hit = INPUTS.get(`${type}::${name}`);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit as { spec: Record<string, any> };
};

describe("the rename of the AI-Q databases and role", () => {
  beforeAll(async () => {
    graph = new DependencyGraph();
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("runs before the init Job, and so before every tier that connects", () => {
    expect(graph.waitsOn(JOB, "pg-init-tables", JOB, "pg-rename-legacy-names")).toBe(true);
    expect(graph.waitsOn(STATEFULSET, "aiq-agent", JOB, "pg-rename-legacy-names")).toBe(true);
    expect(graph.waitsOn(DEPLOYMENT, "api", JOB, "pg-rename-legacy-names")).toBe(true);
    expect(graph.waitsOn(JOB, "pg-rename-legacy-names", CLUSTER, "grid-pg")).toBe(true);
  });

  it("logs in as the Cluster's superuser and sets the agent role's password", async () => {
    expect(inputs(CLUSTER, "grid-pg").spec.enableSuperuserAccess).toBe(true);
    const job = inputs(JOB, "pg-rename-legacy-names");
    const container = job.spec.template.spec.containers[0];
    const env = Object.fromEntries(
      (container.env as Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string } } }>).map(
        (e) => [e.name, e.value ?? e.valueFrom?.secretKeyRef.name],
      ),
    );
    expect(env.PGUSER).toBe("grid-pg-superuser");
    expect(env.PGPASSWORD).toBe("grid-pg-superuser");
    expect(env.ROLE_PASSWORD).toBeDefined();
    expect(container.command).toEqual(["sh", "/script/rename-legacy-names.sh"]);
  });

  it("bootstraps a fresh cluster with the new names", () => {
    const initdb = inputs(CLUSTER, "grid-pg").spec.bootstrap.initdb;
    expect(initdb.database).toBe("jobs");
    expect(initdb.owner).toBe("agent");
    expect(initdb.postInitSQL[0]).toBe("CREATE DATABASE checkpoints OWNER agent");
  });
});
