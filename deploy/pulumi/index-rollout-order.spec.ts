import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * The api tier and the chat tier roll out first, then the frontend that dials
 * them, so an upgrade needs no sequencing by hand. A frontend pointed at a
 * Service with no ready pod behind it fails every call (HTTP) or every new
 * conversation (the socket) until that tier catches up. Pulumi awaits a
 * workload's rollout before it creates what depends on it, so `dependsOn` is the
 * whole mechanism, and nothing in a green `pulumi up` says it went missing.
 *
 * Nothing here contacts a cluster. It reads the dependencies the SDK registers.
 */

const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const STATEFULSET = "kubernetes:apps/v1:StatefulSet";
const SERVICE = "kubernetes:core/v1:Service";

let graph: DependencyGraph;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
    }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

describe("rollout order: api and chat, then the frontend", () => {
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

  it("rolls the frontend out only after the api Service", () => {
    expect(graph.waitsOn(DEPLOYMENT, "frontend", SERVICE, "api")).toBe(true);
  });

  it("rolls the frontend out only after the chat tier it dials", () => {
    // The switch step (`src/app/tier-names.ts`): a frontend that points its socket
    // at `chat` before `chat` is ready drops every new conversation.
    expect(graph.waitsOn(DEPLOYMENT, "frontend", STATEFULSET, "chat")).toBe(true);
    expect(graph.waitsOn(DEPLOYMENT, "frontend", SERVICE, "chat")).toBe(true);
  });

  it("never makes the chat tier wait on the frontend, which would be a cycle", () => {
    expect(graph.waitsOn(STATEFULSET, "chat", DEPLOYMENT, "frontend")).toBe(false);
  });
});
