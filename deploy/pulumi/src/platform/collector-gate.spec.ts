import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";
import { loadConfig } from "../config";

/**
 * The collector and the Aspire dashboard are two gates (ADR-0029).
 *
 * The collector used to be deployed only when the dashboard was, so a stack
 * without the dashboard's OTLP key and its Connect application had no trace
 * export either: Langfuse sat idle behind a collector that did not exist, and
 * nothing said so. The collector now needs a consumer and nothing else.
 *
 * What fails quietly here:
 *   - A collector config that names `otlp_http/aspire` with no dashboard (or an
 *     `${env:OTLP_API_KEY}` with no env var) stops the collector from
 *     starting, taking every consumer's export down with it.
 *   - A stack that had both before must keep exactly what it had: the first
 *     block below pins the pipelines as they were.
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

function has(type: string, name: string): boolean {
  return RESOURCES.some((r) => r.type === type && r.name === name);
}

interface Deployed {
  collector: string;
  collectorEnv: string[];
  collectorChecksum: boolean;
  listeners: string[];
}

async function deploy(values: Record<string, string>): Promise<Deployed> {
  vi.resetModules();
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  await import("../../index");
  await new Promise((r) => setTimeout(r, 200));
  const cm = RESOURCES.find((r) => r.type === "kubernetes:core/v1:ConfigMap" && r.name === "otel-collector");
  if (!cm) throw new Error("the collector was not deployed");
  const deployment = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "otel-collector");
  const spec = (await resolve(deployment?.inputs.spec)) as any;
  const gateway = RESOURCES.find((r) => r.type === "kubernetes:gateway.networking.k8s.io/v1:Gateway");
  const gatewaySpec = (await resolve(gateway?.inputs.spec)) as any;
  return {
    collector: ((await resolve(cm.inputs.data)) as Record<string, string>)["collector.yaml"],
    collectorEnv: spec.template.spec.containers[0].env.map((e: { name: string }) => e.name),
    collectorChecksum: Object.keys(spec.template.metadata.annotations ?? {}).some((k) => /checksum/i.test(k)),
    listeners: gatewaySpec.listeners.map((l: { name: string }) => l.name),
  };
}

/** Everything a stack with the dashboard AND Langfuse sets today. */
function withDashboard(): Record<string, string> {
  return { ...langfuseStackConfig() };
}

/** The same stack without the dashboard's OTLP key: Langfuse and the Connect application stay. */
function withoutDashboard(): Record<string, string> {
  const values = langfuseStackConfig();
  delete values["grid-oib:otelPrimaryApiKey"];
  return values;
}

describe("a stack with the dashboard and Langfuse, as today's stacks are", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deploy(withDashboard());
  }, 120_000);

  it("keeps the collector, Langfuse and the dashboard", () => {
    expect(has("kubernetes:apps/v1:Deployment", "otel-collector")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-web")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "aspire-dashboard")).toBe(true);
    expect(d.listeners).toContain("https-otel");
  });

  it("keeps the pipelines exactly as they were", () => {
    expect(d.collector).toContain(`service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire, otlp_http/langfuse]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]
`);
    expect(d.collector).not.toContain("nop");
    expect(d.collectorEnv).toEqual(["OTLP_API_KEY", "LANGFUSE_OTLP_AUTH"]);
    expect(d.collectorChecksum).toBe(true);
  });
});

