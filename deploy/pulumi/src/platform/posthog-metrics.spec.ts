import { beforeAll, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { parseCollectorConfig, pipeline } from "../test-support/collector";
import type { CollectorConfig } from "./collector-config";
import { loadConfig } from "../config";

/**
 * Every metric to PostHog Metrics, through the gateway collector.
 *
 * What goes wrong here is quiet. A metrics pipeline missing a source drops that
 * source with no error anywhere; series without the stack's name mix dev into
 * prod in the one project; a gateway that reads the API without an identity
 * gets 403 on every watch, logs it, and reports no workloads.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function resolve<T>(value: unknown): Promise<T> {
  return new Promise((done) => (pulumi.output(value) as pulumi.Output<T>).apply((v) => (done(v), v)));
}

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`${type} ${name} was not created`);
  return hit;
}

const has = (type: string, name: string) => RESOURCES.some((r) => r.type === type && r.name === name);

async function deploy(values: Record<string, string>): Promise<{ collector: CollectorConfig; pod: any }> {
  vi.resetModules();
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:posthogHost": "https://eu.i.posthog.com/",
    "grid-oib:posthogProjectToken": "phc_test_token", // pragma: allowlist secret
    ...values,
  });
  await import("../../index");
  await new Promise((r) => setTimeout(r, 200));
  const data = await resolve<Record<string, string>>(find("kubernetes:core/v1:ConfigMap", "otel-collector").inputs.data);
  const spec = await resolve<any>(find("kubernetes:apps/v1:Deployment", "otel-collector").inputs.spec);
  return { collector: parseCollectorConfig(data["collector.yaml"]), pod: spec.template.spec };
}

describe("PostHog metrics, on by default", () => {
  let collector: CollectorConfig;
  let pod: any;

  beforeAll(async () => {
    ({ collector, pod } = await deploy({}));
  }, 120_000);

  it("exports to PostHog's metrics path with the project token, on an exporter of its own", () => {
    expect(collector.exporters["otlp_http/posthog_metrics"]).toMatchObject({
      metrics_endpoint: "https://eu.i.posthog.com/i/v1/metrics",
      headers: { Authorization: "Bearer phc_test_token" },
      sending_queue: { enabled: true },
    });
  });

  it("carries every source: the tiers' OTLP, the agents' OTLP, workload state and the Qdrant scrape", () => {
    expect(collector.service.pipelines["metrics/posthog"]).toEqual(
      pipeline(["otlp_http/posthog_metrics"], {
        receivers: ["otlp", "k8s_cluster", "prometheus/qdrant"],
        processors: ["resource/environment"],
      }),
    );
    expect(collector.service.pipelines).not.toHaveProperty("metrics");
  });

  it("keeps the Qdrant series on :8889 for the alert rules as well", () => {
    expect(collector.service.pipelines["metrics/qdrant"].exporters).toEqual(["prometheus"]);
  });

  it("names the stack on every series, without overwriting a producer's own", () => {
    expect(collector.processors["resource/environment"]).toEqual({
      attributes: [{ key: "deployment.environment.name", value: "test", action: "insert" }],
    });
  });

  it("reads workload state as a service account bound to read-only rules", async () => {
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.serviceAccountName).toBe("otel-collector");
    const role = await resolve<any>(find("kubernetes:rbac.authorization.k8s.io/v1:ClusterRole", "otel-collector").inputs.rules);
    expect(new Set(role.flatMap((r: { verbs: string[] }) => r.verbs))).toEqual(new Set(["get", "list", "watch"]));
    const resources = role.flatMap((r: { resources: string[] }) => r.resources);
    expect(resources).toEqual(expect.arrayContaining(["pods", "nodes", "deployments", "horizontalpodautoscalers"]));
  });
});

describe("PostHog metrics, switched off", () => {
  it("leaves the gateway with no metrics exporter, no API identity, and OTLP metrics into nop", async () => {
    const { collector, pod } = await deploy({ "grid-oib:posthogMetricsEnabled": "false" });
    expect(collector.exporters).not.toHaveProperty("otlp_http/posthog_metrics");
    expect(collector.receivers).not.toHaveProperty("k8s_cluster");
    expect(collector.service.pipelines.metrics).toEqual(pipeline(["nop"]));
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(has("kubernetes:rbac.authorization.k8s.io/v1:ClusterRole", "otel-collector")).toBe(false);
  }, 120_000);

  it("is read by loadConfig as needing host, token and the collector, like the logs", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig() });
    expect(loadConfig().posthog.metricsEnabled).toBe(true);
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:posthogHost": "" });
    expect(loadConfig().posthog.metricsEnabled).toBe(false);
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    expect(loadConfig().posthog.metricsEnabled).toBe(false);
  });

  it("deploys the collector for metrics alone", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:posthogLogsEnabled": "false" });
    expect(loadConfig().observability.enabled).toBe(true);
  });
});
