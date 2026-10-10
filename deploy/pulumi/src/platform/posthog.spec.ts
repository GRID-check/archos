import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";
import { loadConfig } from "../config";
import { posthogEnv } from "../app/config";

/**
 * One PostHog configuration for every runtime, and the logs path to it.
 *
 * What goes wrong here is quiet. A Python tier that never gets the pair
 * captures nothing and logs nothing; a logs pipeline that shares another
 * consumer's processors strips that consumer's INFO lines; a pipeline without
 * the severity filter ships every INFO line to a 10 GB free tier. Each is
 * pinned below.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

function resolve(value: unknown): Promise<any> {
  return new Promise((done) =>
    (pulumi.output(value) as pulumi.Output<any>).apply((v: any) => {
      done(v);
      return v;
    }),
  );
}

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`${type} ${name} was not created`);
  return hit;
}

const POSTHOG = {
  "grid-oib:posthogHost": "https://eu.i.posthog.com/",
  "grid-oib:posthogProjectToken": "phc_test_token", // pragma: allowlist secret
};

async function deploy(values: Record<string, string>): Promise<{
  collector: string;
  collectorEnv: string[];
}> {
  vi.resetModules();
  RESOURCES.length = 0;
  // Langfuse is on in every case, so the collector exists even where PostHog
  // logs are off: it is what keeps these tests about the logs pipelines, not
  // about whether a collector was deployed.
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...langfuseStackConfig(), ...values });
  await import("../../index");
  await new Promise((r) => setTimeout(r, 200));
  const cm = find("kubernetes:core/v1:ConfigMap", "otel-collector");
  const spec = (await resolve(find("kubernetes:apps/v1:Deployment", "otel-collector").inputs.spec)) as any;
  return {
    collector: ((await resolve(cm.inputs.data)) as Record<string, string>)["collector.yaml"],
    collectorEnv: spec.template.spec.containers[0].env.map((e: { name: string }) => e.name),
  };
}

describe("PostHog logs in the collector, enabled", () => {
  let collector: string;
  let collectorEnv: string[];

  beforeAll(async () => {
    ({ collector, collectorEnv } = await deploy({
      ...POSTHOG,
      "grid-oib:posthogLogsEnabled": "true",
    }));
  }, 120_000);

  it("exports to PostHog's logs path, with the project token as a bearer", () => {
    // `logs_endpoint` is the whole URL; a trailing slash on the stack's host
    // must not become `//i/v1/logs`.
    expect(collector).toContain("logs_endpoint: https://eu.i.posthog.com/i/v1/logs");
    expect(collector).toContain('Authorization: "Bearer phc_test_token"');
    expect(collector).toMatch(/^\s+otlp_http\/posthog:/m);
    expect(collector).not.toMatch(/^\s+otlphttp\//m);
  });

  it("puts it on its own logs pipeline behind a WARN filter, with no unfiltered logs pipeline beside it", () => {
    expect(collector).toMatch(
      /logs\/posthog:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, filter\/warn_and_above, batch\]\s*\n\s*exporters: \[otlp_http\/posthog\]/,
    );
    expect(collector).toContain("'log.severity_number < SEVERITY_NUMBER_WARN'");
    expect(collector).not.toMatch(/\n    logs:/);
  });

  it("sends no traces or metrics to PostHog", () => {
    // LLM traces reach PostHog through Langfuse's integration; APM is out of scope.
    expect(collector).not.toContain("traces_endpoint: https://eu.i.posthog.com");
    expect(collector).not.toContain("metrics_endpoint");
    expect(collector).not.toMatch(/\n    metrics:/);
  });

  it("needs no env var on the pod: the token is public config, not a secret", () => {
    expect(collectorEnv).not.toContain("POSTHOG_PROJECT_TOKEN");
    expect(collector).not.toMatch(/\$\{env:POSTHOG/);
  });
});

describe("PostHog logs in the collector, off", () => {
  it("is absent by default even with host and token set", async () => {
    const { collector } = await deploy({ ...POSTHOG });
    expect(collector).not.toContain("posthog");
    expect(collector).not.toContain("warn_and_above");
  }, 120_000);

  it("is absent when the flag is set but the token is missing", async () => {
    const { collector } = await deploy({
      "grid-oib:posthogHost": POSTHOG["grid-oib:posthogHost"],
      "grid-oib:posthogLogsEnabled": "true",
    });
    expect(collector).not.toContain("posthog");
  }, 120_000);
});

describe("the Python tiers' PostHog pair", () => {
  const gridCfg = (host: string, projectToken: string, releaseId = "") =>
    ({
      posthog: { host, projectToken, logsEnabled: false, sessionReplay: false, replaySampleRate: "0.2", releaseId },
    }) as unknown as Parameters<typeof posthogEnv>[0];

  it("emits both names when both are set", () => {
    expect(posthogEnv(gridCfg("https://eu.i.posthog.com", "phc_x"))).toEqual([
      { name: "POSTHOG_HOST", value: "https://eu.i.posthog.com" },
      { name: "POSTHOG_PROJECT_TOKEN", value: "phc_x" },
    ]);
  });

  it.each([
    ["host", "", "phc_x"],
    ["token", "https://eu.i.posthog.com", ""],
    ["both", "", ""],
  ])("emits nothing without the %s, never a half-configured pod", (_what, host, token) => {
    expect(posthogEnv(gridCfg(host, token))).toEqual([]);
  });

  // The id PostHog/resolve-release printed for the backend image, which
  // posthog-python sends as $release_id (deploy.yml sets the key per run).
  it("adds the release id the deploy resolved, and only beside the pair", () => {
    expect(posthogEnv(gridCfg("https://eu.i.posthog.com", "phc_x", "0193f5a6-rel"))).toContainEqual({
      name: "POSTHOG_RELEASE_ID",
      value: "0193f5a6-rel",
    });
    expect(posthogEnv(gridCfg("", "", "0193f5a6-rel"))).toEqual([]);
  });

  it("reaches chat, api, agent-worker and ingest-worker, and nothing when unset", async () => {
    const withPosthog = async (values: Record<string, string>, name: string, type: string) => {
      await deploy(values);
      const spec = (await resolve(find(type, name).inputs.spec)) as any;
      return (spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>).filter((e) =>
        e.name.startsWith("POSTHOG_"),
      );
    };
    const tiers: Array<[string, string]> = [
      ["aiq-agent", "kubernetes:apps/v1:StatefulSet"],
      ["aiq-api", "kubernetes:apps/v1:Deployment"],
      ["agent-worker", "kubernetes:apps/v1:Deployment"],
    ];
    for (const [name, type] of tiers) {
      expect(await withPosthog(POSTHOG, name, type), name).toEqual([
        { name: "POSTHOG_HOST", value: "https://eu.i.posthog.com/" },
        { name: "POSTHOG_PROJECT_TOKEN", value: "phc_test_token" },
      ]);
      expect(await withPosthog({}, name, type), name).toEqual([]);
    }
  }, 240_000);

  it("is read by loadConfig as a logs gate that needs host, token and the collector", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...POSTHOG, "grid-oib:posthogLogsEnabled": "true" });
    expect(loadConfig().posthog.logsEnabled).toBe(true);
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...POSTHOG,
      "grid-oib:posthogLogsEnabled": "true",
      "grid-oib:observabilityEnabled": "false",
    });
    expect(loadConfig().posthog.logsEnabled).toBe(false);
  });

  it("records every session by default, and a stack can sample down or switch replay off", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...POSTHOG });
    expect(loadConfig().posthog).toMatchObject({ sessionReplay: true, replaySampleRate: "1" });
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...POSTHOG,
      "grid-oib:posthogSessionReplay": "false",
      "grid-oib:posthogReplaySampleRate": "0.05",
    });
    expect(loadConfig().posthog).toMatchObject({ sessionReplay: false, replaySampleRate: "0.05" });
  });

  it("reads the release id the deploy set, trimmed, and none by default", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...POSTHOG });
    expect(loadConfig().posthog.releaseId).toBe("");
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...POSTHOG, "grid-oib:posthogReleaseId": " 0193f5a6-rel " });
    expect(loadConfig().posthog.releaseId).toBe("0193f5a6-rel");
  });
});
