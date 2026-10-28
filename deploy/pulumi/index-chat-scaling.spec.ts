import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * With chat affinity off, KEDA scales the chat tier on the fleet's running
 * turns (ADR-0080). After the switch (`src/app/tier-names.ts`) that tier is
 * `chat`: the legacy one takes no new turns, so a ScaledObject on it would size
 * a draining tier to the whole fleet's load, and KEDA's NetworkPolicy must
 * admit the tier it polls.
 */

// The project name is the config namespace; read it from `Pulumi.yaml` rather than spell it here.
const PROJECT = /^name:\s*(\S+)/m.exec(readFileSync(new URL("./Pulumi.yaml", import.meta.url), "utf8"))![1];

const NAMED: Array<{ type: string; name: string; inputs: Record<string, any> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      NAMED.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  PROJECT,
  "test",
  false,
);

const named = (type: string) => NAMED.filter((r) => r.type === type).map((r) => r.name);

describe("the chat tier's scale-out after the switch", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      [`${PROJECT}:observabilityEnabled`]: "false",
      [`${PROJECT}:chatAffinity`]: "false",
      [`${PROJECT}:conversationBus`]: "true",
      [`${PROJECT}:backendMaxReplicas`]: "3",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("scales chat, and not the legacy tier that drains", () => {
    const scaled = named("kubernetes:keda.sh/v1alpha1:ScaledObject");
    expect(scaled).toContain("chat");
    expect(scaled).not.toContain("aiq-agent");
  });

  it("lets KEDA reach the tier it scales", () => {
    const policies = named("kubernetes:networking.k8s.io/v1:NetworkPolicy").filter((n) => n.startsWith("allow-keda-to-"));
    expect(policies).toContain("allow-keda-to-chat");
    expect(policies).not.toContain("allow-keda-to-aiq-agent");
  });
});