describe("a stack with Langfuse and no dashboard key", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deploy(withoutDashboard());
  }, 120_000);

  it("still deploys the collector and Langfuse", () => {
    expect(has("kubernetes:apps/v1:Deployment", "otel-collector")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-web")).toBe(true);
  });

  it("deploys no dashboard, no host for it, and no policy that admits it", () => {
    expect(has("kubernetes:apps/v1:Deployment", "aspire-dashboard")).toBe(false);
    expect(has("kubernetes:gateway.envoyproxy.io/v1alpha1:SecurityPolicy", "grid-otel-security-policy")).toBe(false);
    expect(d.listeners).not.toContain("https-otel");
    const policies = RESOURCES.filter((r) => r.type === "kubernetes:networking.k8s.io/v1:NetworkPolicy").map((r) => r.name);
    expect(policies.some((n) => /aspire/.test(n))).toBe(false);
  });

  it("exports traces to Langfuse alone, with no reference to the dashboard", () => {
    expect(d.collector).not.toMatch(/^\s+otlp_http\/aspire:|exporters: \[.*aspire/m);
    expect(d.collector).not.toContain("OTLP_API_KEY");
    expect(d.collectorEnv).toEqual(["LANGFUSE_OTLP_AUTH"]);
    expect(d.collector).toMatch(/traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[otlp_http\/langfuse\]/);
  });

  it("still takes logs and metrics, into the collector's own nop exporter", () => {
    // A signal with no pipeline is an error on every producer's every export.
    expect(d.collector).toMatch(/exporters:\s*\n\s+nop:/);
    expect(d.collector).toMatch(/logs:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[nop\]/);
    expect(d.collector).toMatch(/metrics:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[nop\]/);
  });

  it("still rolls the collector when the Langfuse key rotates", () => {
    expect(d.collectorChecksum).toBe(true);
  });
});

describe("the gates, as loadConfig resolves them", () => {
  const load = (values: Record<string, string>) => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
    return loadConfig();
  };

  it("needs a consumer for the collector, not a dashboard", () => {
    expect(load({}).observability).toMatchObject({ enabled: false, dashboardEnabled: false });
    expect(load(withoutDashboard()).observability).toMatchObject({ enabled: true, dashboardEnabled: false });
    expect(load(withDashboard()).observability).toMatchObject({ enabled: true, dashboardEnabled: true });
  });

  it("lets PostHog logs bring the collector up on a stack with neither", () => {
    const cfg = load({
      "grid-oib:posthogHost": "https://eu.i.posthog.com",
      "grid-oib:posthogProjectToken": "phc_test_token", // pragma: allowlist secret
      "grid-oib:posthogLogsEnabled": "true",
    });
    expect(cfg.observability).toMatchObject({ enabled: true, dashboardEnabled: false });
  });

  it("deploys the dashboard only with its OTLP key and the Connect application", () => {
    const oidcOnly = withoutDashboard();
    expect(load(oidcOnly).observability.dashboardEnabled).toBe(false);
    expect(load({ ...oidcOnly, "grid-oib:otelPrimaryApiKey": "otel-key" }).observability.dashboardEnabled).toBe(true); // pragma: allowlist secret
    const noOidc = withDashboard();
    delete noOidc["grid-oib:otelOidcClientSecret"];
    expect(load(noOidc).observability.dashboardEnabled).toBe(false);
  });

  it("skips Langfuse, rather than half-deploying it, without the Connect application it signs in against", () => {
    const values = withoutDashboard();
    delete values["grid-oib:otelOidcClientSecret"];
    expect(load(values).langfuse.enabled).toBe(false);
  });

  it("turns everything off with the one flag", () => {
    const cfg = load({ ...withDashboard(), "grid-oib:observabilityEnabled": "false" });
    expect(cfg.observability).toMatchObject({ enabled: false, dashboardEnabled: false });
    expect(cfg.langfuse.enabled).toBe(false);
  });

  it("refuses a dashboard without NetworkPolicies, and Langfuse without them either", () => {
    // Two independent guards now: the dashboard's UI port is unauthenticated,
    // and the trace store holds every tenant's prompts. Neither may lean on the
    // other being deployed.
    expect(() => load({ ...withDashboard(), "grid-oib:networkPolicies": "false" })).toThrow(/requires grid-oib:networkPolicies/);
    expect(() => load({ ...withoutDashboard(), "grid-oib:networkPolicies": "false" })).toThrow(
      /langfuseEnabled requires grid-oib:networkPolicies/,
    );
  });
});
