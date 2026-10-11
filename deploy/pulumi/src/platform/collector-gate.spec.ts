import { describe, it, expect, beforeAll, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";
import { loadConfig } from "../config";

/**
 * The collector is deployed because something consumes it (ADR-0029).
 *
 * It used to be deployed only with the Aspire dashboard, so a stack without the
 * dashboard's OTLP key had no trace export either: Langfuse sat idle behind a
 * collector that did not exist, and nothing said so. The dashboard is gone now,
 * and the collector needs a consumer and nothing else.
 *
 * What fails quietly here:
 *   - A collector config that names an exporter whose env var nothing injects
 *     stops the collector from starting, taking every consumer's export down.
 *   - A signal with no pipeline is an error on every producer's every export.
 *   - A stack that still carries the dashboard's old keys must neither deploy
 *     it nor break on them.
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

// Pulumi's public special-signature constant, not a credential.
const SECRET_SIGNATURE = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret
/** A `pulumi.secret(...)` reaches a resource mock wrapped; read through it. */
function unsecret<T>(value: unknown): T {
  return (value && typeof value === "object" && SECRET_SIGNATURE in (value as object)
    ? (value as { value: T }).value
    : value) as T;
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

const POSTHOG_LOGS = {
  "grid-oib:posthogHost": "https://eu.i.posthog.com",
  "grid-oib:posthogProjectToken": "phc_test_token", // pragma: allowlist secret
  "grid-oib:posthogLogsEnabled": "true",
};

/** A stack that opted out of PostHog, which is otherwise on (and a log consumer) by default. */
const NO_POSTHOG = { "grid-oib:posthogHost": "" };

/** What a stack that adopted err2issue and the feedback issues still has in its config file. */
const LEFTOVER_ERR2ISSUE_KEYS = {
  "grid-oib:err2issueEnabled": "true",
  "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
  "grid-oib:err2issueGithubToken": "gh-token", // pragma: allowlist secret
  "grid-oib:feedbackIssuesEnabled": "true",
  "grid-oib:feedbackIssuesRepo": "GRID-check/feedback",
};

/** What a stack that adopted the dashboard still has in its config file. */
const LEFTOVER_DASHBOARD_KEYS = {
  "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
  "grid-oib:otelDomain": "otel.example.test",
  "grid-oib:dashboardImage": "mcr.microsoft.com/dotnet/aspire-dashboard@sha256:" + "0".repeat(64),
  "grid-oib:dashboardMaxLogCount": "50000",
};

describe("a stack with Langfuse and PostHog opted out", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deploy({ ...langfuseStackConfig(), ...NO_POSTHOG, ...LEFTOVER_DASHBOARD_KEYS, ...LEFTOVER_ERR2ISSUE_KEYS });
  }, 120_000);

  it("deploys no err2issue and no GitHub credential, whatever the config still says", async () => {
    // err2issue is retired (PostHog error tracking replaces it), and the
    // feedback form's issue filing, which borrowed its token, goes with it.
    expect(has("kubernetes:apps/v1:Deployment", "err2issue")).toBe(false);
    expect(d.collector).not.toContain("err2issue");
    expect(d.collector).not.toContain("errors_only");
    const secret = RESOURCES.find((r) => r.type === "kubernetes:core/v1:Secret" && r.name === "grid-secrets");
    expect(Object.keys(unsecret<Record<string, string>>(await resolve(secret?.inputs.stringData)))).not.toContain("GRID_GITHUB_TOKEN");
    const frontend = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "frontend");
    const env = ((await resolve(frontend?.inputs.spec)) as any).template.spec.containers[0].env.map(
      (e: { name: string }) => e.name,
    );
    expect(env).not.toContain("GRID_GITHUB_TOKEN");
    expect(env).not.toContain("GRID_FEEDBACK_ISSUES_REPO");
  });

  it("deploys the collector and Langfuse, and no dashboard whatever the config still says", () => {
    expect(has("kubernetes:apps/v1:Deployment", "otel-collector")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-web")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "aspire-dashboard")).toBe(false);
    expect(has("kubernetes:gateway.envoyproxy.io/v1alpha1:SecurityPolicy", "grid-otel-security-policy")).toBe(false);
    expect(d.listeners).not.toContain("https-otel");
    const policies = RESOURCES.filter((r) => r.type === "kubernetes:networking.k8s.io/v1:NetworkPolicy").map((r) => r.name);
    expect(policies.some((n) => /aspire/.test(n))).toBe(false);
  });

  it("exports traces to Langfuse alone, with no reference to the dashboard", () => {
    expect(d.collector).not.toMatch(/aspire/i);
    expect(d.collector).not.toContain("OTLP_API_KEY");
    expect(d.collectorEnv).toEqual(["LANGFUSE_OTLP_AUTH"]);
    expect(d.collector).toMatch(/traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[otlp_http\/langfuse\]/);
  });

  it("still takes logs, into the collector's own nop exporter, and carries no metrics pipeline", () => {
    // A signal with no pipeline is an error on every producer's every export.
    // Metrics are not sent at all (nothing consumes them), so no pipeline.
    expect(d.collector).toMatch(/exporters:\s*\n\s+nop:/);
    expect(d.collector).toMatch(/logs:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[nop\]/);
    expect(d.collector).not.toMatch(/\n    metrics:/);
  });

  it("rolls the collector when the Langfuse key rotates", () => {
    expect(d.collectorChecksum).toBe(true);
  });
});

