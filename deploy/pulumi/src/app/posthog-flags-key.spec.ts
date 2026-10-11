import { describe, it, expect } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * PostHog's feature-flags secure key (ADR-0102): an optional ESC secret that
 * lets the BFF evaluate the rollout flags locally.
 *
 * Two things must hold, and neither fails a plan when it breaks. Absent by
 * default, so a stack that never set it neither carries an empty secret nor
 * hands the BFF a blank key. And when set, it reaches the frontend through the
 * shared Secret only, never as a literal on the pod spec, where anything with
 * `get pod` in the namespace would read it.
 */

const SECRETS: Array<Record<string, unknown>> = [];

/** Pulumi's wire marker for a secret value; a map holding one arrives wrapped. */
const SECRET_SIG = "4dabf18193072939515e22adb298388d";
const unwrap = (value: Record<string, unknown>): Record<string, unknown> =>
  SECRET_SIG in value ? (value.value as Record<string, unknown>) : value;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.type === "kubernetes:core/v1:Secret") SECRETS.push(unwrap(args.inputs.stringData ?? {}));
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const KEY = "POSTHOG_FEATURE_FLAGS_SECURE_API_KEY";

async function stack(values: Record<string, string>) {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  const { loadConfig } = await import("../config");
  const { buildSecrets, frontendEnv, bffJobsEnv } = await import("./config");
  const cfg = loadConfig();
  const wiring = {
    cfg,
    namespace: "grid",
    provider: new k8s.Provider("test", { kubeconfig: "apiVersion: v1" }),
    redisUrl: pulumi.output("redis://dragonfly:6379"),
    seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
    seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
    chromaUrl: pulumi.output("http://chroma:8000"),
    dsn: (opts: { db: string }) => pulumi.output(`postgresql://x/${opts.db}`),
    imagePullSecrets: [],
  };
  const before = SECRETS.length;
  const secrets = buildSecrets(wiring as never);
  await new Promise((done) => secrets.secret.id.apply(done));
  return {
    cfg,
    env: frontendEnv(wiring as never),
    bffJobs: bffJobsEnv(wiring as never),
    secretData: SECRETS[before] ?? {},
  };
}

describe("the PostHog feature-flags key", () => {
  it("is absent by default: no config value, no Secret key, no env var", async () => {
    const { cfg, env, secretData } = await stack({});

    expect(cfg.posthog.featureFlagsKey).toBeUndefined();
    // Guards the guard: the Secret's keys were actually read.
    expect(Object.keys(secretData)).toContain("WORKOS_API_KEY");
    expect(Object.keys(secretData)).not.toContain(KEY);
    expect(env.map((e) => e.name)).not.toContain(KEY);
  });

  it("counts an empty value as absent", async () => {
    const { cfg, env } = await stack({ "grid-oib:posthogFeatureFlagsKey": "" });

    expect(cfg.posthog.featureFlagsKey).toBeUndefined();
    expect(env.map((e) => e.name)).not.toContain(KEY);
  });

  it("reaches the frontend from the shared Secret when set, never as a literal", async () => {
    const { env, bffJobs, secretData } = await stack({
      "grid-oib:posthogFeatureFlagsKey": "phs_test_key", // pragma: allowlist secret
    });

    expect(Object.keys(secretData)).toContain(KEY);
    const entry = env.find((e) => e.name === KEY);
    expect(entry?.value).toBeUndefined();
    expect(entry?.valueFrom).toEqual({ secretKeyRef: { name: "grid-secrets", key: KEY } });
    // The background pool runs the same BFF, and its pinned sessions read the
    // same rollouts, so it inherits the reference like the rest of the env.
    expect(bffJobs.find((e) => e.name === KEY)?.valueFrom).toEqual(entry?.valueFrom);
    // And under no public name the browser bundle could read.
    expect(env.map((e) => String(e.name)).filter((name) => name.startsWith("NEXT_PUBLIC_") && name.includes("FLAG"))).toEqual(
      [],
    );
  });
});
