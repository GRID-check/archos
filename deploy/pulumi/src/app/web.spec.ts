import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * How the landing site starts (`app/web.ts` + `apps/site/Dockerfile`).
 *
 * The entry file is the image's business. When this program also named one,
 * the two had to change in lockstep across a boundary no test crossed: a new
 * entry in the Deployment with an old image, or the reverse, is a
 * CrashLoopBackOff that plans clean.
 */

type Container = { name: string; command?: string[]; env?: Array<{ name: string; value?: string }> };
let container: Container | undefined;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.type === "kubernetes:apps/v1:Deployment" && args.name === "web") {
        container = args.inputs.spec.template.spec.containers[0];
      }
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const webDir = join(__dirname, "..", "..", "..", "..", "apps", "site");

describe("the web Deployment", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const { loadConfig } = await import("../config");
    const { installWeb } = await import("./web");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const web = installWeb(loadConfig(), provider, "grid", [], []);
    await new Promise((resolve) => web.deployment.id.apply(resolve));
  });

  it("leaves the entry command to the image", () => {
    expect(container?.name).toBe("web");
    expect(container).not.toHaveProperty("command");
  });

  it("starts an image entry file that the image copies in", () => {
    const dockerfile = readFileSync(join(webDir, "Dockerfile"), "utf8");
    const cmd = dockerfile.match(/^CMD \["node", "([^"]+)"\]/m)?.[1];
    expect(cmd).toBe("runtime/server.mjs");
    expect(existsSync(join(webDir, cmd!))).toBe(true);
    // The runner stage copies dist/ and node_modules/ by name; a new top-level
    // directory the entry lives in has to be copied too.
    expect(dockerfile).toMatch(/^COPY --from=builder .* \/app\/runtime \.\/runtime$/m);
  });
});

/**
 * The landing site's PostHog pair. The pages are prerendered and the image has
 * no env files, so `/web-analytics.js` reads `PUBLIC_POSTHOG_*` from the pod's
 * environment per request; a Deployment that never carries them leaves web
 * analytics off on every stack and plans clean.
 */
describe("the web Deployment's PostHog env", () => {
  const POSTHOG = {
    "grid-oib:posthogHost": "https://eu.i.posthog.com",
    "grid-oib:posthogProjectToken": "phc_test_token", // pragma: allowlist secret
  };

  async function webEnv(values: Record<string, string>) {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false", ...values });
    const { loadConfig } = await import("../config");
    const { installWeb } = await import("./web");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const web = installWeb(loadConfig(), provider, "grid", [], []);
    await new Promise((resolve) => web.deployment.id.apply(resolve));
    return (container?.env ?? []).filter((e) => e.name.startsWith("PUBLIC_POSTHOG_"));
  }

  it("carries the pair the stack configures", async () => {
    expect(await webEnv(POSTHOG)).toEqual([
      { name: "PUBLIC_POSTHOG_HOST", value: "https://eu.i.posthog.com" },
      { name: "PUBLIC_POSTHOG_PROJECT_TOKEN", value: "phc_test_token" },
    ]);
  });

  it("carries Piloti's project when the stack sets nothing", async () => {
    const { POSTHOG_DEFAULT_HOST, POSTHOG_DEFAULT_PROJECT_TOKEN } = await import("../config/posthog");
    expect(await webEnv({})).toEqual([
      { name: "PUBLIC_POSTHOG_HOST", value: POSTHOG_DEFAULT_HOST },
      { name: "PUBLIC_POSTHOG_PROJECT_TOKEN", value: POSTHOG_DEFAULT_PROJECT_TOKEN },
    ]);
  });

  it.each([
    ["host", { "grid-oib:posthogHost": "" }],
    ["token", { "grid-oib:posthogProjectToken": "" }],
    ["both", { "grid-oib:posthogHost": "", "grid-oib:posthogProjectToken": "" }],
  ])("carries nothing once the %s is emptied, never a half-configured pod", async (_what, values) => {
    expect(await webEnv(values)).toEqual([]);
  });
});
