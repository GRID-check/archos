import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * PostHog Support on the BFF (`apps/workspace/bff/posthog-support/config.ts`):
 * the personal API key is optional and secret, and the project id means nothing
 * without it. A stack that never set the key must not get an empty variable
 * pointing at a Secret key that is not there (CreateContainerConfigError), and a
 * stack that did must get the key from the Secret, never inline.
 */

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({ id: `${args.name}-id`, state: args.inputs }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

type EnvVar = k8s.types.input.core.v1.EnvVar;

let loadConfig: typeof import("../config").loadConfig;
let app: typeof import("./config");

beforeAll(async () => {
  pulumi.runtime.setAllConfig(baseStackConfig());
  ({ loadConfig } = await import("../config"));
  app = await import("./config");
});

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

function render(stack: Record<string, string>, secretKeys: string[] = []) {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...stack }, secretKeys);
  const cfg = loadConfig();
  const wiring = {
    cfg,
    namespace: "grid",
    provider: new k8s.Provider("test", { kubeconfig: "apiVersion: v1" }),
    redisUrl: pulumi.output("redis://dragonfly:6379"),
    seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
    seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
    qdrantUrl: pulumi.output("http://qdrant.grid.svc.cluster.local:6333"),
    dsn: (opts: { db: string }) => pulumi.output(`postgresql://x/${opts.db}`),
    imagePullSecrets: [],
  };
  const env: EnvVar[] = app.frontendEnv(wiring);
  const secret = app.buildSecrets(wiring).secret;
  return { env, secret };
}

const byName = (env: EnvVar[], name: string) => env.find((e) => e.name === name);

describe("PostHog Support wiring", () => {
  it("emits neither variable, and no Secret key, while the stack has no personal API key", async () => {
    const { env, secret } = render({});

    expect(byName(env, "POSTHOG_PERSONAL_API_KEY")).toBeUndefined();
    expect(byName(env, "POSTHOG_PROJECT_ID")).toBeUndefined();
    const data = await resolve(secret.stringData);
    expect(Object.keys(data ?? {})).not.toContain("POSTHOG_PERSONAL_API_KEY");
  });

  it("reads the key from the Secret and defaults the project id to Piloti's EU project", async () => {
    const { env, secret } = render(
      { "grid-oib:posthogPersonalApiKey": "phx_test" }, // pragma: allowlist secret
      ["grid-oib:posthogPersonalApiKey"],
    );

    expect(byName(env, "POSTHOG_PERSONAL_API_KEY")).toEqual({
      name: "POSTHOG_PERSONAL_API_KEY",
      valueFrom: { secretKeyRef: { name: expect.any(String), key: "POSTHOG_PERSONAL_API_KEY" } },
    });
    expect(byName(env, "POSTHOG_PROJECT_ID")).toEqual({ name: "POSTHOG_PROJECT_ID", value: "269895" });
    const data = await resolve(secret.stringData);
    expect(await resolve((data ?? {}).POSTHOG_PERSONAL_API_KEY)).toBe("phx_test");
  });

  it("takes the project id from the stack when it names one", () => {
    const { env } = render(
      { "grid-oib:posthogPersonalApiKey": "phx_test", "grid-oib:posthogProjectId": "12345" }, // pragma: allowlist secret
      ["grid-oib:posthogPersonalApiKey"],
    );

    expect(byName(env, "POSTHOG_PROJECT_ID")).toEqual({ name: "POSTHOG_PROJECT_ID", value: "12345" });
  });
});
