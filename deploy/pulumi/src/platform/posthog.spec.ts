import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";
import { loadConfig } from '../config'
import { POSTHOG_DEFAULT_HOST, POSTHOG_DEFAULT_PROJECT_TOKEN } from '../config/posthog'
import { posthogEnv } from "../app/config";
import { parseCollectorConfig, pipeline } from "../test-support/collector";

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
    expect(parseCollectorConfig(collector).exporters["otlp_http/posthog"]).toMatchObject({
      headers: { Authorization: "Bearer phc_test_token" },
    });
    expect(collector).toMatch(/^\s+otlp_http\/posthog:/m);
    expect(collector).not.toMatch(/^\s+otlphttp\//m);
  });

  it("puts it on its own logs pipeline behind a WARN filter, with no unfiltered logs pipeline beside it", () => {
    const { processors, service } = parseCollectorConfig(collector);
    expect(service.pipelines["logs/posthog"]).toEqual(
      pipeline(["otlp_http/posthog"], { processors: ["filter/warn_and_above"] }),
    );
    expect(processors["filter/warn_and_above"]).toMatchObject({
      log_conditions: ["log.severity_number < SEVERITY_NUMBER_WARN"],
    });
    expect(service.pipelines).not.toHaveProperty("logs");
  });

  it("sends no traces to PostHog", () => {
    // LLM traces reach PostHog through Langfuse's integration; APM is out of scope.
    expect(collector).not.toContain("traces_endpoint: https://eu.i.posthog.com");
  });

  it("needs no env var on the pod: the token is public config, not a secret", () => {
    expect(collectorEnv).not.toContain("POSTHOG_PROJECT_TOKEN");
    expect(collector).not.toMatch(/\$\{env:POSTHOG/);
  });
});

describe("PostHog logs in the collector, by default and off", () => {
  it("ships WARN+ to Piloti's project when the stack sets nothing", async () => {
    const { collector } = await deploy({});
    expect(collector).toContain(`${POSTHOG_DEFAULT_HOST}/i/v1/logs`);
    expect(collector).toContain(POSTHOG_DEFAULT_PROJECT_TOKEN);
    expect(collector).toContain("warn_and_above");
  }, 120_000);

  it.each([
    ["the stack switches logs off", { "grid-oib:posthogLogsEnabled": "false" }],
    ["the stack opts out of PostHog with an empty host", { "grid-oib:posthogHost": "" }],
    ["the flag is set but the token is empty", { "grid-oib:posthogLogsEnabled": "true", "grid-oib:posthogProjectToken": "" }],
  ])("is absent when %s", async (_why, values) => {
    const { collector } = await deploy(values);
    const { exporters, service } = parseCollectorConfig(collector);
    expect(exporters).not.toHaveProperty("otlp_http/posthog");
    expect(service.pipelines).not.toHaveProperty("logs/posthog");
    expect(collector).not.toContain("warn_and_above");
  }, 120_000);
});

describe("the Python tiers' PostHog pair", () => {
  const appCfg = (host: string, projectToken: string, releaseId = "") =>
    ({
      posthog: { host, projectToken, logsEnabled: false, sessionReplay: false, replaySampleRate: "0.2", releaseId },
    }) as unknown as Parameters<typeof posthogEnv>[0];

  it("emits both names when both are set", () => {
    expect(posthogEnv(appCfg("https://eu.i.posthog.com", "phc_x"))).toEqual([
      { name: "POSTHOG_HOST", value: "https://eu.i.posthog.com" },
      { name: "POSTHOG_PROJECT_TOKEN", value: "phc_x" },
    ]);
  });

  it.each([
    ["host", "", "phc_x"],
    ["token", "https://eu.i.posthog.com", ""],
    ["both", "", ""],
  ])("emits nothing without the %s, never a half-configured pod", (_what, host, token) => {
    expect(posthogEnv(appCfg(host, token))).toEqual([]);
  });

  // The id PostHog/resolve-release printed for the backend image, which
  // posthog-python sends as $release_id (deploy.yml sets the key per run).
  it("adds the release id the deploy resolved, and only beside the pair", () => {
    expect(posthogEnv(appCfg("https://eu.i.posthog.com", "phc_x", "0193f5a6-rel"))).toContainEqual({
      name: "POSTHOG_RELEASE_ID",
      value: "0193f5a6-rel",
    });
    expect(posthogEnv(appCfg("", "", "0193f5a6-rel"))).toEqual([]);
  });

  it("reaches chat, api and agent-worker, Piloti's project by default, and nothing once opted out", async () => {
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
      ["chat", "kubernetes:apps/v1:StatefulSet"],
      ["api", "kubernetes:apps/v1:Deployment"],
      ["agent-worker", "kubernetes:apps/v1:Deployment"],
    ];
    for (const [name, type] of tiers) {
      expect(await withPosthog(POSTHOG, name, type), name).toEqual([
        { name: "POSTHOG_HOST", value: "https://eu.i.posthog.com/" },
        { name: "POSTHOG_PROJECT_TOKEN", value: "phc_test_token" },
      ]);
      expect(await withPosthog({}, name, type), name).toEqual([
        { name: "POSTHOG_HOST", value: POSTHOG_DEFAULT_HOST },
        { name: "POSTHOG_PROJECT_TOKEN", value: POSTHOG_DEFAULT_PROJECT_TOKEN },
      ]);
      expect(await withPosthog({ "grid-oib:posthogHost": "" }, name, type), name).toEqual([]);
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