describe("a stack with PostHog logs and no Langfuse", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deploy(POSTHOG_LOGS);
  }, 120_000);

  it("deploys the collector on that alone, with no Langfuse and no credentials to inject", () => {
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-web")).toBe(false);
    expect(d.collectorEnv).toEqual([]);
    expect(d.collector).not.toContain("${env:");
  });

  it("ends the traces signal in nop and ships logs to PostHog only", () => {
    expect(d.collector).toMatch(/traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[nop\]/);
    expect(d.collector).toMatch(/logs\/posthog:/);
    expect(d.collector).not.toMatch(/\n    logs:/);
  });
});

describe("the gate, as loadConfig resolves it", () => {
  const load = (values: Record<string, string>) => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
    return loadConfig();
  };

  it("needs a consumer for the collector, and PostHog logs are one by default", () => {
    expect(load(NO_POSTHOG).observability.enabled).toBe(false);
    expect(load({}).observability.enabled).toBe(true);
    expect(load({ ...langfuseStackConfig(), ...NO_POSTHOG }).observability.enabled).toBe(true);
    expect(load(POSTHOG_LOGS).observability.enabled).toBe(true);
  });

  it("is not brought up by err2issue's old keys alone", () => {
    expect(load({ ...NO_POSTHOG, ...LEFTOVER_ERR2ISSUE_KEYS }).observability.enabled).toBe(false);
  });

  it("is not brought up by the dashboard's old keys alone", () => {
    expect(load({ ...NO_POSTHOG, ...LEFTOVER_DASHBOARD_KEYS }).observability.enabled).toBe(false);
  });

  it("skips Langfuse, rather than half-deploying it, without the Connect application it signs in against", () => {
    const values: Record<string, string> = { ...langfuseStackConfig(), ...NO_POSTHOG };
    delete values["grid-oib:otelOidcClientSecret"];
    const cfg = load(values);
    expect(cfg.langfuse.enabled).toBe(false);
    expect(cfg.observability.enabled).toBe(false);
  });

  it("turns everything off with the one flag", () => {
    const cfg = load({ ...langfuseStackConfig(), ...POSTHOG_LOGS, "grid-oib:observabilityEnabled": "false" });
    expect(cfg.observability.enabled).toBe(false);
    expect(cfg.langfuse.enabled).toBe(false);
    expect(cfg.posthog.logsEnabled).toBe(false);
  });

  it("refuses Langfuse without NetworkPolicies", () => {
    expect(() => load({ ...langfuseStackConfig(), "grid-oib:networkPolicies": "false" })).toThrow(
      /langfuseEnabled requires grid-oib:networkPolicies/,
    );
  });
});
